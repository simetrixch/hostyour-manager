// tenant-crypto-mint.ts — the five values that ARE a tenant's identity, and the one place they are
// made.
//
// WHAT THEY ARE. A tenant's members authenticate each other with them: its IdP signs tokens with the
// RSA private half, and the engine and jobs of every one of its apps verify against the public half
// through the JWKS; the TOTP key encrypts second factors at rest; the bootstrap token gates the one
// route that creates the tenant's first admin; the engine key is the bearer its jobs presents and its
// engine checks. They live as ONE Vault entry, <stage>/tenants/<guid>, which every member namespace
// reads through an ESO SecretStore whose policy is templated on the tenant annotation
// (hostyour-cloud/base/lib/seed-vault.sh, <cluster>-tenant-read).
//
// WHY THE CONTROLLER MAKES THEM. Everything else a tenant needs is claimed by the member chart that
// needs it and provisioned per NAMESPACE by apps/service-provisioner — and that per-namespace anchoring
// is exactly what makes a claim safe, because the provisioner names its resources `<namespace>_<claim>`
// so no claim can reach another unit's. These five are the opposite kind of value: per TENANT and
// SHARED, read from four namespaces at once. A per-namespace claim would mint a different keypair for
// each member, and the IdP would sign with a key its own engine cannot verify. A per-tenant value needs
// a per-tenant writer, and the Controller is already the minter of exactly these kinds for a consumer.
//
// WHAT THIS FILE DOES NOT DO. It never writes: it returns the values and the seeder (VaultSeeder
// .seedTenantCrypto) writes them create-only, cas=0. That split is what lets the mint be a pure unit
// with no IO, and it is why re-running create-tenant is safe — the mint is unconditional and the WRITE
// is what refuses to overwrite a live tenant's keys.
//
// Boundary: domain layer, pure. Node crypto only, through the shared mint helpers in secret-mint.ts.
import { generateRsaKeypair, mintSecretValue } from "./secret-mint.ts";

/** The properties of `<stage>/tenants/<guid>`, in the spelling every reader uses. Four are read out of
 *  the member's app Secret (catalog/charts/example-lib/templates/_secret-kit.tpl, the
 *  `appSecretName` ExternalSecret) and the fifth by the tenant's jobs and engine
 *  (catalog/charts/example-jobs/templates/externalsecret-engine-api-key.yaml). A property missing
 *  here is a Secret key ESO cannot resolve, which stops the member's pods at boot — so the list is
 *  asserted against the mint rather than trusted. */
export const TENANT_CRYPTO_PROPERTIES = [
  "auth-jwt-private-key",
  "auth-jwt-public-key",
  "auth-totp-enc-key",
  "auth-bootstrap-token",
  "engine-api-key",
] as const;

export type TenantCryptoProperty = (typeof TENANT_CRYPTO_PROPERTIES)[number];

/** Mint one tenant's crypto entry. Every value is fresh, and the keypair is self-verified inside
 *  generateRsaKeypair (the public is re-derived from the private), so a corrupt pair fails here rather
 *  than surfacing as a JWKS error at the tenant's first login.
 *
 *  The two hex32 kinds are the SAME kinds the consumer manifest declares for the same two values
 *  (example-auth's deploy/platform.yaml: AUTH_BOOTSTRAP_TOKEN and AUTH_TOTP_ENC_KEY are both
 *  `generate: hex32`), taken from the shared helper rather than restated — 32 random bytes as hex.
 *  `engine-api-key` is a bearer between two of the tenant's own members and takes the same kind.
 *
 *  Unconditional by design: nothing here reads Vault to decide whether a tenant already has an entry.
 *  The write is create-only (cas=0) and Vault decides existence server-side, which is what keeps the
 *  Controller's write-only property intact — read-before-write would need a read grant on every
 *  tenant's crypto path, and that grant is the one thing this design must not hand out. */
/** The tenant's object storage, as the operator hands it over at approve. The three properties the
 *  members read out of the SAME entry the crypto lives in: the engine's StoragePort takes the key
 *  pair, and the relocation jobs take all three (the endpoint too, because a dump runs outside the
 *  engine and derives nothing).
 *
 *  SUPPLIED, NOT MINTED — which is the whole difference from the five above. A bucket and a key
 *  scoped to it are made at Cloudflare, and the account-scoped token that makes them belongs to the
 *  unit that holds it, never to this platform tier (hostyour-cloud base/secrets/secrets.example says so
 *  where the token is NOT declared). So the Controller asks for what was made rather than holding a
 *  credential that could make more, and writes it into the one entry it already writes. */
export const TENANT_STORAGE_PROPERTIES = ["upload-s3-key", "upload-s3-secret", "upload-s3-endpoint"] as const;
export type TenantStorageProperty = (typeof TENANT_STORAGE_PROPERTIES)[number];

export function mintTenantCrypto(): Record<TenantCryptoProperty, string> {
  const { privatePem, publicPem } = generateRsaKeypair();
  return {
    "auth-jwt-private-key": privatePem,
    "auth-jwt-public-key": publicPem,
    "auth-totp-enc-key": mintSecretValue("hex32"),
    "auth-bootstrap-token": mintSecretValue("hex32"),
    "engine-api-key": mintSecretValue("hex32"),
  };
}
