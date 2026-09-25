import { describe, it, expect } from "vitest";
import { HttpGitHubConsumer } from "./github-consumer-http.ts";
import { WebhookScopeError, WorkflowNotFoundError, GitHubConsumerError } from "./port.ts";

// A tiny fetch stub: routes by method+path, returns { status, body }. Mirrors github.test.ts.
function stubFetch(routes: Record<string, { status: number; body?: unknown }>): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === "string" ? url : url.toString();
    const key = `${init?.method ?? "GET"} ${u.replace("https://api.github.com", "")}`;
    const r = routes[key];
    if (!r) throw new Error(`unexpected fetch: ${key}`);
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      statusText: String(r.status),
      json: async () => r.body ?? null,
    } as Response;
  }) as unknown as typeof fetch;
}

describe("github-consumer adapter — readFile", () => {
  it("asks for the file raw and answers its text: the adapter's own accept header does not replace the caller's", async () => {
    // Replaced, GitHub answers the JSON envelope with the file base64-encoded inside it, and a reader
    // looking for lines in the file finds none: the consumer wizard then measured no scope in a
    // repository's .npmrc and never asked for the owner's packages reader.
    const accepted: string[] = [];
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      accepted.push((init?.headers as Record<string, string> | undefined)?.accept ?? "");
      return { ok: true, status: 200, statusText: "200", text: async () => "@acme:registry=https://npm.pkg.github.com\n" } as Response;
    }) as unknown as typeof fetch;
    const client = new HttpGitHubConsumer({ fetchImpl });
    expect(await client.readFile({ owner: "x", repo: "acme", path: ".npmrc", token: "tkn" })).toBe("@acme:registry=https://npm.pkg.github.com\n");
    expect(accepted).toEqual(["application/vnd.github.raw+json"]);
  });
});

const TARGET = "https://build.s1.example/github";
const ensureInput = { owner: "x", repo: "acme", token: "tkn", targetUrl: TARGET, secret: "hmac", events: ["push"], contentType: "json" };

