import { describe, it, expect, afterEach, vi } from "vitest";
import { generateKeyPairSync, createVerify, type KeyObject } from "node:crypto";
import { HttpGitHubApp } from "./github-app-http.ts";
import { GitHubAppError } from "./port.ts";

// One key pair for the whole file (a 2048-bit RSA generation is the slow part). The private half is
// exported PKCS#1 — the `BEGIN RSA PRIVATE KEY` form GitHub hands out — so the client is proven on
// the PEM it will actually be given, and the public half verifies every JWT the stub fetch sees.
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs1", format: "pem" }) as string;
const APP = { appId: "12345", installationId: "42", privateKey: PEM };
const T0 = 1_700_000_000_000; // the wall clock every test starts at

interface Seen { method: string; path: string; headers: Record<string, string>; body: string | undefined }

/** A fetch stub routed by method+path that records every request it answered. `routes` may be
 *  replaced between calls, so a test can script the second token mint differently from the first. */
function stubFetch(routes: Record<string, { status: number; body?: unknown }>): { fetchImpl: typeof fetch; seen: Seen[]; routes: Record<string, { status: number; body?: unknown }> } {
  const seen: Seen[] = [];
  const holder = { routes, seen, fetchImpl: undefined as unknown as typeof fetch };
  holder.fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = (typeof url === "string" ? url : url.toString()).replace("https://api.github.com", "");
    const method = init?.method ?? "GET";
    seen.push({ method, path, headers: init?.headers as Record<string, string>, body: init?.body as string | undefined });
    const r = holder.routes[`${method} ${path}`];
    if (!r) throw new Error(`unexpected fetch: ${method} ${path}`);
    return { ok: r.status >= 200 && r.status < 300, status: r.status, statusText: String(r.status), json: async () => r.body ?? null } as Response;
  }) as unknown as typeof fetch;
  return holder;
}

const bearerOf = (s: Seen): string => s.headers.authorization!.replace(/^Bearer /, "");
const decode = (part: string): Record<string, unknown> => JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
const verifies = (jwt: string, key: KeyObject): boolean => {
  const [h, p, sig] = jwt.split(".") as [string, string, string];
  return createVerify("RSA-SHA256").update(`${h}.${p}`).verify(key, Buffer.from(sig, "base64url"));
};
const expiresAt = (ms: number): string => new Date(ms).toISOString();

