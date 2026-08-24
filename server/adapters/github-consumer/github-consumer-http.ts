// The concrete GitHub consumer client (fetch, no SDK — same rationale as github.ts: a trivial
// dependency surface). PER-CALL PAT: every method takes the consumer's token + owner/repo, so ONE
// instance (constructed in boot/wire-units.ts) serves every consumer. Mirrors github.ts's
// request/header/error style (Bearer, x-github-api-version, user-agent) but is a SEPARATE client — the
// github.ts one is platform-repo/single-token scoped and has no hook or workflow methods.
import type {
  GitHubConsumer, EnsureHookInput, EnsureHookResult, DeleteHookInput, DeleteHookResult, TokenScopes,
  DispatchWorkflowInput, ListWorkflowRunsInput, WorkflowRunSummary,
} from "./port.ts";
import { WebhookScopeError, WorkflowNotFoundError, GitHubConsumerError, targetsEventListener } from "./port.ts";

type FetchLike = typeof fetch;

/** One repo hook as GitHub returns it — only the fields this adapter reads (id + config.url). */
interface RepoHook {
  id: number;
  config?: { url?: string };
}

/** One workflow run as GitHub returns it — only the fields the release watch reads. */
interface ApiWorkflowRun {
  id: number;
  display_title?: string;
  status?: string;
  conclusion?: string | null;
  created_at?: string;
  html_url?: string;
}

function toSummary(r: ApiWorkflowRun): WorkflowRunSummary {
  return {
    id: r.id,
    displayTitle: r.display_title ?? "",
    status: r.status ?? "",
    conclusion: r.conclusion ?? null,
    createdAt: r.created_at ?? "",
    htmlUrl: r.html_url ?? "",
  };
}

export class HttpGitHubConsumer implements GitHubConsumer {
  private readonly apiBase: string;
  private readonly fetchImpl: FetchLike;