describe("github-consumer adapter — ensureHook", () => {
  it("creates the push-webhook when the repo has none, returning {created:true,id}", async () => {
    const client = new HttpGitHubConsumer({ fetchImpl: stubFetch({
      "GET /repos/x/acme/hooks?per_page=100&page=1": { status: 200, body: [] },
      "POST /repos/x/acme/hooks": { status: 201, body: { id: 99 } },
    }) });
    expect(await client.ensureHook(ensureInput)).toEqual({ created: true, id: 99, staleRemoved: 0 });
  });

  it("re-sets an existing hook at the target URL — PATCHed whole with this installation's secret, never left as found (#198)", async () => {
    // No POST route: a create attempt would throw "unexpected fetch". The PATCH is the only write, and
    // its body carries the secret: a hook that outlived a reinstall of the build plane signs with a
    // secret the new listener refuses, and GitHub never shows which secret a hook holds.
    const bodies: string[] = [];
    const fetchImpl = stubFetch({
      "GET /repos/x/acme/hooks?per_page=100&page=1": { status: 200, body: [{ id: 7, config: { url: TARGET } }] },
      "PATCH /repos/x/acme/hooks/7": { status: 200, body: { id: 7 } },
    });
    const recording = (async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "PATCH") bodies.push(String(init.body));
      return fetchImpl(url, init);
    }) as unknown as typeof fetch;
    const client = new HttpGitHubConsumer({ fetchImpl: recording });
    expect(await client.ensureHook(ensureInput)).toEqual({ created: false, id: 7, staleRemoved: 0 });
    expect(bodies).toHaveLength(1);
    expect(JSON.parse(bodies[0]!)).toEqual({ name: "web", active: true, events: ["push"], config: { url: TARGET, content_type: "json", secret: "hmac", insecure_ssl: "0" } });
  });

  it("a PATCH the PAT may not make is the same scope refusal as a create it may not make", async () => {
    const client = new HttpGitHubConsumer({ fetchImpl: stubFetch({
      "GET /repos/x/acme/hooks?per_page=100&page=1": { status: 200, body: [{ id: 7, config: { url: TARGET } }] },
      "PATCH /repos/x/acme/hooks/7": { status: 404, body: { message: "Not Found" } },
    }) });
    await expect(client.ensureHook(ensureInput)).rejects.toThrow(/cannot update a webhook .* admin:repo_hook/);
  });

  it("REPLACES a stale EventListener hook: another host on the /github path is deleted, the consumer's own hook untouched", async () => {
    const client = new HttpGitHubConsumer({ fetchImpl: stubFetch({
      "GET /repos/x/acme/hooks?per_page=100&page=1": { status: 200, body: [
        { id: 3, config: { url: "https://build.old-cluster.example/github" } }, // a previous entry point — stale
        { id: 4, config: { url: "https://ci.example.com/other" } }, // the consumer's own hook — not ours to touch
      ] },
      "DELETE /repos/x/acme/hooks/3": { status: 204 },
      "POST /repos/x/acme/hooks": { status: 201, body: { id: 99 } },
    }) });
    expect(await client.ensureHook(ensureInput)).toEqual({ created: true, id: 99, staleRemoved: 1 });
  });

  it("throws WebhookScopeError when listing hooks is refused 403 (PAT lacks admin:repo_hook)", async () => {
    const client = new HttpGitHubConsumer({ fetchImpl: stubFetch({
      "GET /repos/x/acme/hooks?per_page=100&page=1": { status: 403, body: { message: "Resource not accessible by personal access token" } },
    }) });
    await expect(client.ensureHook(ensureInput)).rejects.toThrow(WebhookScopeError);
    await expect(client.ensureHook(ensureInput)).rejects.toThrow(/admin:repo_hook/);
  });

  it("throws WebhookScopeError when listing hooks answers 404 (repo exists at onboard → scope hidden)", async () => {
    const client = new HttpGitHubConsumer({ fetchImpl: stubFetch({
      "GET /repos/x/acme/hooks?per_page=100&page=1": { status: 404, body: { message: "Not Found" } },
    }) });
    await expect(client.ensureHook(ensureInput)).rejects.toThrow(WebhookScopeError);
  });

  it("throws WebhookScopeError when the create is refused 403", async () => {
    const client = new HttpGitHubConsumer({ fetchImpl: stubFetch({
      "GET /repos/x/acme/hooks?per_page=100&page=1": { status: 200, body: [] },
      "POST /repos/x/acme/hooks": { status: 403, body: { message: "Resource not accessible" } },
    }) });
    await expect(client.ensureHook(ensureInput)).rejects.toThrow(WebhookScopeError);
  });

  it("sends the Bearer PAT + the push config (url/content_type/secret/insecure_ssl) in the create body", async () => {
    let seenHeaders: Record<string, string> | undefined;
    let seenBody: string | undefined;
    const capture = (async (_url: string | URL | Request, init?: RequestInit) => {
      const u = typeof _url === "string" ? _url : _url.toString();
      const key = `${init?.method ?? "GET"} ${u.replace("https://api.github.com", "")}`;
      if (key === "POST /repos/x/acme/hooks") { seenHeaders = init?.headers as Record<string, string>; seenBody = init?.body as string; }
      const routes: Record<string, { status: number; body?: unknown }> = {
        "GET /repos/x/acme/hooks?per_page=100&page=1": { status: 200, body: [] },
        "POST /repos/x/acme/hooks": { status: 201, body: { id: 5 } },
      };
      const r = routes[key];
      if (!r) throw new Error(`unexpected fetch: ${key}`);
      return { ok: r.status < 300, status: r.status, statusText: String(r.status), json: async () => r.body ?? null } as Response;
    }) as unknown as typeof fetch;
    const client = new HttpGitHubConsumer({ fetchImpl: capture });
    await client.ensureHook(ensureInput);
    expect(seenHeaders?.authorization).toBe("Bearer tkn");
    expect(seenHeaders?.["x-github-api-version"]).toBe("2022-11-28");
    expect(JSON.parse(seenBody ?? "{}")).toEqual({
      name: "web", active: true, events: ["push"],
      config: { url: TARGET, content_type: "json", secret: "hmac", insecure_ssl: "0" },
    });
  });

  it("surfaces GitHub's own message on an unexpected non-2xx (GitHubConsumerError, not a mask)", async () => {
    const client = new HttpGitHubConsumer({ fetchImpl: stubFetch({
      "GET /repos/x/acme/hooks?per_page=100&page=1": { status: 500, body: { message: "server error" } },
    }) });
    await expect(client.ensureHook(ensureInput)).rejects.toThrow(GitHubConsumerError);
    await expect(client.ensureHook(ensureInput)).rejects.toThrow(/server error/);
  });
});

