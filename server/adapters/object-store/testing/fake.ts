// In-memory ObjectStore fake for the tenant domain tests — no network. Buckets by name and keys by
// their access key id, so a test asserts the ONE bucket a create made, the key it minted for it, and
// that a re-run made no second bucket and left no key the tenant's entry does not name.
import type { ObjectStore, TenantBucket } from "../port.ts";

export class FakeObjectStore implements ObjectStore {
  /** Every bucket that exists, by name. Seed one to stand for a bucket a previous run made. */
  readonly buckets = new Set<string>();
  /** The live keys, by their access key id — a test asserts exactly which keys are still standing. */
  readonly keys = new Map<string, TenantBucket>();
  /** Every mint, in order, with the name it was minted under. */
  readonly mints: Array<TenantBucket & { name: string }> = [];
  /** Every withdrawal, in order, with whether it took a key. */
  readonly withdrawals: Array<{ accessKeyId: string; deleted: number }> = [];
  /** When set, every call throws it — the API-failure path (an unreachable or refusing provider). */
  failWith: Error | null = null;
  /** The account's S3 address, as the real adapter derives it from the account and jurisdiction. */
  endpoint = "https://account.r2.cloudflarestorage.com";

  private counter = 0;

  async ensureBucket(input: { bucket: string }): Promise<{ created: boolean }> {
    if (this.failWith) throw this.failWith;
    const created = !this.buckets.has(input.bucket);
    this.buckets.add(input.bucket);
    return { created };
  }

  async mintBucketKey(input: { bucket: string; name: string }): Promise<TenantBucket> {
    if (this.failWith) throw this.failWith;
    this.counter += 1;
    const minted: TenantBucket = {
      bucket: input.bucket,
      accessKeyId: `key-${this.counter}`,
      secretAccessKey: `secret-${this.counter}`,
      endpoint: this.endpoint,
    };
    this.keys.set(minted.accessKeyId, minted);
    this.mints.push({ ...minted, name: input.name });
    return minted;
  }

  async withdrawBucketKey(input: { accessKeyId: string }): Promise<{ deleted: number }> {
    if (this.failWith) throw this.failWith;
    const deleted = this.keys.delete(input.accessKeyId) ? 1 : 0;
    this.withdrawals.push({ accessKeyId: input.accessKeyId, deleted });
    return { deleted };
  }
}
