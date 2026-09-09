// The tenant object storage port. A tenant gets EXACTLY ONE bucket, named by its guid, and exactly
// one key that reaches that bucket and no other — made at create-tenant, and the key withdrawn when
// a create is rolled back. Kept a PORT so the run steps depend on the abstraction; the Cloudflare
// impl is cloudflare-r2.ts, the fake is testing/fake.ts.
//
// WHY THE PLATFORM MINTS THE KEY RATHER THAN AN OPERATOR HANDING ONE OVER. The installation answers
// ONE object-storage credential (config.ts objectStorage), and it is a MANAGING one: it can create
// buckets and mint keys for the account. A key made from it for one bucket is the only object-storage
// value a tenant ever holds, so a key read out of one tenant's pod reaches that tenant's objects and
// stops there. The alternative — one installation-wide key in every tenant's pod — would reach every
// tenant's objects, which is the one thing every other fence of this platform is built against.
//
// The MANAGING token itself never leaves this process: it is not written into a tenant's Vault entry,
// not returned by any method here, and not logged.

/** What a tenant's members are given: the bucket, the key pair that reaches it, and the endpoint the
 *  relocation jobs address it at. The engine composes its own endpoint from the account and the
 *  jurisdiction it reads off the platform values chain, so the two derivations must agree — which is
 *  why the endpoint here is derived from exactly those two values and never answered. */
export interface TenantBucket {
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly endpoint: string;
}

export interface ObjectStore {
  /** Idempotent create-by-name: make the bucket, or leave the existing one exactly as it stands.
   *  A re-run of create-tenant must never touch the objects a live tenant already has. */
  ensureBucket(input: { bucket: string; signal?: AbortSignal }): Promise<{ created: boolean }>;
  /** Mint a key reaching ONLY that bucket, under a name the caller composes per tenant.
   *
   *  ALWAYS A NEW KEY, never a replacement of one carrying the same name. The secret half exists once,
   *  at the moment it is minted, and nothing can read it back — so a caller that replaced a standing
   *  key would destroy the one credential the tenant's Vault entry names, and that entry is written
   *  create-once (cas=0): a re-run cannot put the new key in its place. Minting beside it keeps the
   *  live tenant working, and withdrawBucketKey below is how the caller takes back the one the entry
   *  did not accept. */
  mintBucketKey(input: { bucket: string; name: string; signal?: AbortSignal }): Promise<TenantBucket>;
  /** Withdraw ONE key by its access key id. An absent key resolves { deleted: 0 } — the caller runs
   *  this on the key a create-once entry refused, and on a resume that key is already gone.
   *
   *  BY ID AND NEVER BY NAME. Every key of one tenant carries the same name by construction, so a
   *  withdrawal by name would take the tenant's LIVE key with it. */
  withdrawBucketKey(input: { accessKeyId: string; signal?: AbortSignal }): Promise<{ deleted: number }>;
}

/** Any object-storage API failure — a transport error, a non-2xx, or a body whose `success` flag is
 *  false. Carries the provider's own error text verbatim (never a generic mask): the run step
 *  surfaces it and the run FAILS. A bucket or a key that may or may not exist is exactly the leftover
 *  this port exists to rule out, and a tenant whose engine cannot reach its bucket refuses to boot —
 *  so a swallowed error would produce a tenant that looks created and never starts. */
export class ObjectStoreError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "ObjectStoreError";
    this.status = status;
  }
}
