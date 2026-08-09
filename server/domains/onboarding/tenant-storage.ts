import type { StepCtx } from "../../executor/types.ts";
import { errValidation } from "../../kernel/errors.ts";
import { TENANT_STORAGE_PROPERTIES } from "./tenant-crypto-mint.ts";

// The tenant's object storage, collected at approve and written into the tenant's Vault entry.
//
// WHY THE OPERATOR HANDS IT OVER instead of the platform minting it. A bucket and a key scoped to it
// are made at Cloudflare with an ACCOUNT-scoped token, and hostyour-cloud base/secrets/secrets.example
// declares — by pointedly NOT declaring that token — that it belongs to the unit holding it and not
// to this installation's platform tier. A Controller that held one could mint buckets and keys for
// the whole account; a Controller that is handed one key can use one bucket. So the values arrive
// the way every other operator-supplied secret does, through approve, and the Controller's part is
// to put them where the members read them.
//
// WHAT BREAKS WITHOUT THEM, and why this is not optional: the tenant engine chart pins
// UPLOAD_STORAGE=r2 (catalog charts/example-engine deployment), and the engine's storage-factory
// REFUSES TO BOOT in production when the configuration is incomplete rather than falling back to
// local disk. A tenant created without these three has an engine that never starts.

/** The prefix the two sealed values carry through approve. The executor names a required secret, the
 *  operator fills it, and a step reads it back under the same name — one string, stated once. */
export const STORAGE_SECRET_PREFIX = "tenant-storage:";

/** The endpoint's field name in the clear-text channel. Not a secret: it is a public URL, and
 *  sealing it would only make it harder to read back when a dump job needs it. */
export const STORAGE_ENDPOINT_FIELD = "storageEndpoint";

/** The three properties, as the Vault entry names them, from what the operator handed over.
 *
 *  Refuses each missing value BY NAME. approve already demands the two secrets, so a gap here means
 *  the endpoint was left blank — and an entry written with two of three would produce a tenant whose
 *  engine boots and whose relocation jobs cannot find the bucket, which is worse than not creating
 *  it: cas=0 makes the entry write-once, so the half-filled version would be the one that stands. */
export function readTenantStorage(ctx: StepCtx): Record<string, string> {
  const read = (name: string): string => ctx.secrets.get(name)?.toString("utf8").trim() ?? "";
  const key = read(`${STORAGE_SECRET_PREFIX}key`);
  const secret = read(`${STORAGE_SECRET_PREFIX}secret`);
  const endpoint = read(`activation-input:${STORAGE_ENDPOINT_FIELD}`) || read(STORAGE_ENDPOINT_FIELD);

  const missing = [
    ...(key ? [] : ["the access key"]),
    ...(secret ? [] : ["the secret key"]),
    ...(endpoint ? [] : ["the endpoint"]),
  ];
  if (missing.length > 0) {
    throw errValidation(
      `the tenant's object storage is incomplete — missing ${missing.join(", ")}. ` +
      "Create the bucket and a key scoped to it at Cloudflare, then supply both at approve; the tenant's engine refuses to boot without them.",
    );
  }
  if (!/^https?:\/\/[^\s]+$/.test(endpoint)) {
    throw errValidation(`the tenant's storage endpoint "${endpoint}" is not a URL — it is what the relocation jobs address the bucket by`);
  }

  const [k, s, e] = TENANT_STORAGE_PROPERTIES;
  return { [k]: key, [s]: secret, [e]: endpoint };
}