describe("github-consumer adapter — deleteHook", () => {
  it("deletes every hook on the EventListener path — including one left at another host", async () => {
    // The middle hook is the platform's too: same /github path, an address from a time when another
    // cluster carried the build plane. Matching the current URL alone would leave it live.
    const client = new HttpGitHubConsumer({ fetchImpl: stubFetch({
      "GET /repos/x/acme/hooks?per_page=100&page=1": { status: 200, body: [
        { id: 1, config: { url: TARGET } },
        { id: 2, config: { url: "https://build.old.example/github" } },
        { id: 3, config: { url: "https://ci.example/notify" } },
      ] },
      "DELETE /repos/x/acme/hooks/1": { status: 204 },
      "DELETE /repos/x/acme/hooks/2": { status: 204 },
    }) });
    expect(await client.deleteHook({ owner: "x", repo: "acme", token: "tkn" })).toEqual({
      deleted: 2,
      urls: [TARGET, "https://build.old.example/github"],
    });
  });

  it("is a no-op when the repo carries no hook on that path (deleted:0, no DELETE issued)", async () => {
    // No DELETE route: an attempt would throw "unexpected fetch".
    const client = new HttpGitHubConsumer({ fetchImpl: stubFetch({
      "GET /repos/x/acme/hooks?per_page=100&page=1": { status: 200, body: [{ id: 9, config: { url: "https://other/notify" } }] },
    }) });
    expect(await client.deleteHook({ owner: "x", repo: "acme", token: "tkn" })).toEqual({ deleted: 0, urls: [] });
  });

  it("tolerates a 404 repo on listing → {deleted:0} (repo/hooks already gone)", async () => {
    const client = new HttpGitHubConsumer({ fetchImpl: stubFetch({
      "GET /repos/x/acme/hooks?per_page=100&page=1": { status: 404, body: { message: "Not Found" } },
    }) });
    expect(await client.deleteHook({ owner: "x", repo: "acme", token: "tkn" })).toEqual({ deleted: 0, urls: [] });
  });

  it("tolerates a 404 on the DELETE itself (the hook was already removed)", async () => {
    const client = new HttpGitHubConsumer({ fetchImpl: stubFetch({
      "GET /repos/x/acme/hooks?per_page=100&page=1": { status: 200, body: [{ id: 1, config: { url: TARGET } }] },
      "DELETE /repos/x/acme/hooks/1": { status: 404, body: { message: "Not Found" } },
    }) });
    expect(await client.deleteHook({ owner: "x", repo: "acme", token: "tkn" })).toEqual({ deleted: 0, urls: [] });
  });

  it("throws WebhookScopeError when the DELETE is refused 403", async () => {
    const client = new HttpGitHubConsumer({ fetchImpl: stubFetch({
      "GET /repos/x/acme/hooks?per_page=100&page=1": { status: 200, body: [{ id: 1, config: { url: TARGET } }] },
      "DELETE /repos/x/acme/hooks/1": { status: 403, body: { message: "forbidden" } },
    }) });
    await expect(client.deleteHook({ owner: "x", repo: "acme", token: "tkn" })).rejects.toThrow(WebhookScopeError);
  });
});

// A fetch stub that also carries RESPONSE HEADERS (X-OAuth-Scopes) — readTokenScopes reads them.
function stubFetchWithHeaders(routes: Record<string, { status: number; headers?: Record<string, string>; body?: unknown }>): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === "string" ? url : url.toString();
    const key = `${init?.method ?? "GET"} ${u.replace("https://api.github.com", "")}`;
    const r = routes[key];
    if (!r) throw new Error(`unexpected fetch: ${key}`);
    return {
      ok: r.status >= 200 && r.status < 300, status: r.status, statusText: String(r.status),
      headers: new Headers(r.headers ?? {}), json: async () => r.body ?? null,
    } as Response;
  }) as unknown as typeof fetch;
}

describe("github-consumer adapter — readOrgToken, one read that measures a token against an owner (#219)", () => {
  const PATH = "GET /orgs/acme-org/packages?package_type=npm&per_page=1";
  it("answers reads on 200 with the classic scopes off the header; unreadable on 403, absent on 404, invalid on 401 — fine-grained where the header is absent", async () => {
    const reads = new HttpGitHubConsumer({ fetchImpl: stubFetchWithHeaders({ [PATH]: { status: 200, headers: { "x-oauth-scopes": "repo, read:packages" }, body: [] } }) });
    expect(await reads.readOrgToken({ org: "acme-org", token: "ghp_x" })).toEqual({ classic: true, scopes: ["repo", "read:packages"], packages: "reads" });
    for (const [status, packages] of [[403, "unreadable"], [404, "absent"], [401, "invalid"]] as const) {
      const c = new HttpGitHubConsumer({ fetchImpl: stubFetchWithHeaders({ [PATH]: { status, body: { message: "x" } } }) });
      expect(await c.readOrgToken({ org: "acme-org", token: "github_pat_y" })).toEqual({ classic: false, scopes: [], packages });
    }
    const other = new HttpGitHubConsumer({ fetchImpl: stubFetchWithHeaders({ [PATH]: { status: 500, body: { message: "boom" } } }) });
    await expect(other.readOrgToken({ org: "acme-org", token: "ghp_x" })).rejects.toThrow(GitHubConsumerError);
  });
});