  /** `fetchImpl` is injectable so tests never hit the network. */
  constructor(opts: { apiBase?: string; fetchImpl?: FetchLike } = {}) {
    this.apiBase = (opts.apiBase ?? "https://api.github.com").replace(/\/$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private repoPath(owner: string, repo: string): string {
    return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  }

  /** The per-call auth + version headers. The token rides ONLY here (the Bearer header) — never a URL,
   *  a body field, or a log line. */
  private headers(token: string): Record<string, string> {
    return {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "hostyour-manager",
    };
  }

  /** Thin fetch wrapper: merges the auth headers over any caller headers (auth ALWAYS wins) and turns a
   *  transport error into a GitHubConsumerError. It does NOT throw on a non-2xx — each method inspects
   *  the status itself, because a 403/404 on /hooks is the load-bearing "missing scope" signal and a
   *  404 on the dispatch endpoint is the retryable not-yet-indexed one. */
  private async send(token: string, path: string, init: RequestInit | undefined): Promise<Response> {
    try {
      return await this.fetchImpl(`${this.apiBase}${path}`, { ...init, headers: { ...(init?.headers ?? {}), ...this.headers(token) } });
    } catch (e) {
      throw new GitHubConsumerError(`GitHub request failed (${path}): ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Read GitHub's own error message off a non-2xx body (never a generic mask). */
  private static async ghMessage(res: Response): Promise<string> {
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    return body?.message ?? res.statusText;
  }

  /** List every hook on the repo (paginated). `on404` decides how a 404 is read: onboard (create)
   *  treats it as the missing-scope refusal (the repo provably exists — it was just cloned + validated),
   *  while offboard/purge (delete) treats it as "repo/hooks gone → nothing to remove". A 403 is always a
   *  scope refusal. */
  private async listHooks(input: { owner: string; repo: string; token: string; signal?: AbortSignal }, on404: "scope" | "empty"): Promise<RepoHook[]> {
    const base = this.repoPath(input.owner, input.repo);
    const out: RepoHook[] = [];
    for (let page = 1; page <= 20; page++) {
      const res = await this.send(input.token, `${base}/hooks?per_page=100&page=${page}`, input.signal ? { signal: input.signal } : undefined);
      if (res.status === 403 || (res.status === 404 && on404 === "scope")) {
        throw new WebhookScopeError(`the consumer PAT cannot list webhooks on ${input.owner}/${input.repo} (HTTP ${res.status}) — it needs the admin:repo_hook scope`, res.status);
      }
      if (res.status === 404) return out; // delete path: the repo/hooks are gone → nothing to remove
      if (!res.ok) throw new GitHubConsumerError(`GitHub GET ${base}/hooks → ${res.status}: ${await HttpGitHubConsumer.ghMessage(res)}`, res.status);
      const rows = (await res.json()) as RepoHook[];
      for (const h of rows) out.push(h);
      if (rows.length < 100) break; // last page
    }
    return out;
  }

  async readTokenScopes(input: { owner: string; repo: string; token: string; signal?: AbortSignal }): Promise<TokenScopes> {
    const base = this.repoPath(input.owner, input.repo);
    const res = await this.send(input.token, base, input.signal ? { signal: input.signal } : undefined);
    // A 401 means the token ITSELF is bad (invalid/expired/revoked) — a clear, actionable failure that
    // is distinct from "authenticated but missing a scope".
    if (res.status === 401) {
      throw new WebhookScopeError(`the consumer PAT is invalid or expired (GitHub answered HTTP 401 on ${base})`, 401);
    }
    // GitHub returns X-OAuth-Scopes on ANY authenticated CLASSIC-PAT request — including a 404 (a token
    // that authenticated but cannot see the repo). A fine-grained token authenticates but omits it, so a
    // null header on an authenticated (2xx/404) response means "not a classic PAT".
    const header = res.headers.get("x-oauth-scopes");
    if (header === null) {
      if ((res.status >= 200 && res.status < 300) || res.status === 404) return { classic: false, scopes: [] };
      throw new GitHubConsumerError(`GitHub GET ${base} → ${res.status}: ${await HttpGitHubConsumer.ghMessage(res)}`, res.status);
    }
    return { classic: true, scopes: header.split(",").map((s) => s.trim()).filter(Boolean) };
  }

  async ensureHook(input: EnsureHookInput): Promise<EnsureHookResult> {
    const existing = await this.listHooks(input, "scope");
    const base = this.repoPath(input.owner, input.repo);
    // The replace half: a hook on the EventListener path whose URL is not the CURRENT target is a
    // stale entry point from an earlier onboarding — left in place it fires into nothing, so it is
    // deleted BEFORE the current hook is ensured. A 404 on the delete is "already gone" (benign).
    let staleRemoved = 0;
    for (const h of existing) {
      const url = h.config?.url ?? "";
      if (url === input.targetUrl || !targetsEventListener(url)) continue;
      const res = await this.send(input.token, `${base}/hooks/${h.id}`, { method: "DELETE", ...(input.signal ? { signal: input.signal } : {}) });
      if (res.status === 403) throw new WebhookScopeError(`the consumer PAT cannot delete stale webhook ${h.id} on ${input.owner}/${input.repo} (HTTP 403) — it needs the admin:repo_hook scope`, 403);
      if (res.ok) { staleRemoved++; continue; }
      if (res.status !== 404) throw new GitHubConsumerError(`GitHub DELETE ${base}/hooks/${h.id} → ${res.status}: ${await HttpGitHubConsumer.ghMessage(res)}`, res.status);
    }
    const match = existing.find((h) => h.config?.url === input.targetUrl);
    if (match) return { created: false, id: match.id, staleRemoved };
    const res = await this.send(input.token, `${base}/hooks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "web",
        active: true,
        events: input.events,
        config: { url: input.targetUrl, content_type: input.contentType, secret: input.secret, insecure_ssl: "0" },
      }),
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (res.status === 403 || res.status === 404) {
      throw new WebhookScopeError(`the consumer PAT cannot create a webhook on ${input.owner}/${input.repo} (HTTP ${res.status}) — it needs the admin:repo_hook scope`, res.status);
    }
    if (!res.ok) throw new GitHubConsumerError(`GitHub POST ${base}/hooks → ${res.status}: ${await HttpGitHubConsumer.ghMessage(res)}`, res.status);
    const created = (await res.json()) as { id: number };
    return { created: true, id: created.id, staleRemoved };
  }

  async deleteHook(input: DeleteHookInput): Promise<DeleteHookResult> {
    const existing = await this.listHooks(input, "empty");
    // Matched by the EventListener PATH, on any host — the platform signature, the same one the stale
    // sweep uses. A hook created while another cluster carried the build plane is still this
    // platform's, and this removal is the last chance anything has to take it away.
    const matches = existing.filter((h) => targetsEventListener(h.config?.url ?? ""));
    const base = this.repoPath(input.owner, input.repo);
    const urls: string[] = [];
    for (const h of matches) {
      const res = await this.send(input.token, `${base}/hooks/${h.id}`, { method: "DELETE", ...(input.signal ? { signal: input.signal } : {}) });
      // 204 = deleted; 404 = already gone (idempotent); 403 = scope refusal; anything else is a real fault.
      if (res.status === 403) throw new WebhookScopeError(`the consumer PAT cannot delete webhook ${h.id} on ${input.owner}/${input.repo} (HTTP 403) — it needs the admin:repo_hook scope`, 403);
      if (res.ok) { urls.push(h.config?.url ?? ""); continue; }
      if (res.status !== 404) throw new GitHubConsumerError(`GitHub DELETE ${base}/hooks/${h.id} → ${res.status}: ${await HttpGitHubConsumer.ghMessage(res)}`, res.status);
    }
    return { deleted: urls.length, urls };
  }

  async getDefaultBranch(input: { owner: string; repo: string; token: string; signal?: AbortSignal }): Promise<string> {
    const base = this.repoPath(input.owner, input.repo);
    const res = await this.send(input.token, base, input.signal ? { signal: input.signal } : undefined);
    if (!res.ok) throw new GitHubConsumerError(`GitHub GET ${base} → ${res.status}: ${await HttpGitHubConsumer.ghMessage(res)}`, res.status);
    const body = (await res.json()) as { default_branch?: string };
    if (!body.default_branch) throw new GitHubConsumerError(`GitHub GET ${base} returned no default_branch`);
    return body.default_branch;
  }

  async dispatchWorkflow(input: DispatchWorkflowInput): Promise<void> {
    const base = this.repoPath(input.owner, input.repo);
    const path = `${base}/actions/workflows/${encodeURIComponent(input.workflowFile)}/dispatches`;
    const res = await this.send(input.token, path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ref: input.ref, inputs: input.inputs }),
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (res.status === 204) return;
    const message = await HttpGitHubConsumer.ghMessage(res);
    if (res.status === 404) {
      throw new WorkflowNotFoundError(`GitHub does not (yet) know the workflow ${input.workflowFile} on ${input.owner}/${input.repo} (HTTP 404: ${message})`);
    }
    throw new GitHubConsumerError(`GitHub POST ${path} → ${res.status}: ${message}`, res.status);
  }

  async listWorkflowRuns(input: ListWorkflowRunsInput): Promise<WorkflowRunSummary[]> {
    const base = this.repoPath(input.owner, input.repo);
    const created = input.createdAfter ? `&created=${encodeURIComponent(`>=${input.createdAfter}`)}` : "";
    const path = `${base}/actions/workflows/${encodeURIComponent(input.workflowFile)}/runs?event=workflow_dispatch&per_page=100${created}`;
    const res = await this.send(input.token, path, input.signal ? { signal: input.signal } : undefined);
    if (!res.ok) throw new GitHubConsumerError(`GitHub GET ${path} → ${res.status}: ${await HttpGitHubConsumer.ghMessage(res)}`, res.status);
    const body = (await res.json()) as { workflow_runs?: ApiWorkflowRun[] };
    return (body.workflow_runs ?? []).map(toSummary);
  }

  async getWorkflowRun(input: { owner: string; repo: string; token: string; runId: number; signal?: AbortSignal }): Promise<WorkflowRunSummary> {
    const base = this.repoPath(input.owner, input.repo);
    const path = `${base}/actions/runs/${input.runId}`;
    const res = await this.send(input.token, path, input.signal ? { signal: input.signal } : undefined);
    if (!res.ok) throw new GitHubConsumerError(`GitHub GET ${path} → ${res.status}: ${await HttpGitHubConsumer.ghMessage(res)}`, res.status);
    return toSummary((await res.json()) as ApiWorkflowRun);
  }
}
