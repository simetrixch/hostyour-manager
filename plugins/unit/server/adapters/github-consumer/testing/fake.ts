// In-memory GitHubConsumer fake for the onboarding domain tests — no network. Keeps a per-repo hook
// store so ensureHook is genuinely replacing (a stale EventListener hook is deleted, the current one
// kept or created), records every create/delete so a test can assert onboard created the push-hook
// (and offboard/purge removed it), and simulates the release workflow: a dispatch appends a run whose
// status/conclusion the test scripts, so the trigger + watch steps run against the same correlation
// contract the HTTP client answers.
import type {
  GitHubConsumer, EnsureHookInput, EnsureHookResult, DeleteHookInput, DeleteHookResult, TokenScopes,
  DispatchWorkflowInput, DispatchedWorkflowRun, WorkflowRunReading, OrgTokenReading, TokenAccess, RepoPermission, RepositoryTag, BranchCommit,
} from "../port.ts";
import { WebhookScopeError, WorkflowNotFoundError, GitHubConsumerError, targetsEventListener } from "../port.ts";

interface StoredHook {
  id: number;
  targetUrl: string;
  secret: string;
  events: string[];
  contentType: string;
}

/** A recorded create (only the calls that actually created a hook — not the idempotent-skip calls). */
export interface CreatedHookRecord {
  owner: string;
  repo: string;
  token: string;
  targetUrl: string;
  secret: string;
  events: string[];
  contentType: string;
  id: number;
}

/** A recorded delete call + the hook ids it removed. No target URL: the removal matches the
 *  EventListener path, not one address. */
export interface DeletedHookRecord {
  owner: string;
  repo: string;
  token: string;
  ids: number[];
}

export class FakeGitHubConsumer implements GitHubConsumer {
  /** owner/repo -> its hooks. */
  private readonly hooks = new Map<string, StoredHook[]>();
  private nextId = 1;
  readonly created: CreatedHookRecord[] = [];
  readonly deletedCalls: DeletedHookRecord[] = [];
  /** When true, ensureHook + deleteHook throw WebhookScopeError (the PAT lacks admin:repo_hook). */
  scopeError = false;
  /** What readTokenScopes returns — default: a classic PAT with all three required scopes present. A
   *  preflight-scopes test overrides this to drive the missing-scope / fine-grained paths. */
  tokenScopes: TokenScopes = { classic: true, scopes: ["repo", "workflow", "admin:repo_hook", "read:packages"] };
  /** When true, readTokenScopes throws WebhookScopeError (the PAT is invalid/expired — a 401). */
  tokenInvalid = false;
  /** "@scope/name" → the tokens that may read it; a package not seeded answers "absent", one seeded
   *  and asked with another token "unreadable" (readPackage). */
  readonly packages = new Map<string, string[]>();
  /** org → the tokens that read its packages (readOrgToken answers "reads" for them, "unreadable"
   *  for any other token of a seeded owner, "absent" for an owner not seeded);
   *  `tokenInvalid` answers "invalid". The scopes half is `tokenScopes`, as readTokenScopes. */
  readonly orgPackageReaders = new Map<string, string[]>();
  /** Every owner readOrgToken was asked about, with the token — a test asserts the measurement. */
  readonly orgReads: { org: string; token: string }[] = [];

  /** What readTokenAccess answers (#252): the token's account and the owner's kind, and the right
   *  on any repository named. Default: an organisation's admin, which every measurement passes. */
  tokenAccess: { login: string; ownerKind: "User" | "Organization"; repoPermission: RepoPermission } = { login: "operator", ownerKind: "Organization", repoPermission: "admin" };

  async readTokenAccess(input: { owner: string; repo?: string; token: string }): Promise<TokenAccess> {
    const { login, ownerKind, repoPermission } = this.tokenAccess;
    return input.repo === undefined ? { login, ownerKind } : { login, ownerKind, permission: repoPermission };
  }

  async readOrgToken(input: { org: string; token: string }): Promise<OrgTokenReading> {
    this.orgReads.push({ org: input.org, token: input.token });
    if (this.tokenInvalid) return { ...this.tokenScopes, packages: "invalid" };
    const readers = this.orgPackageReaders.get(input.org);
    if (readers === undefined) return { ...this.tokenScopes, packages: "absent" };
    return { ...this.tokenScopes, packages: readers.includes(input.token) ? "reads" : "unreadable" };
  }

  // ---- the release trigger (trigger-release) ----
  /** Every dispatch call, in order — a test asserts the trigger fired once with {version, channel,
   *  stage} and against which workflow file. */
  readonly dispatches: DispatchWorkflowInput[] = [];
  /** How many dispatch calls answer 404 (WorkflowNotFoundError) before one succeeds — the
   *  just-committed-workflow indexing lag the trigger step retries through. */
  dispatchNotFoundTimes = 0;
  /** When set, every dispatch throws GitHubConsumerError with this message + status — the 422/403
   *  surface-GitHub's-own-message path. */
  dispatchRefusal: { status: number; message: string } | null = null;
  /** False makes a dispatch answer GitHub's bodyless 204, which names no run. */
  answersRunDetails = true;
  /** What readWorkflowRun answers for every run a dispatch created. */
  dispatchedRun: Omit<WorkflowRunReading, "htmlUrl"> = { status: "completed", conclusion: "success" };

