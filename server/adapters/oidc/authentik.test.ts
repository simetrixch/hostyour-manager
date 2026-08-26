import { describe, it, expect, afterEach } from "vitest";
import * as oidc from "openid-client";
import { parseConfig, type Config } from "../../kernel/config.ts";
import { createLogger } from "../../kernel/logger.ts";
import { createOidcAdapter } from "./authentik.ts";
import { startMockIdp, type MockIdp } from "./testing/mock-idp.ts";
import type { OidcPort } from "./port.ts";

describe("OIDC adapter against a real in-process mock IdP", () => {
  let idp: MockIdp | undefined;
  afterEach(async () => {
    await idp?.close();
    idp = undefined;
  });

  function adapterFor(mock: MockIdp, groups: string[]): { adapter: OidcPort; config: Config } {
    mock.setGroups(groups);
    const config = parseConfig({
      PUBLIC_URL: "https://m1.example",
      OIDC_ISSUER: mock.issuer,
      OIDC_CLIENT_ID: mock.clientId,
      OIDC_CLIENT_SECRET: mock.clientSecret,
      MANAGER_VERSION: "test",
      DATA_DIR: "/d",
      ADMIN_SOCKET_PATH: "/run/manager/admin.sock",
      LOG_LEVEL: "silent",
    } as NodeJS.ProcessEnv);
    return { adapter: createOidcAdapter(config, createLogger(config)), config };
  }

  async function pkce(): Promise<{ verifier: string; challenge: string; state: string }> {
    const verifier = oidc.randomPKCECodeVerifier();
    return { verifier, challenge: await oidc.calculatePKCECodeChallenge(verifier), state: oidc.randomState() };
  }

  it("discovers, builds a PKCE auth URL, and exchanges a code into an identity with groups", async () => {
    idp = await startMockIdp({ email: "alice@example.com" });
    const { adapter, config } = adapterFor(idp, ["admins", "users"]);
    const { verifier, challenge, state } = await pkce();

    const authUrl = await adapter.authUrl({ state, redirectUri: config.redirectUri, codeChallenge: challenge });
    expect(authUrl).toContain(idp.issuer);
    expect(authUrl).toContain("code_challenge=");
    expect(authUrl).toContain(`state=${state}`);
    expect(authUrl).toContain(encodeURIComponent(config.redirectUri));
    // MUST request the `groups` scope: real Authentik only emits a claim for the
    // scopes the client asks for, so without it the id_token carries no groups and
    // the staff gate denies everyone. (The mock emits groups unconditionally, so this
    // assertion — not the exchange below — is what guards the regression.)
    expect((new URL(authUrl).searchParams.get("scope") ?? "").split(" ")).toContain("groups");

    const code = idp.mintCode(config.redirectUri);
    const identity = await adapter.exchange({ code, state, redirectUri: config.redirectUri, codeVerifier: verifier, expectedState: state });
    expect(identity.subject).toBe("idp-user-abc");
    expect(identity.email).toBe("alice@example.com");
    expect(identity.groups).toEqual(["admins", "users"]);
  });

  it("returns empty groups for a non-member (the chokepoint, not the adapter, decides access)", async () => {
    idp = await startMockIdp();
    const { adapter, config } = adapterFor(idp, []);
    const { verifier, state } = await pkce();
    const code = idp.mintCode(config.redirectUri);
    const identity = await adapter.exchange({ code, state, redirectUri: config.redirectUri, codeVerifier: verifier, expectedState: state });
    expect(identity.groups).toEqual([]);
  });

  it("rejects a state mismatch (CSRF on the callback)", async () => {
    idp = await startMockIdp();
    const { adapter, config } = adapterFor(idp, ["admins"]);
    const { verifier, state } = await pkce();
    const code = idp.mintCode(config.redirectUri);
    await expect(
      adapter.exchange({ code, state, redirectUri: config.redirectUri, codeVerifier: verifier, expectedState: "WRONG" }),
    ).rejects.toThrow();
  });

  it("builds an RP-initiated end-session URL from discovery", async () => {
    idp = await startMockIdp();
    const { adapter } = adapterFor(idp, ["admins"]);
    const url = await adapter.endSessionUrl({ postLogoutRedirectUri: "https://m1.example/" });
    expect(url).toBeDefined();
    expect(url).toContain(`${idp.issuer}/logout`);
  });

  it("surfaces an unreachable IdP as IDP_UNREACHABLE", async () => {
    const config = parseConfig({
      PUBLIC_URL: "https://m1.example",
      OIDC_ISSUER: "http://127.0.0.1:1/", // nothing listening
      OIDC_CLIENT_ID: "c",
      OIDC_CLIENT_SECRET: "s",
      MANAGER_VERSION: "test",
      DATA_DIR: "/d",
      ADMIN_SOCKET_PATH: "/run/manager/admin.sock",
      LOG_LEVEL: "silent",
    } as NodeJS.ProcessEnv);
    const adapter = createOidcAdapter(config, createLogger(config));
    await expect(adapter.authUrl({ state: "s", redirectUri: config.redirectUri, codeChallenge: "x" })).rejects.toMatchObject({
      code: "IDP_UNREACHABLE",
    });
  });
});
