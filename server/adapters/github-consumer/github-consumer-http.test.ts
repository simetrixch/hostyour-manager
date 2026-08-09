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

  it("is idempotent — an existing hook at the target URL is returned as {created:false} (no POST)", async () => {
    // No POST route: a create attempt would throw "unexpected fetch", proving the adapter did not create.
    const client = new HttpGitHubConsumer({ fetchImpl: stubFetch({
      "GET /repos/x/acme/hooks?per_page=100&page=1": { status: 200, body: [{ id: 7, config: { url: TARGET } }] },
    }) });
    expect(await client.ensureHook(ensureInput)).toEqual({ created: false, id: 7, staleRemoved: 0 });
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

describe("github-consumer adapter — the release workflow (dispatch + runs)", () => {
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

  it("lists the workflow runs with the created>= window and maps GitHub's fields to the summary shape", async () => {
    const created = encodeURIComponent(">=2026-07-28T10:00:00.000Z");
    const client = new HttpGitHubConsumer({ fetchImpl: stubFetch({
      [`GET /repos/x/acme/actions/workflows/release.yml/runs?event=workflow_dispatch&per_page=100&created=${created}`]: {
        status: 200,
        body: { workflow_runs: [{ id: 12, display_title: "Release 1.0.0-stable", status: "completed", conclusion: "success", created_at: "2026-07-28T10:00:05Z", html_url: "https://github.com/x/acme/actions/runs/12" }] },
      },
    }) });
    expect(await client.listWorkflowRuns({ owner: "x", repo: "acme", token: "tkn", workflowFile: "release.yml", createdAfter: "2026-07-28T10:00:00.000Z" })).toEqual([
      { id: 12, displayTitle: "Release 1.0.0-stable", status: "completed", conclusion: "success", createdAt: "2026-07-28T10:00:05Z", htmlUrl: "https://github.com/x/acme/actions/runs/12" },
    ]);
  });

  it("gets one run by id and resolves the repo's default branch off GET /repos", async () => {
    const client = new HttpGitHubConsumer({ fetchImpl: stubFetch({
      "GET /repos/x/acme/actions/runs/12": { status: 200, body: { id: 12, display_title: "Release 1.0.0-stable", status: "in_progress", conclusion: null, created_at: "t", html_url: "u" } },
      "GET /repos/x/acme": { status: 200, body: { default_branch: "master" } },
    }) });
    expect((await client.getWorkflowRun({ owner: "x", repo: "acme", token: "tkn", runId: 12 })).status).toBe("in_progress");
    expect(await client.getDefaultBranch({ owner: "x", repo: "acme", token: "tkn" })).toBe("master");
  });
});