  /** owner/repo -> the tags listReleaseTags answers; unseeded repos answer none. */
  private readonly tags = new Map<string, RepositoryTag[]>();
  /** owner/repo/branch -> the commit readBranchCommit answers; an unseeded branch answers null. */
  private readonly branches = new Map<string, BranchCommit>();
  /** owner/repo/path -> the text readFile answers; an unseeded path answers null (no such file). */
  private readonly files = new Map<string, string>();
  /** owner/repo@ref/path -> the text readFile answers for a specific ref (null means absent on that ref). */
  private readonly filesByRef = new Map<string, string | null>();
  /** Every readFile call, recording the ref it was asked for. */
  readonly fileReads: Array<{ owner: string; repo: string; path: string; ref?: string }> = [];

  seedFile(owner: string, repo: string, path: string, text: string | null, ref?: string): void {
    if (ref !== undefined) {
      this.filesByRef.set(`${this.key(owner, repo)}@${ref}/${path}`, text);
    } else {
      if (text === null) {
        this.files.delete(`${this.key(owner, repo)}/${path}`);
      } else {
        this.files.set(`${this.key(owner, repo)}/${path}`, text);
      }
    }
  }

  async readFile(input: { owner: string; repo: string; path: string; token: string; ref?: string; signal?: AbortSignal }): Promise<string | null> {
    this.fileReads.push({ owner: input.owner, repo: input.repo, path: input.path, ...(input.ref !== undefined ? { ref: input.ref } : {}) });
    if (input.ref !== undefined) {
      const refKey = `${this.key(input.owner, input.repo)}@${input.ref}/${input.path}`;
      if (this.filesByRef.has(refKey)) {
        return this.filesByRef.get(refKey)!;
      }
    }
    return this.files.get(`${this.key(input.owner, input.repo)}/${input.path}`) ?? null;
  }
  /** Every listReleaseTags call, so a test can assert which repositories the next-version read spanned. */
  readonly tagReads: Array<{ owner: string; repo: string }> = [];
  /** The token each tag listing was made with — the identity the read ran under. */
  readonly tokensSeen: string[] = [];

  /** A tag seeded by its name alone names no commit a test cares about. */
  seedTags(owner: string, repo: string, tags: readonly (string | RepositoryTag)[]): void {
    this.tags.set(this.key(owner, repo), tags.map((t) => (typeof t === "string" ? { name: t, commit: "" } : t)));
  }

  seedBranch(owner: string, repo: string, branch: string, commit: BranchCommit): void {
    this.branches.set(`${this.key(owner, repo)}/${branch}`, commit);
  }

  async readBranchCommit(input: { owner: string; repo: string; branch: string; token: string; signal?: AbortSignal }): Promise<BranchCommit | null> {
    return this.branches.get(`${this.key(input.owner, input.repo)}/${input.branch}`) ?? null;
  }

  /** Every deleteBranch call, as owner/repo/branch, and the token each was made with. */
  readonly deletedBranches: string[] = [];
  readonly deleteTokens: string[] = [];
  async deleteBranch(input: { owner: string; repo: string; branch: string; token: string; signal?: AbortSignal }): Promise<void> {
    const key = `${this.key(input.owner, input.repo)}/${input.branch}`;
    this.deletedBranches.push(key);
    this.deleteTokens.push(input.token);
    this.branches.delete(key);
  }

  async hookStandsAt(input: { owner: string; repo: string; token: string; targetUrl: string }): Promise<boolean> {
    if (this.scopeError) throw new WebhookScopeError(`fake: the PAT cannot list webhooks on ${input.owner}/${input.repo}`, 403);
    this.tokensSeen.push(input.token);
    return (this.hooks.get(this.key(input.owner, input.repo)) ?? []).some((h) => h.targetUrl === input.targetUrl);
  }

  async readPackage(input: { scope: string; name: string; token: string }): Promise<"readable" | "unreadable" | "absent"> {
    const readers = this.packages.get(`@${input.scope}/${input.name}`);
    if (!readers) return "absent";
    return readers.includes(input.token) ? "readable" : "unreadable";
  }

  async listReleaseTags(input: { owner: string; repo: string; token: string; signal?: AbortSignal }): Promise<RepositoryTag[]> {
    this.tagReads.push({ owner: input.owner, repo: input.repo });
    this.tokensSeen.push(input.token);
    return [...(this.tags.get(this.key(input.owner, input.repo)) ?? [])];
  }

  private key(owner: string, repo: string): string {
    return `${owner}/${repo}`;
  }

