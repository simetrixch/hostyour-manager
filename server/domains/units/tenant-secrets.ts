// The Kubernetes Secret NAMES a tenant's member namespaces carry. One home for each, because the
// same Secret is read by the invite path, the activate step, the check-tenants sweep and the
// relocation jobs — a second constant holding the same literal is the one a rename misses.
// The KEYS inside stay with their readers (BOOTSTRAP_TOKEN_KEY in tenant-admin-invite.ts,
// TENANT_CRYPTO_KEYS in relocation-jobs.ts): the key is the axis that differs, the Secret is not.

/** The Secret every tenant member kit materializes from the tenant's Vault entry — the crypto
 *  material, and in the auth member's own namespace <guid>-auth the one-shot bootstrap token
 *  example-auth accepts as `X-Bootstrap-Token`. */
export const TENANT_SECRET = "hostyour-app-secrets";

/** The bucket-scoped key Secret only app members (the engine) carry. */
export const TENANT_S3_SECRET = "hostyour-tenant-s3";
