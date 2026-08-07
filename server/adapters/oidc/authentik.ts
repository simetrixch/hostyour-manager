import * as oidc from "openid-client";
import type { Config } from "../../kernel/config.ts";
import type { Logger } from "../../kernel/logger.ts";
import { errIdpUnreachable, errValidation } from "../../kernel/errors.ts";
import type { OidcPort, OidcIdentity } from "./port.ts";

const GROUPS_CLAIM = "groups"; // Authentik emits group memberships under `groups`.

/**
 * OIDC via openid-client v6. Discovery is lazy + memoized with exponential
 * backoff so a down IdP degrades to a 503 rather than blocking boot (LAW 0). redirect_uri is
 * always supplied by the caller (config.redirectUri) — never derived from a request URL.
 * http issuers (dev/mock) opt into allowInsecureRequests; https stays strict.
 */
export function createOidcAdapter(config: Config, logger: Logger): OidcPort {
  const issuer = new URL(config.oidc.issuer);
  const insecure = issuer.protocol === "http:";
  let configPromise: Promise<oidc.Configuration> | undefined;
  let backoffMs = 0;
  let nextAttemptAt = 0;

  async function discover(): Promise<oidc.Configuration> {
    if (configPromise) return configPromise;
    if (backoffMs > 0 && Date.now() < nextAttemptAt) throw errIdpUnreachable();
    const p = oidc
      .discovery(issuer, config.oidc.clientId, config.oidc.clientSecret, undefined, insecure ? { execute: [oidc.allowInsecureRequests] } : {})
      .then((c) => {
        if (insecure) oidc.allowInsecureRequests(c);
        backoffMs = 0;
        return c;
      });
    configPromise = p;
    try {
      return await p;
    } catch (err) {
      configPromise = undefined; // allow a retry after the backoff window
      backoffMs = backoffMs === 0 ? 1000 : Math.min(backoffMs * 2, 30_000);
      nextAttemptAt = Date.now() + backoffMs;
      logger.warn({ err: String(err) }, "oidc discovery failed");
      throw errIdpUnreachable();
    }
  }

  return {
    async authUrl(opts) {
      const c = await discover();
      return oidc
        .buildAuthorizationUrl(c, {
          redirect_uri: opts.redirectUri,
          // MUST request `groups` — Authentik only emits a claim for the scopes the
          // client asks for, so without it the id_token carries no `groups` claim and
          // the staff gate (chokepoint.ts, ADMINS_GROUP) denies EVERYONE. The mock IdP
          // emits groups unconditionally, which is why tests didn't catch this.
          scope: "openid email profile groups",
          state: opts.state,
          code_challenge: opts.codeChallenge,
          code_challenge_method: "S256",
        })
        .href;
    },

    async exchange(opts) {
      const c = await discover();
      const currentUrl = new URL(opts.redirectUri);
      currentUrl.searchParams.set("code", opts.code);
      currentUrl.searchParams.set("state", opts.state);
      let claims;
      try {
        const tokens = await oidc.authorizationCodeGrant(c, currentUrl, {
          pkceCodeVerifier: opts.codeVerifier,
          expectedState: opts.expectedState,
        });
        claims = tokens.claims();
      } catch (err) {
        logger.warn({ err: String(err) }, "oidc code exchange failed");
        throw errValidation("OIDC authorization code exchange failed");
      }
      if (!claims || typeof claims.sub !== "string") throw errValidation("OIDC id_token missing subject");
      const rawGroups = claims[GROUPS_CLAIM];
      const groups = Array.isArray(rawGroups) ? rawGroups.filter((g): g is string => typeof g === "string") : [];
      const email = typeof claims["email"] === "string" ? (claims["email"] as string) : undefined;
      return { subject: claims.sub, groups, ...(email ? { email } : {}) } satisfies OidcIdentity;
    },

    async endSessionUrl(opts) {
      const c = await discover();
      try {
        return oidc
          .buildEndSessionUrl(c, {
            post_logout_redirect_uri: opts.postLogoutRedirectUri,
            ...(opts.idTokenHint ? { id_token_hint: opts.idTokenHint } : {}),
          })
          .href;
      } catch {
        return undefined; // IdP advertises no end_session_endpoint
      }
    },
  };
}
