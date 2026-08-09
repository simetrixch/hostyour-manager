import { describe, it, expect } from "vitest";
import { createPublicKey, createSign, createVerify } from "node:crypto";
import { mintTenantCrypto, TENANT_CRYPTO_PROPERTIES } from "./tenant-crypto-mint.ts";

// The five values that ARE a tenant's identity. What matters here is not that the function returns
// something, it is that each value is USABLE by the reader it was minted for — a JWT signer, a JWKS
// verifier, an AES key, a bearer — because every one of them is written to Vault and then never read
// again by anything that could check it. A corrupt value surfaces at the tenant's first login.

describe("mintTenantCrypto", () => {
  it("mints exactly the properties every member's ExternalSecret asks for, and no others", () => {
    // A property missing here is a Secret key ESO cannot resolve, which stops the member's pods at
    // boot; an EXTRA one is a value written into a tenant's entry that nothing reads.
    expect(Object.keys(mintTenantCrypto()).sort()).toEqual([...TENANT_CRYPTO_PROPERTIES].sort());
  });

  it("the keypair actually signs and verifies — the property the tenant's whole login rests on", () => {
    // example-auth signs with the private half and every member verifies against the JWKS derived from
    // the public half. A pair that does not round-trip is a tenant whose every token is rejected.
    const c = mintTenantCrypto();
    const payload = Buffer.from("a tenant session token");
    const sig = createSign("RSA-SHA256").update(payload).sign(c["auth-jwt-private-key"]);
    expect(createVerify("RSA-SHA256").update(payload).verify(c["auth-jwt-public-key"], sig)).toBe(true);
  });

  it("the public half is the private half's own — not merely a valid key", () => {
    // The self-verification inside generateRsaKeypair, asserted from the outside: two unrelated valid
    // keys would pass "is a PEM" and fail every signature.
    const c = mintTenantCrypto();
    const derived = createPublicKey(c["auth-jwt-private-key"]).export({ type: "spki", format: "pem" }).toString();
    expect(derived).toBe(c["auth-jwt-public-key"]);
  });

  it("emits the PEM encodings the readers expect: PKCS#8 private, SPKI public, RSA-2048", () => {
    const c = mintTenantCrypto();
    expect(c["auth-jwt-private-key"]).toMatch(/^-----BEGIN PRIVATE KEY-----/);
    expect(c["auth-jwt-public-key"]).toMatch(/^-----BEGIN PUBLIC KEY-----/);
    expect(createPublicKey(c["auth-jwt-public-key"]).asymmetricKeyDetails?.modulusLength).toBe(2048);
  });

  it("the three symmetric values are 256 bits of hex — the kind the consumer manifest declares", () => {
    // AUTH_BOOTSTRAP_TOKEN and AUTH_TOTP_ENC_KEY are `generate: hex32` in example-auth's own
    // ConsumerManifest; the tenant's copies are the same values for the same readers, so they are the
    // same kind. engine-api-key is a bearer between two of the tenant's members and takes it too.
    const c = mintTenantCrypto();
    for (const k of ["auth-totp-enc-key", "auth-bootstrap-token", "engine-api-key"] as const) {
      expect(c[k]).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("is fresh on every call — no tenant ever inherits another's identity", () => {
    // The mint is called unconditionally on every create-tenant, including a re-run. What keeps a
    // re-run from ROTATING a live tenant is the create-only write, not this function; what this
    // function must never do is hand two tenants the same key.
    const a = mintTenantCrypto();
    const b = mintTenantCrypto();
    for (const k of TENANT_CRYPTO_PROPERTIES) expect(a[k]).not.toBe(b[k]);
  });
});
