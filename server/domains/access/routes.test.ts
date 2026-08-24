import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { createApp } from "../../http/app.ts";
import { parseConfig } from "../../kernel/config.ts";
import { createLogger } from "../../kernel/logger.ts";
import { openDb, type DbHandle } from "../../db/client.ts";
import { SessionCodec, SESSION_COOKIE } from "./session.ts";
import type { AppEnv } from "../../http/app-env.ts";
import { LoginTxCodec, LOGIN_TX_COOKIE } from "./login-tx.ts";
import { registerAuthRoutes, validateReturnTo } from "./routes.ts";
import { createOidcAdapter } from "../../adapters/oidc/authentik.ts";
import { startMockIdp, type MockIdp } from "../../adapters/oidc/testing/mock-idp.ts";

function setCookieValue(res: Response, name: string): string | undefined {
  const hit = res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1).split(";")[0] : undefined;
}

describe("OIDC login flow + chokepoint end-to-end", () => {
  const handles: DbHandle[] = [];
  const dirs: string[] = [];
  let idp: MockIdp | undefined;
  afterEach(async () => {
    await idp?.close();
    idp = undefined;
    for (const h of handles.splice(0)) h.sqlite.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function make(mock: MockIdp): { app: Hono<AppEnv>; db: DbHandle } {
    const dir = mkdtempSync(join(tmpdir(), "ctrl-auth-"));
    dirs.push(dir);
    const db = openDb(join(dir, "controller.db"));
    handles.push(db);
    const config = parseConfig({
      PUBLIC_URL: "https://m1.example",
      OIDC_ISSUER: mock.issuer,
      OIDC_CLIENT_ID: mock.clientId,
      OIDC_CLIENT_SECRET: mock.clientSecret,
      MANAGER_VERSION: "test",
      DATA_DIR: dir,
      LOG_LEVEL: "silent",
    } as NodeJS.ProcessEnv);
    const logger = createLogger(config);
    const session = new SessionCodec(db.db, config);
    const loginTx = new LoginTxCodec(db.db);
    const oidc = createOidcAdapter(config, logger);
    const app = createApp({
      config,
      logger,
      getReadiness: () => ({ ok: true, checks: [] }),
      session,
      registerAuth: (a) => registerAuthRoutes(a, { config, oidc, session, loginTx, db: db.db, logger }),
      registerProtected: (a) => a.get("/protected", (c) => c.json({ ok: true, sub: c.get("operator").sub })),
    });
    return { app, db };
  }

  async function login(app: Hono<AppEnv>, mock: MockIdp): Promise<string> {
    const start = await app.request("/auth/login");
    expect(start.status).toBe(302);
    const authUrl = new URL(start.headers.get("location") ?? "");
    const state = authUrl.searchParams.get("state") ?? "";
    const tx = setCookieValue(start, LOGIN_TX_COOKIE) ?? "";
    const code = mock.mintCode("https://m1.example/auth/callback");
    const cb = await app.request(`/auth/callback?code=${code}&state=${state}`, { headers: { cookie: `${LOGIN_TX_COOKIE}=${tx}` } });
    expect(cb.status).toBe(302);
    expect(cb.headers.get("location")).toBe("/");
    return setCookieValue(cb, SESSION_COOKIE) ?? "";
  }

  it("member login → session set, operator persisted, /protected reachable (200)", async () => {
    idp = await startMockIdp({ email: "alice@example.com", groups: ["admins"] });
    const { app, db } = make(idp);
    const sess = await login(app, idp);
    expect(sess).toBeTruthy();
    const op = db.sqlite.prepare("SELECT email FROM operators WHERE subject=?").get("idp-user-abc") as { email: string } | undefined;
    expect(op?.email).toBe("alice@example.com");
    const prot = await app.request("/protected", { headers: { cookie: `${SESSION_COOKIE}=${sess}` } });
    expect(prot.status).toBe(200);
  });

  it("non-member login → session IS minted, but /protected → 403 document, NOT a redirect (loop regression)", async () => {
    idp = await startMockIdp({ email: "bob@example.com", groups: ["users"] });
    const { app } = make(idp);
    const sess = await login(app, idp);
    expect(sess).toBeTruthy(); // the login mints; the chokepoint decides
    const prot = await app.request("/protected", { headers: { cookie: `${SESSION_COOKIE}=${sess}`, accept: "text/html" } });
    expect(prot.status).toBe(403); // NOT 302 — the anti-loop invariant
    expect(await prot.text()).toContain("Access denied");
  });

  it("unauthenticated: html GET → 302 to login, api GET → 401", async () => {
    idp = await startMockIdp();
    const { app } = make(idp);
    const html = await app.request("/protected", { headers: { accept: "text/html" } });
    expect(html.status).toBe(302);
    expect(html.headers.get("location")).toContain("/auth/login?next=");
    const api = await app.request("/api/runs", { headers: { accept: "application/json" } });
    expect(api.status).toBe(401);
  });

  it("logout clears the cookie and revokes the jti (the old cookie no longer authenticates)", async () => {
    idp = await startMockIdp({ groups: ["admins"] });
    const { app } = make(idp);
    const sess = await login(app, idp);
    const out = await app.request("/auth/logout", { headers: { cookie: `${SESSION_COOKIE}=${sess}` } });
    expect(out.status).toBe(302);
    expect(setCookieValue(out, SESSION_COOKIE)).toBe(""); // cleared
    const reuse = await app.request("/protected", { headers: { cookie: `${SESSION_COOKIE}=${sess}`, accept: "application/json" } });
    expect(reuse.status).toBe(401); // jti revoked → invalid → gated
  });

  it("validateReturnTo rejects cross-origin and protocol-relative targets", async () => {
    const cfg = parseConfig({
      PUBLIC_URL: "https://m1.example",
      OIDC_ISSUER: "https://i.example/",
      OIDC_CLIENT_ID: "c",
      OIDC_CLIENT_SECRET: "s",
      MANAGER_VERSION: "test",
      DATA_DIR: "/d",
      LOG_LEVEL: "silent",
    } as NodeJS.ProcessEnv);
    expect(validateReturnTo("/runs/abc", cfg)).toBe("/runs/abc");
    expect(validateReturnTo("https://evil.example/x", cfg)).toBe("/");
    expect(validateReturnTo("//evil.example", cfg)).toBe("/");
    expect(validateReturnTo(undefined, cfg)).toBe("/");
  });
});