describe("github-consumer adapter — readTokenScopes", () => {
  it("parses the granted classic scopes off X-OAuth-Scopes", async () => {
    const client = new HttpGitHubConsumer({ fetchImpl: stubFetchWithHeaders({
      "GET /repos/x/acme": { status: 200, headers: { "x-oauth-scopes": "repo, workflow, admin:repo_hook" }, body: { id: 1 } },
    }) });
    expect(await client.readTokenScopes({ owner: "x", repo: "acme", token: "tkn" })).toEqual({ classic: true, scopes: ["repo", "workflow", "admin:repo_hook"] });
  });

  it("returns {classic:false} for a fine-grained token (no scope header on a 2xx)", async () => {
    const client = new HttpGitHubConsumer({ fetchImpl: stubFetchWithHeaders({
      "GET /repos/x/acme": { status: 200, body: { id: 1 } },
    }) });
    expect(await client.readTokenScopes({ owner: "x", repo: "acme", token: "tkn" })).toEqual({ classic: false, scopes: [] });
  });

  it("reads scopes even on a 404 (an authenticated classic PAT that cannot see the repo)", async () => {
    const client = new HttpGitHubConsumer({ fetchImpl: stubFetchWithHeaders({
      "GET /repos/x/acme": { status: 404, headers: { "x-oauth-scopes": "repo" }, body: { message: "Not Found" } },
    }) });
    expect(await client.readTokenScopes({ owner: "x", repo: "acme", token: "tkn" })).toEqual({ classic: true, scopes: ["repo"] });
  });

  it("treats an empty X-OAuth-Scopes string as a classic PAT with no scopes", async () => {
    const client = new HttpGitHubConsumer({ fetchImpl: stubFetchWithHeaders({
      "GET /repos/x/acme": { status: 200, headers: { "x-oauth-scopes": "" }, body: { id: 1 } },
    }) });
    expect(await client.readTokenScopes({ owner: "x", repo: "acme", token: "tkn" })).toEqual({ classic: true, scopes: [] });
  });

  it("throws WebhookScopeError on 401 (the PAT is invalid/expired)", async () => {
    const client = new HttpGitHubConsumer({ fetchImpl: stubFetchWithHeaders({
      "GET /repos/x/acme": { status: 401, body: { message: "Bad credentials" } },
    }) });
    await expect(client.readTokenScopes({ owner: "x", repo: "acme", token: "tkn" })).rejects.toThrow(WebhookScopeError);
    await expect(client.readTokenScopes({ owner: "x", repo: "acme", token: "tkn" })).rejects.toThrow(/invalid or expired/);
  });

  it("surfaces GitHub's message on an unexpected non-2xx with no scope header (GitHubConsumerError)", async () => {
    const client = new HttpGitHubConsumer({ fetchImpl: stubFetchWithHeaders({
      "GET /repos/x/acme": { status: 500, body: { message: "server error" } },
    }) });
    await expect(client.readTokenScopes({ owner: "x", repo: "acme", token: "tkn" })).rejects.toThrow(GitHubConsumerError);
    await expect(client.readTokenScopes({ owner: "x", repo: "acme", token: "tkn" })).rejects.toThrow(/server error/);
  });
});

