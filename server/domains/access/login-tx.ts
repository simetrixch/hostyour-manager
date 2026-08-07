import { EncryptJWT, jwtDecrypt } from "jose";
import type { Db } from "../../db/client.ts";
import type { Config } from "../../kernel/config.ts";
import { loadOrCreateKey } from "./session.ts";

export const LOGIN_TX_COOKIE = "__Host-oidc-tx";

/** Plain name over http (dev/e2e), hardened __Host- name over https — see sessionCookieName. */
export function loginTxCookieName(config: Config): string {
  return config.cookieSecure ? LOGIN_TX_COOKIE : "oidc-tx";
}
const ALG = "dir";
const ENC = "A256GCM";
const TTL_SECONDS = 600; // a login must complete within 10 minutes

export interface LoginTx {
  v: string; // PKCE code_verifier
  s: string; // state
  rt: string; // validated returnTo path
}

/**
 * The short-lived, sealed login transaction. Carries the PKCE verifier + state
 * + returnTo across the IdP round-trip in a cookie, so no server-side session store is needed
 * and a restart mid-login just costs one retry. Separate key from the session; no bootEpoch/
 * idle (this is pre-login state, not an authenticated session).
 */
export class LoginTxCodec {
  private readonly key: Uint8Array;

  constructor(db: Db) {
    this.key = loadOrCreateKey(db, "login.key");
  }

  async seal(tx: LoginTx): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return new EncryptJWT({ v: tx.v, s: tx.s, rt: tx.rt })
      .setProtectedHeader({ alg: ALG, enc: ENC })
      .setIssuedAt(now)
      .setExpirationTime(now + TTL_SECONDS)
      .encrypt(this.key);
  }

  async open(cookie: string | undefined): Promise<LoginTx | null> {
    if (!cookie) return null;
    try {
      const { payload } = await jwtDecrypt(cookie, this.key, { keyManagementAlgorithms: [ALG], contentEncryptionAlgorithms: [ENC] });
      const { v, s, rt } = payload;
      if (typeof v !== "string" || typeof s !== "string" || typeof rt !== "string") return null;
      return { v, s, rt };
    } catch {
      return null; // expired or tampered — treat as no transaction
    }
  }
}