describe("github-app adapter — the App's JWT and the installation token", () => {
  afterEach(() => vi.useRealTimers());

  it("mints an RS256 JWT the App's key signs, iss = the App id, iat a minute back, exp nine minutes ahead", async () => {
    vi.useFakeTimers({ now: T0, toFake: ["Date"] });
    const stub = stubFetch({ "POST /app/installations/42/access_tokens": { status: 201, body: { token: "ghs_one", expires_at: expiresAt(T0 + 3_600_000) } } });
    const client = new HttpGitHubApp({ ...APP, fetchImpl: stub.fetchImpl });
    expect(await client.installationToken()).toBe("ghs_one");
    const jwt = bearerOf(stub.seen[0]!);
    const [header, payload] = jwt.split(".") as [string, string];
    expect(decode(header)).toEqual({ alg: "RS256", typ: "JWT" });
    expect(decode(payload)).toEqual({ iss: "12345", iat: T0 / 1000 - 60, exp: T0 / 1000 + 9 * 60 });
    // The signature is checked against the PUBLIC half, and a JWT signed by another key would fail
    // here — the counter-probe for a header that merely SAYS RS256.
    expect(verifies(jwt, publicKey)).toBe(true);
    const { publicKey: other } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    expect(verifies(jwt, other)).toBe(false);
    expect(stub.seen[0]!.headers["x-github-api-version"]).toBe("2022-11-28");
  });

  it("caches the token only while it outlives the longest holder, and mints afresh after that", async () => {
    vi.useFakeTimers({ now: T0, toFake: ["Date"] });
    const stub = stubFetch({ "POST /app/installations/42/access_tokens": { status: 201, body: { token: "ghs_one", expires_at: expiresAt(T0 + 3_600_000) } } });
    const client = new HttpGitHubApp({ ...APP, fetchImpl: stub.fetchImpl });
    expect(await client.installationToken()).toBe("ghs_one");
    // Nine minutes in: fifty-one minutes of life left, more than the minimum — no second mint.
    vi.setSystemTime(T0 + 9 * 60_000);
    expect(await client.installationToken()).toBe("ghs_one");
    expect(stub.seen).toHaveLength(1);
    // Eleven minutes in: forty-nine minutes left. A build secret written now is read for up to fifty,
    // so the cached token would die under a clone — minted afresh, and the new value wins.
    stub.routes["POST /app/installations/42/access_tokens"] = { status: 201, body: { token: "ghs_two", expires_at: expiresAt(T0 + 11 * 60_000 + 3_600_000) } };
    vi.setSystemTime(T0 + 11 * 60_000);
    expect(await client.installationToken()).toBe("ghs_two");
    expect(stub.seen).toHaveLength(2);
  });

  it("surfaces GitHub's own message and status when the mint is refused (a revoked key answers 401)", async () => {
    const stub = stubFetch({ "POST /app/installations/42/access_tokens": { status: 401, body: { message: "A JSON web token could not be decoded" } } });
    const client = new HttpGitHubApp({ ...APP, fetchImpl: stub.fetchImpl });
    const err = await client.installationToken().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubAppError);
    expect((err as GitHubAppError).status).toBe(401);
    expect((err as GitHubAppError).message).toMatch(/could not be decoded/);
  });

  it("refuses a mint that answers no expires_at rather than caching a token it cannot time", async () => {
    const stub = stubFetch({ "POST /app/installations/42/access_tokens": { status: 201, body: { token: "ghs_one" } } });
    const client = new HttpGitHubApp({ ...APP, fetchImpl: stub.fetchImpl });
    await expect(client.installationToken()).rejects.toThrow(/expires_at/);
  });

  it("turns a transport failure into a GitHubAppError naming the path", async () => {
    const failing = (async () => { throw new Error("ECONNRESET"); }) as unknown as typeof fetch;
    const client = new HttpGitHubApp({ ...APP, fetchImpl: failing });
    await expect(client.installationToken()).rejects.toThrow(/GitHub request failed \(\/app\/installations\/42\/access_tokens\): ECONNRESET/);
  });

  it("refuses a private key node cannot read where the client is built, not at the first call", () => {
    expect(() => new HttpGitHubApp({ ...APP, privateKey: "-----BEGIN RSA PRIVATE KEY-----\nnot a key\n-----END RSA PRIVATE KEY-----\n" })).toThrow();
  });

  it("identityFingerprint names the App id and the installation id — stable across clients, distinct per installation, never the key or a token", () => {
    const a = new HttpGitHubApp({ ...APP });
    const b = new HttpGitHubApp({ ...APP });
    const other = new HttpGitHubApp({ ...APP, installationId: "999" });
    expect(a.identityFingerprint()).toMatch(/^sha256:[0-9a-f]{16}$/);
    expect(a.identityFingerprint()).toBe(b.identityFingerprint());
    expect(a.identityFingerprint()).not.toBe(other.identityFingerprint());
  });
});

describe("github-app adapter — installationOrg", () => {
  it("reads account.login off the installation with the App's JWT, and keeps it", async () => {
    const stub = stubFetch({ "GET /app/installations/42": { status: 200, body: { id: 42, account: { login: "example-org", type: "Organization" } } } });
    const client = new HttpGitHubApp({ ...APP, fetchImpl: stub.fetchImpl });
    expect(await client.installationOrg()).toBe("example-org");
    expect(await client.installationOrg()).toBe("example-org");
    expect(stub.seen).toHaveLength(1);
    expect(verifies(bearerOf(stub.seen[0]!), publicKey)).toBe(true);
  });

  it("surfaces a refused read with GitHub's message (an installation the key does not sign for is a 404)", async () => {
    const stub = stubFetch({ "GET /app/installations/42": { status: 404, body: { message: "Not Found" } } });
    const client = new HttpGitHubApp({ ...APP, fetchImpl: stub.fetchImpl });
    const err = await client.installationOrg().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubAppError);
    expect((err as GitHubAppError).status).toBe(404);
  });
});

