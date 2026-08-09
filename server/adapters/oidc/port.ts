// The OIDC boundary. Only this folder imports openid-client (dep-cruiser
// adapters-own-io-libs). The port speaks identities, not tokens — the domain never sees an
// access token or an openid-client Configuration.
export interface OidcIdentity {
  subject: string; // the raw IdP subject (stable per user); mapped to a local operator by identity.ts
  email?: string;
  groups: string[];
}

export interface OidcPort {
  /** Authorization redirect URL (PKCE S256). redirectUri is passed in — always config.redirectUri. */
  authUrl(opts: { state: string; redirectUri: string; codeChallenge: string }): Promise<string>;
  /** Exchange the callback code for an identity. redirectUri MUST equal the value used at authUrl. */
  exchange(opts: {
    code: string;
    state: string;
    redirectUri: string;
    codeVerifier: string;
    expectedState: string;
  }): Promise<OidcIdentity>;
  /** RP-initiated logout URL, or undefined if the IdP advertises no end_session_endpoint. */
  endSessionUrl(opts: { idTokenHint?: string; postLogoutRedirectUri: string }): Promise<string | undefined>;
}
