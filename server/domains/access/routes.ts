import type { Hono } from "hono";
import { randomBytes, createHash } from "node:crypto";
import { setCookie, getCookie, deleteCookie } from "hono/cookie";
import type { Config } from "../../kernel/config.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { Db } from "../../db/client.ts";
import type { OidcPort } from "../../adapters/oidc/port.ts";
import { writeAudit } from "../../db/audit-writer.ts";
import type { ApiError } from "../../../shared/api-types.ts";
import { SessionCodec, sessionCookieName } from "./session.ts";
import type { AppEnv } from "../../http/app-env.ts";
import { LoginTxCodec, loginTxCookieName } from "./login-tx.ts";
import { revokeJti } from "./revocation.ts";
import { upsertOperator } from "./identity.ts";

const b64url = (b: Buffer): string => b.toString("base64url");

export interface AuthRoutesDeps {
  config: Config;
  oidc: OidcPort;
  session: SessionCodec;
  loginTx: LoginTxCodec;
  db: Db;
  logger: Logger;
}

/** Same-origin, path-only returnTo. Rejects absolute URLs, cross-origin, and protocol-relative
 *  (`//evil`) — an open-redirect guard on the login hop. */
export function validateReturnTo(next: string | undefined, config: Config): string {
  if (!next || !next.startsWith("/") || next.startsWith("//")) return "/";
  try {
    const u = new URL(next, config.origin);
    if (u.origin !== config.origin) return "/";
    return u.pathname + u.search;
  } catch {
    return "/";
  }
}

/**
 * The public /auth/* routes. Registered BEFORE the chokepoint so they stay
 * reachable while signed out. The session is minted for EVERY authenticated identity — member
 * or not — because access is the chokepoint's decision, never the login's. redirect_uri
 * is always config.redirectUri, never a request URL.
 */
export function registerAuthRoutes(app: Hono<AppEnv>, deps: AuthRoutesDeps): void {
  const { config, oidc, session, loginTx, db } = deps;
  const cookieOpts = { httpOnly: true, secure: config.cookieSecure, sameSite: "Lax", path: "/" } as const;
  // __Host- cookies require Secure + Path=/ even on deletion (Hono enforces the prefix rules).
  const deleteOpts = { path: "/", secure: config.cookieSecure } as const;
  const sessionCookie = sessionCookieName(config);
  const txCookie = loginTxCookieName(config);

  app.get("/auth/login", async (c) => {
    const returnTo = validateReturnTo(c.req.query("next"), config);
    const verifier = b64url(randomBytes(32));
    const challenge = b64url(createHash("sha256").update(verifier).digest());
    const state = b64url(randomBytes(16));
    const url = await oidc.authUrl({ state, redirectUri: config.redirectUri, codeChallenge: challenge }); // errIdpUnreachable → 503
    setCookie(c, txCookie, await loginTx.seal({ v: verifier, s: state, rt: returnTo }), { ...cookieOpts, maxAge: 600 });
    return c.redirect(url, 302);
  });

  app.get("/auth/callback", async (c) => {
    const tx = await loginTx.open(getCookie(c, txCookie));
    if (!tx) return c.json({ code: "VALIDATION", message: "Login expired — please start again" } satisfies ApiError, 400);
    const idpError = c.req.query("error");
    if (idpError) return c.json({ code: "VALIDATION", message: `IdP error: ${idpError}` } satisfies ApiError, 400);

    const identity = await oidc.exchange({
      code: c.req.query("code") ?? "",
      state: c.req.query("state") ?? "",
      redirectUri: config.redirectUri,
      codeVerifier: tx.v,
      expectedState: tx.s,
    });
    const operatorId = upsertOperator(db, { subject: identity.subject, ...(identity.email ? { email: identity.email } : {}) });
    const token = await session.mint({ sub: operatorId, groups: identity.groups, via: "oidc", ...(identity.email ? { email: identity.email } : {}) });
    deleteCookie(c, txCookie, deleteOpts);
    setCookie(c, sessionCookie, token, cookieOpts);
    writeAudit(db, { actor: operatorId, action: "session.started", detail: { member: identity.groups.includes(config.oidc.adminsGroup) } });
    return c.redirect(tx.rt, 302);
  });

  app.on(["GET", "POST"], "/auth/logout", async (c) => {
    const verdict = await session.verify(getCookie(c, sessionCookie) ?? "");
    if (verdict.kind === "ok") {
      revokeJti(verdict.session.jti);
      writeAudit(db, { actor: verdict.session.sub, action: "session.ended" });
    }
    deleteCookie(c, sessionCookie, deleteOpts);
    let end: string | undefined;
    try {
      end = await oidc.endSessionUrl({ postLogoutRedirectUri: config.publicUrl });
    } catch {
      end = undefined; // logout must never fail on an unreachable IdP
    }
    return c.redirect(end ?? "/", 302);
  });
}