describe("github-app adapter — createRepository", () => {
  const TOKEN_ROUTE = { "POST /app/installations/42/access_tokens": { status: 201, body: { token: "ghs_one", expires_at: expiresAt(Date.now() + 3_600_000) } } };
  const input = { org: "example-org", name: "acme-apps", description: "the apps of acme", private: true };

  it("POSTs to /orgs/{org}/repos with the INSTALLATION token, never the JWT, and answers {created:true} on 201", async () => {
    const stub = stubFetch({ ...TOKEN_ROUTE, "POST /orgs/example-org/repos": { status: 201, body: { id: 1 } } });
    const client = new HttpGitHubApp({ ...APP, fetchImpl: stub.fetchImpl });
    expect(await client.createRepository(input)).toEqual({ created: true });
    const create = stub.seen.find((s) => s.path === "/orgs/example-org/repos")!;
    expect(bearerOf(create)).toBe("ghs_one");
    expect(JSON.parse(create.body ?? "{}")).toEqual({ name: "acme-apps", description: "the apps of acme", private: true });
  });

  it("is idempotent — the 422 that names an existing repository answers {created:false}", async () => {
    const stub = stubFetch({ ...TOKEN_ROUTE, "POST /orgs/example-org/repos": { status: 422, body: {
      message: "Repository creation failed.",
      errors: [{ resource: "Repository", code: "custom", field: "name", message: "name already exists on this account" }],
    } } });
    const client = new HttpGitHubApp({ ...APP, fetchImpl: stub.fetchImpl });
    expect(await client.createRepository(input)).toEqual({ created: false });
  });

  it("surfaces any OTHER 422 as a refusal carrying GitHub's field error, never as an existing repository", async () => {
    const stub = stubFetch({ ...TOKEN_ROUTE, "POST /orgs/example-org/repos": { status: 422, body: {
      message: "Repository creation failed.",
      errors: [{ resource: "Repository", code: "custom", field: "name", message: "name is too long (maximum is 100 characters)" }],
    } } });
    const client = new HttpGitHubApp({ ...APP, fetchImpl: stub.fetchImpl });
    const err = await client.createRepository(input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubAppError);
    expect((err as GitHubAppError).status).toBe(422);
    expect((err as GitHubAppError).message).toMatch(/too long/);
  });

  it("surfaces a 404 — the owner the App is not installed in — with the status", async () => {
    const stub = stubFetch({ ...TOKEN_ROUTE, "POST /orgs/other-org/repos": { status: 404, body: { message: "Not Found" } } });
    const client = new HttpGitHubApp({ ...APP, fetchImpl: stub.fetchImpl });
    const err = await client.createRepository({ ...input, org: "other-org" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubAppError);
    expect((err as GitHubAppError).status).toBe(404);
  });
});

describe("github-app adapter — reachesRepository, the measured rule behind every repository credential", () => {
  it("answers true only when the installation covering the repository IS this one, with the App's JWT and never a token", async () => {
    const stub = stubFetch({ "GET /repos/example-org/acme/installation": { status: 200, body: { id: 42, account: { login: "example-org" } } } });
    const client = new HttpGitHubApp({ ...APP, fetchImpl: stub.fetchImpl });
    expect(await client.reachesRepository({ owner: "example-org", repo: "acme" })).toBe(true);
    expect(verifies(bearerOf(stub.seen[0]!), publicKey)).toBe(true);
  });

  it("answers false for a repository another installation of the App covers — that token is never minted here", async () => {
    const stub = stubFetch({ "GET /repos/other-org/acme/installation": { status: 200, body: { id: 77, account: { login: "other-org" } } } });
    const client = new HttpGitHubApp({ ...APP, fetchImpl: stub.fetchImpl });
    expect(await client.reachesRepository({ owner: "other-org", repo: "acme" })).toBe(false);
  });

  it("answers false on GitHub's 404 — no installation reaches the repository — and refuses any other status by name", async () => {
    const stub = stubFetch({ "GET /repos/other-org/acme/installation": { status: 404, body: { message: "Not Found" } }, "GET /repos/example-org/down/installation": { status: 502, body: { message: "Bad Gateway" } } });
    const client = new HttpGitHubApp({ ...APP, fetchImpl: stub.fetchImpl });
    expect(await client.reachesRepository({ owner: "other-org", repo: "acme" })).toBe(false);
    const err = await client.reachesRepository({ owner: "example-org", repo: "down" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubAppError);
    expect((err as GitHubAppError).status).toBe(502);
  });
});
