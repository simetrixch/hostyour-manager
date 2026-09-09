// The Cloudflare R2 object store (fetch, no SDK — the cloudflare-dns.ts rationale: a trivial
// dependency surface, and the same API with the same credential shape):
//  - every response is judged by the body's `success` flag, NOT the HTTP status alone — Cloudflare
//    can answer HTTP 200 with {"success": false, "errors": [...]};
//  - a 429 is retried with a short bounded backoff (this client makes 3-6 calls per tenant, far
//    below the API's rate limit, so a few retries always suffice).
// The managing token rides ONLY in the Authorization header and is never logged.
//
// THE JURISDICTION IS A HEADER ON THE BUCKET CALLS AND A WORD IN THE KEY'S RESOURCE. Cloudflare
// keeps a separate bucket namespace per jurisdiction: a bucket made under `eu` cannot be seen from
// `default`, and the resource string a key is scoped by names the jurisdiction itself. So both
// halves read the SAME configured value, and neither derives it from the other.
//
// HOW AN R2 KEY IS ACTUALLY MADE, because it is not an endpoint of its own: an R2 access key IS an
// account API token scoped to a bucket, and the S3 pair is DERIVED from it — the access key id is
// the token's `id`, and the secret access key is the SHA-256 of the token's `value`
// (developers.cloudflare.com/r2/api/tokens). The value is returned once, at creation, and never
// again — which is why nothing here reads a key back, and why a caller that needs a key it did not
// keep has to mint another one beside the one it cannot see.
import { createHash } from "node:crypto";
import type { ObjectStore, TenantBucket } from "./port.ts";
import { ObjectStoreError } from "./port.ts";

type FetchLike = typeof fetch;

/** The two permission groups a bucket-scoped key needs, BY NAME. The ids are looked up rather than
 *  written down: a permission group's id is an opaque uuid of the account's API, and a wrong one is
 *  a token that authenticates and reaches nothing — which shows up as a tenant engine failing on
 *  its own bucket, three layers away from the cause. */
const BUCKET_PERMISSIONS = ["Workers R2 Storage Bucket Item Read", "Workers R2 Storage Bucket Item Write"] as const;

/** The scope every bucket-level permission group carries, and what tells them apart from the
 *  account-level R2 groups whose names read almost the same. */
const BUCKET_SCOPE = "com.cloudflare.edge.r2.bucket";

const MAX_RATE_LIMIT_RETRIES = 3;

interface CfEnvelope<T> {
  success: boolean;
  errors?: { code?: number; message?: string }[];
  result?: T;
}

interface CfPermissionGroup {
  id: string;
  name: string;
  scopes?: string[];
}

interface CfToken {
  id: string;
  /** The secret half, returned ONLY by the create call. */
  value?: string;
}

export class CloudflareR2 implements ObjectStore {
  private readonly apiBase: string;
  private readonly fetchImpl: FetchLike;
  /** The two permission-group ids, once per instance — they are properties of the API, not of a
   *  tenant, so looking them up per tenant would be a call per create for one unchanging answer. */
  private permissions: { id: string; name: string }[] | null = null;