  async readTokenScopes(input: { owner: string; repo: string; token: string; signal?: AbortSignal }): Promise<TokenScopes> {
    this.tokensSeen.push(input.token);
    if (this.tokenInvalid) throw new WebhookScopeError(`fake: the PAT is invalid on ${input.owner}/${input.repo}`, 401);
    return this.tokenScopes;
  }

  /** Pre-seed an existing hook so a test can drive the idempotent-keep and stale-replace paths.
   *  Returns the hook id. */
  seedHook(owner: string, repo: string, targetUrl: string): number {
    const id = this.nextId++;
    const list = this.hooks.get(this.key(owner, repo)) ?? [];
    list.push({ id, targetUrl, secret: "", events: ["push"], contentType: "json" });
    this.hooks.set(this.key(owner, repo), list);
    return id;
  }

  /** The hooks currently present on a repo (test assertion helper). */
  hooksFor(owner: string, repo: string): ReadonlyArray<{ id: number; targetUrl: string; secret: string; events: string[] }> {
    return (this.hooks.get(this.key(owner, repo)) ?? []).map((h) => ({ id: h.id, targetUrl: h.targetUrl, secret: h.secret, events: h.events }));
  }

  async ensureHook(input: EnsureHookInput): Promise<EnsureHookResult> {
    if (this.scopeError) throw new WebhookScopeError(`fake: the PAT lacks admin:repo_hook on ${input.owner}/${input.repo}`, 403);
    const list = this.hooks.get(this.key(input.owner, input.repo)) ?? [];
    // The replace half of the contract: stale EventListener hooks go first (same rule as the HTTP client).
    const stale = list.filter((h) => h.targetUrl !== input.targetUrl && targetsEventListener(h.targetUrl));
    const kept = list.filter((h) => !stale.includes(h));
    const match = kept.find((h) => h.targetUrl === input.targetUrl);
    if (match) {
      // Re-set whole, as the HTTP client PATCHes it: the secret and the events are this
      // installation's from here on, whatever the hook carried before (#198).
      match.secret = input.secret;
      match.events = input.events;
      match.contentType = input.contentType;
      this.hooks.set(this.key(input.owner, input.repo), kept);
      return { created: false, id: match.id, staleRemoved: stale.length };
    }
    const id = this.nextId++;
    kept.push({ id, targetUrl: input.targetUrl, secret: input.secret, events: input.events, contentType: input.contentType });
    this.hooks.set(this.key(input.owner, input.repo), kept);
    this.created.push({
      owner: input.owner, repo: input.repo, token: input.token, targetUrl: input.targetUrl,
      secret: input.secret, events: input.events, contentType: input.contentType, id,
    });
    return { created: true, id, staleRemoved: stale.length };
  }

  async deleteHook(input: DeleteHookInput): Promise<DeleteHookResult> {
    if (this.scopeError) throw new WebhookScopeError(`fake: the PAT lacks admin:repo_hook on ${input.owner}/${input.repo}`, 403);
    const list = this.hooks.get(this.key(input.owner, input.repo)) ?? [];
    // The EventListener path on ANY host, same rule as the HTTP client — a hook left at an address
    // the platform no longer composes is still the one this removal exists to take.
    const matches = list.filter((h) => targetsEventListener(h.targetUrl));
    this.hooks.set(this.key(input.owner, input.repo), list.filter((h) => !matches.includes(h)));
    this.deletedCalls.push({ owner: input.owner, repo: input.repo, token: input.token, ids: matches.map((h) => h.id) });
    return { deleted: matches.length, urls: matches.map((h) => h.targetUrl) };
  }



  /** What getDefaultBranch answers — overridable so a test can drive a master-named repo. */
  defaultBranch = "main";

  async getDefaultBranch(): Promise<string> {
    return this.defaultBranch;
  }

  async dispatchWorkflow(input: DispatchWorkflowInput): Promise<DispatchedWorkflowRun | null> {
    if (this.dispatchNotFoundTimes > 0) {
      this.dispatchNotFoundTimes--;
      throw new WorkflowNotFoundError(`fake: workflow ${input.workflowFile} not indexed yet on ${input.owner}/${input.repo}`);
    }
    if (this.dispatchRefusal) {
      throw new GitHubConsumerError(
        `GitHub POST /repos/${input.owner}/${input.repo}/actions/workflows/${input.workflowFile}/dispatches → ${this.dispatchRefusal.status}: ${this.dispatchRefusal.message}`,
        this.dispatchRefusal.status,
      );
    }
    this.dispatches.push(input);
    return this.answersRunDetails ? { id: this.dispatches.length, htmlUrl: this.runUrl(input.owner, input.repo, this.dispatches.length) } : null;
  }

  async readWorkflowRun(input: { owner: string; repo: string; runId: number }): Promise<WorkflowRunReading> {
    return { htmlUrl: this.runUrl(input.owner, input.repo, input.runId), ...this.dispatchedRun };
  }

  private runUrl(owner: string, repo: string, runId: number): string {
    return `https://github.com/${owner}/${repo}/actions/runs/${runId}`;
  }

}