describe("github-consumer adapter — the release workflow (dispatch)", () => {
  const stub204 = (path: string) => (async (url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === "string" ? url : url.toString();
    const key = `${init?.method ?? "GET"} ${u.replace("https://api.github.com", "")}`;
    if (key !== path) throw new Error(`unexpected fetch: ${key}`);
    return { ok: true, status: 204, statusText: "204", json: async () => null } as Response;
  }) as unknown as typeof fetch;

  it("dispatches the workflow with {ref, inputs} and accepts the bodyless 204", async () => {
    const client = new HttpGitHubConsumer({ fetchImpl: stub204("POST /repos/x/acme/actions/workflows/release.yml/dispatches") });
    await client.dispatchWorkflow({ owner: "x", repo: "acme", token: "tkn", workflowFile: "release.yml", ref: "main", inputs: { version: "1.0.0", channel: "stable", stage: "prod" } });
  });

  it("throws the RETRYABLE WorkflowNotFoundError on 404 (the just-committed workflow is not indexed yet)", async () => {
    const client = new HttpGitHubConsumer({ fetchImpl: stubFetch({
      "POST /repos/x/acme/actions/workflows/release.yml/dispatches": { status: 404, body: { message: "Not Found" } },
    }) });
    await expect(client.dispatchWorkflow({ owner: "x", repo: "acme", token: "tkn", workflowFile: "release.yml", ref: "main", inputs: {} })).rejects.toThrow(WorkflowNotFoundError);
  });

  it("surfaces GitHub's own message on a 422 (an old kit's workflow refuses the inputs) — never retried as a 404", async () => {
    const client = new HttpGitHubConsumer({ fetchImpl: stubFetch({
      "POST /repos/x/acme/actions/workflows/release.yml/dispatches": { status: 422, body: { message: "Unexpected inputs provided" } },
    }) });
    const err = client.dispatchWorkflow({ owner: "x", repo: "acme", token: "tkn", workflowFile: "release.yml", ref: "main", inputs: {} });
    await expect(err).rejects.toThrow(GitHubConsumerError);
    await expect(client.dispatchWorkflow({ owner: "x", repo: "acme", token: "tkn", workflowFile: "release.yml", ref: "main", inputs: {} })).rejects.toThrow(/422: Unexpected inputs provided/);
  });

  it("resolves the repo's default branch off GET /repos", async () => {
    const client = new HttpGitHubConsumer({ fetchImpl: stubFetch({
      "GET /repos/x/acme": { status: 200, body: { default_branch: "master" } },
    }) });
    expect(await client.getDefaultBranch({ owner: "x", repo: "acme", token: "tkn" })).toBe("master");
  });
});

describe("github-consumer adapter — listReleaseTags", () => {
  it("walks every page of /tags and returns the names", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ name: `0.1.${i}-stable-20260901000000` }));
    const client = new HttpGitHubConsumer({ fetchImpl: stubFetch({
      "GET /repos/x/acme/tags?per_page=100&page=1": { status: 200, body: page1 },
      "GET /repos/x/acme/tags?per_page=100&page=2": { status: 200, body: [{ name: "v2" }] },
    }) });
    const names = await client.listReleaseTags({ owner: "x", repo: "acme", token: "tkn" });
    expect(names).toHaveLength(101);
    expect(names.at(-1)).toBe("v2");
  });

  it("throws GitHubConsumerError with GitHub's own message on a non-2xx", async () => {
    const client = new HttpGitHubConsumer({ fetchImpl: stubFetch({
      "GET /repos/x/acme/tags?per_page=100&page=1": { status: 403, body: { message: "Resource not accessible" } },
    }) });
    await expect(client.listReleaseTags({ owner: "x", repo: "acme", token: "tkn" })).rejects.toThrow(/403: Resource not accessible/);
  });
});

describe("github-consumer adapter — readTokenAccess (#252)", () => {
  it("answers the token's account, the owner's kind, and its highest right on the repository; one it cannot see is none", async () => {
    const client = new HttpGitHubConsumer({ fetchImpl: stubFetch({
      "GET /user": { status: 200, body: { login: "acme-operator" } },
      "GET /users/acme-owner": { status: 200, body: { login: "acme-owner", type: "User" } },
      "GET /repos/acme-owner/shop": { status: 200, body: { permissions: { admin: false, maintain: false, push: true, triage: true, pull: true } } },
      "GET /repos/acme-owner/hidden": { status: 404, body: { message: "Not Found" } },
    }) });
    expect(await client.readTokenAccess({ owner: "acme-owner", token: "tkn" })).toEqual({ login: "acme-operator", ownerKind: "User" });
    expect(await client.readTokenAccess({ owner: "acme-owner", repo: "shop", token: "tkn" })).toEqual({ login: "acme-operator", ownerKind: "User", permission: "push" });
    expect(await client.readTokenAccess({ owner: "acme-owner", repo: "hidden", token: "tkn" })).toEqual({ login: "acme-operator", ownerKind: "User", permission: "none" });
  });
});