  constructor(private readonly opts: {
    apiToken: string;
    accountId: string;
    jurisdiction: "default" | "eu" | "fedramp";
    apiBase?: string;
    fetchImpl?: FetchLike;
  }) {
    this.apiBase = (opts.apiBase ?? "https://api.cloudflare.com/client/v4").replace(/\/$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** The S3 address of this account's buckets. The default jurisdiction carries no label; the other
   *  two carry theirs. The tenant engine composes the same address from the same two values off the
   *  platform values chain, so a change here is a change there. */
  get endpoint(): string {
    const label = this.opts.jurisdiction === "default" ? "" : `.${this.opts.jurisdiction}`;
    return `https://${this.opts.accountId}${label}.r2.cloudflarestorage.com`;
  }

  async ensureBucket(input: { bucket: string; signal?: AbortSignal }): Promise<{ created: boolean }> {
    // ASKED BEFORE CREATED, rather than creating and reading the refusal. "Already exists" is one
    // error code among the many a create can answer with, and telling it apart from a permission
    // refusal or a name the API rejects would mean trusting a number this code does not own. A read
    // that answers "it is there" is the same answer on every version of the API.
    if (await this.bucketExists(input.bucket, input.signal)) return { created: false };
    await this.send<unknown>(`/accounts/${this.opts.accountId}/r2/buckets`, {
      method: "POST",
      body: { name: input.bucket },
      jurisdiction: true,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    return { created: true };
  }

  async mintBucketKey(input: { bucket: string; name: string; signal?: AbortSignal }): Promise<TenantBucket> {
    const permission_groups = await this.bucketPermissions(input.signal);
    const resource = `${BUCKET_SCOPE}.${this.opts.accountId}_${this.opts.jurisdiction}_${input.bucket}`;
    const token = await this.send<CfToken>(`/accounts/${this.opts.accountId}/tokens`, {
      method: "POST",
      body: {
        name: input.name,
        policies: [{ effect: "allow", permission_groups, resources: { [resource]: "*" } }],
      },
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (!token?.id || !token.value) {
      throw new ObjectStoreError(
        `Cloudflare made the key "${input.name}" for bucket "${input.bucket}" and answered without ${token?.id ? "its value" : "an id"} — ` +
        "the secret half is returned once and never again, so this key can no longer be composed and has to be withdrawn and minted anew",
      );
    }
    return {
      bucket: input.bucket,
      accessKeyId: token.id,
      // The S3 secret IS the SHA-256 of the token value, in hex — not the value itself. A token
      // value put here verbatim authenticates nothing, with no error until the engine's first upload.
      secretAccessKey: createHash("sha256").update(token.value).digest("hex"),
      endpoint: this.endpoint,
    };
  }

  async withdrawBucketKey(input: { accessKeyId: string; signal?: AbortSignal }): Promise<{ deleted: number }> {
    // The access key id IS the token's id, so the withdrawal is one call and needs no listing — and
    // therefore no permission to read the account's other tokens.
    try {
      await this.send<unknown>(`/accounts/${this.opts.accountId}/tokens/${encodeURIComponent(input.accessKeyId)}`, {
        method: "DELETE",
        ...(input.signal ? { signal: input.signal } : {}),
      });
      return { deleted: 1 };
    } catch (e) {
      // Already gone is the SUCCESS of this method, not a failure: it runs on a resume, and on the
      // key a create-once Vault entry refused, both of which can have withdrawn it already.
      if (e instanceof ObjectStoreError && e.status === 404) return { deleted: 0 };
      throw e;
    }
  }

  /** Whether the bucket is there, under THIS jurisdiction. A 404 is an answer and not a failure, so
   *  it is the one status this client reads rather than throwing on. */
  private async bucketExists(bucket: string, signal?: AbortSignal): Promise<boolean> {
    try {
      await this.send<unknown>(`/accounts/${this.opts.accountId}/r2/buckets/${encodeURIComponent(bucket)}`, {
        jurisdiction: true,
        ...(signal ? { signal } : {}),
      });
      return true;
    } catch (e) {
      if (e instanceof ObjectStoreError && e.status === 404) return false;
      throw e;
    }
  }

  /** The two bucket-level permission groups, by name, out of what the account offers. Filtered on the
   *  bucket SCOPE as well as the name: the account-level R2 groups ("Workers R2 Storage Read") read
   *  almost the same, and one of those in a policy is a token reaching EVERY bucket — the exact thing
   *  this port exists to prevent. Refuses by name where either is missing, because a policy short of
   *  the write group is a tenant that can read its objects and store none. */
  private async bucketPermissions(signal?: AbortSignal): Promise<{ id: string; name: string }[]> {
    if (this.permissions) return this.permissions;
    const groups = (await this.send<CfPermissionGroup[]>(
      `/accounts/${this.opts.accountId}/tokens/permission_groups?per_page=200`,
      signal ? { signal } : {},
    )) ?? [];
    const found = BUCKET_PERMISSIONS.map((name) => {
      const g = groups.find((each) => each.name === name && (each.scopes ?? []).includes(BUCKET_SCOPE));
      return g ? { id: g.id, name } : null;
    });
    const missing = BUCKET_PERMISSIONS.filter((_, i) => found[i] === null);
    if (missing.length > 0) {
      throw new ObjectStoreError(
        `Cloudflare account ${this.opts.accountId} offers no bucket-scoped permission group named ${missing.map((m) => `"${m}"`).join(" or ")} ` +
        `(scope ${BUCKET_SCOPE}) — may the managing token read this account's permission groups?`,
      );
    }
    this.permissions = found as { id: string; name: string }[];
    return this.permissions;
  }

  /** One API call: auth header, the jurisdiction header where the path is a bucket path, JSON body,
   *  the success-flag check, and the bounded 429 backoff. Returns the envelope's `result`. Every
   *  failure throws ObjectStoreError carrying Cloudflare's own error text — the caller's run step
   *  surfaces it and fails. */
  private async send<T>(path: string, init: { method?: string; body?: unknown; jurisdiction?: boolean; signal?: AbortSignal }): Promise<T | undefined> {
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.apiBase}${path}`, {
          method: init.method ?? "GET",
          headers: {
            authorization: `Bearer ${this.opts.apiToken}`,
            "content-type": "application/json",
            // Only on the bucket calls. On a token call it means nothing, and a header that means
            // nothing on one endpoint and everything on another is read wrong exactly once.
            ...(init.jurisdiction ? { "cf-r2-jurisdiction": this.opts.jurisdiction } : {}),
          },
          ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
          ...(init.signal ? { signal: init.signal } : {}),
        });
      } catch (e) {
        throw new ObjectStoreError(`Cloudflare R2 request failed (${path}): ${e instanceof Error ? e.message : String(e)}`);
      }
      if (res.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
        await new Promise((r) => setTimeout(r, (attempt + 1) * 2000));
        continue;
      }
      const body = (await res.json().catch(() => null)) as CfEnvelope<T> | null;
      if (body === null) {
        throw new ObjectStoreError(`Cloudflare R2 answered HTTP ${res.status} with no JSON body (${path})`, res.status);
      }
      if (!body.success) {
        const why = (body.errors ?? []).map((e) => `[${e.code ?? "?"}] ${e.message ?? "unknown error"}`).join("; ") || `HTTP ${res.status}`;
        throw new ObjectStoreError(`Cloudflare R2 refused ${init.method ?? "GET"} ${path}: ${why}`, res.status);
      }
      return body.result;
    }
  }
}
