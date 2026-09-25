import { randomBytes } from "node:crypto";
import { EncryptJWT, jwtDecrypt } from "jose";
import { eq } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { meta } from "../../db/schema/meta.ts";
import type { Config } from "../../kernel/config.ts";
import { bootEpochMs, isRevoked } from "./revocation.ts";

export const SESSION_COOKIE = "__Host-manager";

/** The __Host- prefix hardens the prod (https) cookie but REQUIRES Secure — impossible over
 *  plain http. So dev/e2e over http://localhost falls back to a plain name; https keeps the
 *  hardened one. The prefix is a transport-hardening detail, not a security invariant.
 *
 *  The NAME is what the browser keys the session by: a browser holding a cookie under a different
 *  name does not send it, and the operator is signed out and signs in again. Nothing server-side
 *  keys off it — the session lives in the cookie's own encrypted value. */
export function sessionCookieName(config: Config): string {
  return config.cookieSecure ? SESSION_COOKIE : "manager-session";
}

const ALG = "dir";
const ENC = "A256GCM";

export interface OperatorSession {
  sub: string; // local operator id (opId), NOT the raw IdP subject
  email?: string;
  groups: string[];
  jti: string;
  /** WHICH AUTHORITY this session rests on, not who is holding it: "oidc" means an IdP verified an
   *  identity, "emergency" means nothing did and the only thing proved was write permission on the
   *  admin.sock. A program that takes a session off that socket proved exactly that and no
   *  more, so "emergency" is its word too — which door a caller came through is recorded where it
   *  belongs, in the audit row (domains/access/emergency.ts), and not by a third value here. */
  via: "oidc" | "emergency";
  /** When this session was FIRST minted (epoch seconds) — the fixed anchor of the absolute
   *  lifetime. refresh() carries it unchanged, so sliding the idle window never extends exp. */
  authAt: number;
}

export type SessionVerdict = { kind: "ok"; session: OperatorSession } | { kind: "invalid" };

// Session key: 32 random bytes in meta.session.key, stored unencrypted — it does not ride the
// credential envelope. Anyone who can read the master's filesystem can therefore forge a session
// offline: a named residual, not an oversight.
export function loadOrCreateKey(db: Db, metaKey: string): Uint8Array {
  const existing = db.select().from(meta).where(eq(meta.key, metaKey)).get();
  if (existing) return Buffer.from(existing.value, "base64");
  const key = randomBytes(32);
  db.insert(meta).values({ key: metaKey, value: key.toString("base64") }).onConflictDoNothing().run();
  const now = db.select().from(meta).where(eq(meta.key, metaKey)).get();
  return now ? Buffer.from(now.value, "base64") : key;
}

/**
 * Sealed JWE session cookie. `dir` + `A256GCM`
 * with the algorithms allowlisted on decrypt; jti + in-memory revocation + bootEpoch
 * fail-close; idle + absolute lifetime enforced.
 *
 * The two lifetimes are carried by two different claims. `iat` is the LAST-ACTIVITY moment:
 * the chokepoint re-mints the cookie on every authenticated request (refresh), so the idle
 * check `now - iat > idleSeconds` measures time since the operator's last request, not since
 * login. `aa` is the FIRST-mint moment and never changes across refreshes; `exp` is always
 * `aa + absoluteSeconds`, so jose's exp check is the absolute cap and no amount of activity
 * slides past it.
 */
export class SessionCodec {
  private readonly key: Uint8Array;

  constructor(
    db: Db,
    private readonly config: Config,
  ) {
    this.key = loadOrCreateKey(db, "session.key");
  }

  /** Seal one cookie: iat = this moment (the idle anchor), exp = authAt + absolute (the fixed cap). */
  private seal(session: OperatorSession): Promise<string> {
    return new EncryptJWT({
      groups: session.groups,
      via: session.via,
      be: bootEpochMs(),
      aa: session.authAt,
      ...(session.email ? { email: session.email } : {}),
    })
      .setProtectedHeader({ alg: ALG, enc: ENC })
      .setSubject(session.sub)
      .setJti(session.jti)
      .setIssuedAt(Math.floor(Date.now() / 1000))
      .setExpirationTime(session.authAt + this.config.session.absoluteSeconds)
      .encrypt(this.key);
  }

  async mint(claims: { sub: string; email?: string; groups: string[]; via: "oidc" | "emergency" }): Promise<string> {
    return this.seal({
      sub: claims.sub,
      groups: claims.groups,
      via: claims.via,
      jti: randomBytes(16).toString("hex"),
      authAt: Math.floor(Date.now() / 1000),
      ...(claims.email ? { email: claims.email } : {}),
    });
  }

  /** Re-seal a VERIFIED session with iat = now — the idle window restarts, everything else
   *  (jti, authAt and therefore exp) is carried unchanged. Called by the chokepoint on every
   *  authenticated request; revocation still works because the jti never changes. */
  async refresh(session: OperatorSession): Promise<string> {
    return this.seal(session);
  }

  async verify(cookie: string): Promise<SessionVerdict> {
    try {
      const { payload } = await jwtDecrypt(cookie, this.key, {
        keyManagementAlgorithms: [ALG],
        contentEncryptionAlgorithms: [ENC],
      });
      // jose already enforced exp (= authAt + absolute). Now: bootEpoch, idle, revocation.
      if (payload.be !== bootEpochMs()) return { kind: "invalid" };
      const iat = typeof payload.iat === "number" ? payload.iat : 0;
      if (Date.now() / 1000 - iat > this.config.session.idleSeconds) return { kind: "invalid" };
      const jti = payload.jti;
      const sub = payload.sub;
      if (typeof jti !== "string" || typeof sub !== "string" || isRevoked(jti)) return { kind: "invalid" };
      if (typeof payload.aa !== "number") return { kind: "invalid" }; // no absolute anchor — refresh could not cap it
      const groups = Array.isArray(payload.groups) ? payload.groups.filter((g): g is string => typeof g === "string") : [];
      const email = typeof payload.email === "string" ? payload.email : undefined;
      // "oidc" is the PRIVILEGED word — reset/api.ts refuses "emergency" and admits everything else
      // — so the narrowing names it explicitly and lets every other value fall to "emergency".
      // mint() always writes one of the two, so no honest session reaches the else; what does is a
      // word this decoder does not know, and reading that back as "oidc" would hand an unrecognised
      // session the IdP-verified side of every check. That is the cost of widening this vocabulary,
      // and this is the direction that fails closed.
      const via = payload.via === "oidc" ? "oidc" : "emergency";
      return { kind: "ok", session: { sub, jti, groups, via, authAt: payload.aa, ...(email ? { email } : {}) } };
    } catch {
      return { kind: "invalid" }; // expired, tampered, wrong key — all invalid
    }
  }
}
