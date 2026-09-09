// What this adapter has to get right is not the HTTP — it is the three derivations nothing downstream
// can check: the bucket-scoped RESOURCE string, the SHA-256 the S3 secret is, and the jurisdiction
// travelling as a header on the bucket calls and as a word in that resource. Each is silent when
// wrong: a token with the account-level permission group authenticates and reaches EVERY bucket, a
// secret put down verbatim authenticates nothing until the tenant's first upload, and a bucket made
// under the wrong jurisdiction simply cannot be seen. So the calls are recorded and asserted.
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { CloudflareR2 } from "./cloudflare-r2.ts";
import { ObjectStoreError } from "./port.ts";

const ACCOUNT = "acct1";
const TOKEN_VALUE = "the-token-value";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A fetch that answers each call from a scripted list, recording what it was asked. */
function scripted(answers: Array<{ status?: number; body: unknown }>): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  let i = 0;
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    calls.push({
      url: String(url),
      method: init.method ?? "GET",
      headers: (init.headers ?? {}) as Record<string, string>,
      body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
    });
    const answer = answers[i++];
    if (!answer) throw new Error(`no scripted answer for call ${i}: ${init.method ?? "GET"} ${url}`);
    return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const PERMISSION_GROUPS = {
  success: true,
  result: [
    // The two the adapter must pick, and the two account-level ones whose names read almost the same
    // — the counter-probe of the scope filter, because one of THOSE in a policy is a token reaching
    // every bucket of the account.
    { id: "pg-read", name: "Workers R2 Storage Bucket Item Read", scopes: ["com.cloudflare.edge.r2.bucket"] },
    { id: "pg-write", name: "Workers R2 Storage Bucket Item Write", scopes: ["com.cloudflare.edge.r2.bucket"] },
    { id: "pg-acct-read", name: "Workers R2 Storage Read", scopes: ["com.cloudflare.api.account"] },
    { id: "pg-acct-write", name: "Workers R2 Storage Write", scopes: ["com.cloudflare.api.account"] },
  ],
};

const MINTED = { success: true, result: { id: "token-id", value: TOKEN_VALUE } };

function store(jurisdiction: "default" | "eu" | "fedramp", answers: Array<{ status?: number; body: unknown }>) {
  const { fetchImpl, calls } = scripted(answers);
  return { r2: new CloudflareR2({ apiToken: "managing", accountId: ACCOUNT, jurisdiction, fetchImpl }), calls };
}

