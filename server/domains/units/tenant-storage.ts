import type { ObjectStore, TenantBucket } from "../../adapters/object-store/port.ts";
import { errValidation } from "../../kernel/errors.ts";
import type { Stage } from "../../../shared/enums.ts";
import { TENANT_STORAGE_PROPERTIES } from "./tenant-crypto-mint.ts";

// The tenant's object storage: the platform makes the bucket and mints the key, and nobody is asked.
//
// WHY THE PLATFORM MINTS IT rather than an operator handing one over. The installation answers ONE
// object-storage credential (config.ts objectStorage, from secret/<stage>/app/cloudflare-r2), and it
// is a MANAGING one. A key made from it for one bucket is the only object-storage value a tenant ever
// holds, so a key read out of one tenant's pod reaches that tenant's objects and stops there. Until
// this, the two halves of the pair and the endpoint were three required inputs at approve, and
// nothing created a bucket at all — the operator made both by hand at Cloudflare
// (simetrixch/hostyour-cloud#197).
//
// WHAT BREAKS WITHOUT IT, and why this is not optional: the tenant engine chart pins
// UPLOAD_STORAGE=r2, and the engine's storage-factory REFUSES TO BOOT in production when the
// configuration is incomplete rather than falling back to local disk. A tenant created without these
// three has an engine that never starts.

/** The name every key of one tenant is minted under. Deterministic, so an operator reading the
 *  account's tokens can tell whose key each one is — and it carries the stage, because one guid can
 *  exist at two stages and each has a bucket and a key of its own. */
export function tenantKeyName(guid: string, stage: Stage): string {
  return `tenant-${guid}-${stage}`;
}

/** Make the tenant's bucket and mint the one key that reaches it.
 *
 *  THE BUCKET IS THE TENANT'S GUID, which is what the engine chart already addresses
 *  (UPLOAD_S3_BUCKET) and what the relocation jobs address as `s3:<guid>`. Idempotent: a bucket a
 *  previous run made is left exactly as it stands, objects and all.
 *
 *  THE KEY IS MINTED FRESH ON EVERY CALL, beside whatever stands, and that is deliberate. A key's
 *  secret half exists once, at the moment it is minted; replacing a standing key would destroy the
 *  one credential the tenant's Vault entry names, and that entry is written create-once — a re-run
 *  cannot put the new key in its place. So the caller seeds what this returns and, where the entry
 *  refused it, hands the accessKeyId straight back to withdrawBucketKey. */
export async function provisionTenantStorage(
  store: ObjectStore | undefined,
  p: { guid: string; stage: Stage; signal?: AbortSignal },
): Promise<{ bucket: TenantBucket; properties: Record<string, string>; created: boolean }> {
  if (!store) {
    throw errValidation(
      "no object storage is wired on this manager (CLOUDFLARE_R2_API_TOKEN and CLOUDFLARE_R2_ACCOUNT_ID unset) — " +
      "a tenant's bucket and the key scoped to it are a mandatory part of creating one, never a silent skip: " +
      "the engine chart pins UPLOAD_STORAGE=r2 and the engine refuses to boot without a bucket it can reach",
    );
  }
  const signal = p.signal ? { signal: p.signal } : {};
  const { created } = await store.ensureBucket({ bucket: p.guid, ...signal });
  const bucket = await store.mintBucketKey({ bucket: p.guid, name: tenantKeyName(p.guid, p.stage), ...signal });
  const [k, s, e] = TENANT_STORAGE_PROPERTIES;
  return {
    bucket,
    properties: { [k]: bucket.accessKeyId, [s]: bucket.secretAccessKey, [e]: bucket.endpoint },
    created,
  };
}