describe("making a tenant's bucket", () => {
  it("asks first and creates only what is absent, carrying the jurisdiction as a header", async () => {
    const { r2, calls } = store("eu", [
      { status: 404, body: { success: false, errors: [{ code: 10006, message: "not found" }] } },
      { body: { success: true, result: { name: "tnt1" } } },
    ]);
    expect(await r2.ensureBucket({ bucket: "tnt1" })).toEqual({ created: true });
    expect(calls[0]!.url).toBe(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/r2/buckets/tnt1`);
    expect(calls[1]!.method).toBe("POST");
    expect(calls[1]!.body).toEqual({ name: "tnt1" });
    // Both calls, because a bucket read in one jurisdiction and created in another is a bucket the
    // read can never find again — one run making two.
    for (const c of calls) expect(c.headers["cf-r2-jurisdiction"]).toBe("eu");
  });

  it("leaves a bucket that already stands alone — a re-run must not touch a live tenant's objects", async () => {
    const { r2, calls } = store("default", [{ body: { success: true, result: { name: "tnt1" } } }]);
    expect(await r2.ensureBucket({ bucket: "tnt1" })).toEqual({ created: false });
    expect(calls).toHaveLength(1); // asked, and nothing written
  });

  it("does NOT read a refusal as an absent bucket — only a 404 is that answer", async () => {
    // The counter-probe of the 404 path above. A permission refusal treated as "absent" would make
    // this run try to create the bucket, fail again, and report a name problem for a token problem.
    const { r2 } = store("default", [{ status: 403, body: { success: false, errors: [{ code: 10000, message: "Authentication error" }] } }]);
    await expect(r2.ensureBucket({ bucket: "tnt1" })).rejects.toThrow(/Authentication error/);
  });
});

describe("minting the key that reaches that bucket and no other", () => {
  it("scopes the token to the one bucket, with the two BUCKET-level permission groups", async () => {
    const { r2, calls } = store("eu", [{ body: PERMISSION_GROUPS }, { body: MINTED }]);
    await r2.mintBucketKey({ bucket: "tnt1", name: "tenant-tnt1-prod" });
    const policy = (calls[1]!.body as { name: string; policies: { effect: string; permission_groups: { id: string }[]; resources: Record<string, string> }[] });
    expect(policy.name).toBe("tenant-tnt1-prod");
    expect(policy.policies[0]!.effect).toBe("allow");
    // The bucket-level pair, never the account-level ones whose names read almost the same.
    expect(policy.policies[0]!.permission_groups.map((g) => g.id)).toEqual(["pg-read", "pg-write"]);
    // The resource IS the fence: account, jurisdiction and bucket, in that order, joined by "_".
    expect(policy.policies[0]!.resources).toEqual({ [`com.cloudflare.edge.r2.bucket.${ACCOUNT}_eu_tnt1`]: "*" });
  });

  it("says `default` in the resource for the unrestricted jurisdiction, never leaves it out", async () => {
    const { r2, calls } = store("default", [{ body: PERMISSION_GROUPS }, { body: MINTED }]);
    const key = await r2.mintBucketKey({ bucket: "tnt1", name: "k" });
    expect(Object.keys((calls[1]!.body as { policies: { resources: Record<string, string> }[] }).policies[0]!.resources))
      .toEqual([`com.cloudflare.edge.r2.bucket.${ACCOUNT}_default_tnt1`]);
    // ...while the ENDPOINT carries no label for it — the one place the two spellings differ.
    expect(key.endpoint).toBe(`https://${ACCOUNT}.r2.cloudflarestorage.com`);
  });

  it("derives the S3 pair the way R2 does: the id is the access key, the SHA-256 of the value is the secret", async () => {
    const { r2 } = store("eu", [{ body: PERMISSION_GROUPS }, { body: MINTED }]);
    const key = await r2.mintBucketKey({ bucket: "tnt1", name: "k" });
    expect(key.accessKeyId).toBe("token-id");
    expect(key.secretAccessKey).toBe(createHash("sha256").update(TOKEN_VALUE).digest("hex"));
    // The counter-probe of the line above: the token's own value is NOT the secret. Put down
    // verbatim it authenticates nothing, and nothing says so until the tenant's first upload.
    expect(key.secretAccessKey).not.toBe(TOKEN_VALUE);
    expect(key.endpoint).toBe(`https://${ACCOUNT}.eu.r2.cloudflarestorage.com`);
  });

  it("refuses by name when the account offers no bucket-scoped group of that name", async () => {
    // Only the account-level pair on offer. Silently using those would mint a token reaching EVERY
    // bucket — the one outcome this whole port exists to prevent — so it fails instead.
    const { r2 } = store("default", [{ body: { success: true, result: PERMISSION_GROUPS.result.slice(2) } }]);
    await expect(r2.mintBucketKey({ bucket: "tnt1", name: "k" })).rejects.toThrow(
      /no bucket-scoped permission group named "Workers R2 Storage Bucket Item Read" or "Workers R2 Storage Bucket Item Write"/,
    );
  });

  it("refuses a create that answered without the secret half, rather than composing a key from nothing", async () => {
    const { r2 } = store("default", [{ body: PERMISSION_GROUPS }, { body: { success: true, result: { id: "token-id" } } }]);
    await expect(r2.mintBucketKey({ bucket: "tnt1", name: "k" })).rejects.toThrow(/answered without its value/);
  });

  it("looks the permission groups up once per client, not once per tenant", async () => {
    const { r2, calls } = store("default", [{ body: PERMISSION_GROUPS }, { body: MINTED }, { body: MINTED }]);
    await r2.mintBucketKey({ bucket: "a", name: "ka" });
    await r2.mintBucketKey({ bucket: "b", name: "kb" });
    expect(calls.filter((c) => c.url.includes("permission_groups"))).toHaveLength(1);
  });
});

describe("withdrawing a key", () => {
  it("deletes by the access key id, which IS the token id — never by name", async () => {
    // By name would take the tenant's LIVE key with it: every key of one tenant carries the same
    // name by construction.
    const { r2, calls } = store("default", [{ body: { success: true } }]);
    expect(await r2.withdrawBucketKey({ accessKeyId: "token-id" })).toEqual({ deleted: 1 });
    expect(calls[0]!.method).toBe("DELETE");
    expect(calls[0]!.url).toBe(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/tokens/token-id`);
  });

  it("reads an absent key as done, so a resume and a second withdrawal both pass", async () => {
    const { r2 } = store("default", [{ status: 404, body: { success: false, errors: [{ code: 1001, message: "not found" }] } }]);
    expect(await r2.withdrawBucketKey({ accessKeyId: "gone" })).toEqual({ deleted: 0 });
  });
});

describe("how a Cloudflare answer is judged", () => {
  it("fails on success:false even at HTTP 200, carrying Cloudflare's own words", async () => {
    const { r2 } = store("default", [{ status: 200, body: { success: false, errors: [{ code: 10001, message: "Invalid account" }] } }]);
    await expect(r2.ensureBucket({ bucket: "tnt1" })).rejects.toThrow(/\[10001\] Invalid account/);
  });

  it("fails on a body that is not JSON, naming the status", async () => {
    const fetchImpl = (async () => new Response("<html>gateway</html>", { status: 502 })) as unknown as typeof fetch;
    const r2 = new CloudflareR2({ apiToken: "t", accountId: ACCOUNT, jurisdiction: "default", fetchImpl });
    await expect(r2.ensureBucket({ bucket: "tnt1" })).rejects.toThrow(/answered HTTP 502 with no JSON body/);
  });

  it("carries the status, which is what tells an absent bucket from a refused one", async () => {
    const { r2 } = store("default", [{ status: 404, body: { success: false, errors: [] } }]);
    // ensureBucket reads it; this asserts the field the reading rests on.
    const thrown = await r2.withdrawBucketKey({ accessKeyId: "x" }).then(() => null, (e: unknown) => e);
    expect(thrown).toBe(null); // a 404 withdrawal is a pass, not a throw
    const { r2: other } = store("default", [{ status: 403, body: { success: false, errors: [{ message: "denied" }] } }]);
    const err = await other.withdrawBucketKey({ accessKeyId: "x" }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(ObjectStoreError);
    expect((err as ObjectStoreError).status).toBe(403);
  });
});
