// GitHub consumer-repo adapter — the per-call CONSUMER-PAT GitHub client. It manages the ONE
// push-webhook that fires a unit's release pipeline (the image-builder EventListener) at
// build.<build-plane>/github, introspects the PAT's granted scopes (readTokenScopes) for the onboard
// preflight, and drives the release workflow the kit injected: dispatch it (trigger-release) and
// follow its run (watch-release-workflow). A PER-CALL adapter:
// unlike server/adapters/github-platform/github-platform-http.ts (platform repo, one fixed GITHUB_WRITE_PAT), every method
// here carries the CONSUMER's own PAT + the target owner/repo, because each consumer is a distinct
// private repo authenticated by its own sealed credential. Kept a PORT so the onboard/
// offboard/purge steps depend on the abstraction; the fetch impl is github-consumer-http.ts, the
// fake is testing/fake.ts. The typed errors live here (not the impl) so a step catches them via the
// port alone, never importing the concrete client.

/** The platform-constant ingress subdomain the image-builder EventListener is exposed under
 *  (build.<build-plane-fqdn>). A named constant + config default so a non-standard cluster can override
 *  it, while every standard cluster uses "build". */
export const BUILD_EVENTLISTENER_SUBDOMAIN = "build";

/** The webhook payload path the image-builder EventListener ingress serves. */
const WEBHOOK_PATH = "/github";

/** Compose the push-webhook target URL: https://build.<build-plane-fqdn>/github. The host is the BUILD
 *  PLANE's, never the unit's target cluster — the image-builder EventListener and its ingress are
 *  deployed on the one build cluster, and any other host answers the delivery with nothing that creates
 *  a PipelineRun. The single place the subdomain + path are joined, so onboard (create) and
 *  offboard/purge (match + delete) can never drift on the URL they compare. */
export function webhookTargetUrl(buildPlaneFqdn: string, subdomain: string = BUILD_EVENTLISTENER_SUBDOMAIN): string {
  return `https://${subdomain}.${buildPlaneFqdn}${WEBHOOK_PATH}`;
}

/** Does a hook URL target the platform's EventListener path — on ANY host? The path is the platform
 *  signature: a hook ending in /github was written by an onboarding, and one whose host is no longer
 *  the current target is a STALE entry point firing into nothing. ensureHook deletes those before it
 *  ensures the current hook, so a re-onboard leaves the repo with exactly one live hook. */
export function targetsEventListener(url: string): boolean {
  try {
    return new URL(url).pathname === WEBHOOK_PATH;
  } catch {
    return false;
  }
}

export interface EnsureHookInput {
  owner: string;
  repo: string;
  /** The consumer's PAT (plaintext). The caller opens it from the sealed store and zeroes the Buffer
   *  after; this adapter sends it ONLY as the Bearer auth header and never logs it. */
  token: string;
  /** https://build.<build-plane-fqdn>/github (webhookTargetUrl). */
  targetUrl: string;
  /** The HMAC shared secret the EventListener validates each delivery's X-Hub-Signature-256 against
   *  (GITHUB_WEBHOOK_SECRET). Sent ONLY in the create payload's config.secret; never logged. */
  secret: string;
  /** The events the hook subscribes to, e.g. ["push"]. */
  events: string[];
  /** The delivery content-type, e.g. "json". */
  contentType: string;
  signal?: AbortSignal;
}

export interface EnsureHookResult {
  /** true ⇒ this call created the hook; false ⇒ the current hook (same targetUrl) already existed
   *  and was RE-SET to this installation's secret, events and delivery settings (#198): GitHub never
   *  shows a hook's secret, and a hook that outlived a reinstall of the build plane carries the
   *  secret of a listener that no longer exists — every delivery signed with it is refused. */
  created: boolean;
  /** The GitHub hook id (the created one, or the pre-existing match). */
  id: number;
  /** How many STALE EventListener hooks (the /github path on another host) this call deleted before
   *  ensuring the current one — the replace half of the contract, surfaced so the run log can say so. */
  staleRemoved: number;
}

export interface DeleteHookInput {
  owner: string;
  repo: string;
  token: string;
  signal?: AbortSignal;
}

export interface DeleteHookResult {
  /** How many hooks were deleted (0 ⇒ the repo carries none on the EventListener path). */
  deleted: number;
  /** The URLs those hooks pointed at — what the teardown log names, since the removal matches the
   *  path rather than one address and the hook may well stand at an address this platform no longer
   *  composes. */
  urls: string[];
}

/** The granted scopes of a consumer PAT, read off GitHub's X-OAuth-Scopes response header. */
export interface OrgTokenReading extends TokenScopes {
  packages: "reads" | "unreadable" | "absent" | "invalid";
}

/** A right on a repository, highest first — GitHub's `permissions` of GET /repos/{owner}/{repo}. */
export const REPO_PERMISSIONS = ["admin", "maintain", "push", "triage", "pull"] as const;
export type RepoPermission = (typeof REPO_PERMISSIONS)[number] | "none";

/** Who a token acts as, and what it may do on one repository of an owner (#252). */
export interface TokenAccess {
  /** The account the token acts as (GET /user). */
  login: string;
  /** The owner's kind (GET /users/{owner}): a personal account's repositories have their owner alone
   *  as admin; an organisation grants admin per member and repository. */
  ownerKind: "User" | "Organization";
  /** The token's highest right on the repository, where one was named; "none" where it sees none. */
  permission?: RepoPermission;
}

export interface TokenScopes {
  /** true iff GitHub returned an X-OAuth-Scopes header — i.e. this is a CLASSIC PAT. Fine-grained
   *  tokens authenticate but omit the header entirely, so `false` means "not a classic PAT" and the
   *  required-scope contract cannot be proven (the onboard model is a classic-PAT contract). */
  classic: boolean;
  /** The granted classic scopes (comma-split, trimmed). Empty for a classic PAT with no scopes, and
   *  empty whenever `classic` is false. */
  scopes: string[];
}

export interface DispatchWorkflowInput {
  owner: string;
  repo: string;
  token: string;
  /** The workflow file's basename in .github/workflows/, e.g. "release.yml". */
  workflowFile: string;
  /** The git ref the dispatched run checks out — the repo's default branch. */
  ref: string;
  /** The workflow_dispatch inputs, e.g. { version, channel, stage }. */
  inputs: Record<string, string>;
  signal?: AbortSignal;
}

export interface GitHubConsumer {
  /** Read the consumer PAT's granted scopes via a SINGLE GET /repos/{owner}/{repo}, off GitHub's
   *  X-OAuth-Scopes response header (returned on any authenticated classic-PAT request, even a 404).
   *  The onboard preflight-scopes step uses this to verify repo + workflow + admin:repo_hook UP FRONT —
   *  before any mutation — and report the COMPLETE missing set at once. Throws WebhookScopeError on a
   *  401 (the PAT is invalid/expired) and GitHubConsumerError on any other transport/HTTP fault. A
   *  fine-grained token authenticates (2xx) but returns no header ⇒ {classic:false, scopes:[]}. */
  readTokenScopes(input: { owner: string; repo: string; token: string; signal?: AbortSignal }): Promise<TokenScopes>;
  /** ONE read that measures a token AGAINST AN OWNER (owners.ts, #219): GET
   *  /orgs/{org}/packages?package_type=npm with the token. The answer carries both facts an
   *  owner identity is judged on — the X-OAuth-Scopes header (a classic PAT's scopes, absent
   *  on a fine-grained token, as readTokenScopes reads it) and whether the token reads the
   *  owner's packages: 200 ⇒ "reads" (classic read:packages or fine-grained Packages: Read),
   *  403 ⇒ "unreadable" (a token without it), 404 ⇒ "absent" (no such owner, or one the
   *  token cannot see), 401 ⇒ "invalid". Any other transport/HTTP fault throws GitHubConsumerError. */
  readOrgToken(input: { org: string; token: string; signal?: AbortSignal }): Promise<OrgTokenReading>;
  /** Who the token acts as and the owner's kind, and, where a repository is named, the token's
   *  highest right there (#252): GET /user, GET /users/{owner}, GET /repos/{owner}/{repo}. A
   *  repository hook needs admin, whatever the scopes; a repository the token cannot see answers
   *  "none". Any other fault throws GitHubConsumerError. */
  readTokenAccess(input: { owner: string; repo?: string; token: string; signal?: AbortSignal }): Promise<TokenAccess>;
  /** REPLACING create: list the repo's hooks, DELETE every one that targets the EventListener path
   *  (targetsEventListener) but is not the current `targetUrl` — a stale hook fires an old entry
   *  point into nothing — then keep the exact match ({created:false}) or create the push-webhook
   *  ({created:true}). Throws WebhookScopeError when the PAT lacks admin:repo_hook (GitHub answers
   *  403/404 on /hooks) so the onboard step can fail LOUD; any other transport/HTTP failure throws
   *  GitHubConsumerError. */
  ensureHook(input: EnsureHookInput): Promise<EnsureHookResult>;
  /** IDEMPOTENT + fail-soft delete: remove every repo hook on the platform's EventListener PATH
   *  (targetsEventListener), whatever host it points at — the same match ensureHook's stale sweep
   *  makes, and the only one that finishes the job. Matching one composed address instead would miss
   *  a hook created while the build plane stood on another cluster: the sweep only reaches those on
   *  the NEXT onboard of that unit, which after a removal never comes, and the dead hook goes live
   *  again the day that host carries the build plane. An absent hook (or an absent repo, 404) is a
   *  no-op success ({deleted:0}). Throws WebhookScopeError on a 403/404 scope refusal so the
   *  offboard/purge step can log a clear warning (that step never blocks teardown). */
  deleteHook(input: DeleteHookInput): Promise<DeleteHookResult>;
  /** Whether the repository's hooks can be READ with this identity, and whether one already stands
   *  at `targetUrl` (the probe of setup-webhook, hostyour-manager#208). Throws WebhookScopeError on
   *  a 403/404 — the identity holds no admin:repo_hook — exactly as ensureHook would at run time. */
  hookStandsAt(input: { owner: string; repo: string; token: string; targetUrl: string; signal?: AbortSignal }): Promise<boolean>;
  /** Whether ONE package of a scope routed to GitHub Packages is readable with this identity: a GET
   *  of its metadata at `https://npm.pkg.github.com/@<scope>/<name>` — the read a build's npm
   *  install makes, which the App's installation token cannot make (no read:packages) and a PAT
   *  without that scope cannot either. "absent" is a 404 with an identity that IS accepted. */
  readPackage(input: { scope: string; name: string; token: string; signal?: AbortSignal }): Promise<"readable" | "unreadable" | "absent">;
  /** The repo's default branch (GET /repos/{owner}/{repo} → default_branch) — the ref a workflow
   *  dispatch runs on, resolved per repo because main vs master is never assumed. */
  getDefaultBranch(input: { owner: string; repo: string; token: string; signal?: AbortSignal }): Promise<string>;
  /** ONE file of the repository at its default branch, as text (GET /repos/{owner}/{repo}/contents/
   *  {path}, raw), or null where it carries none — what the wizard's prefill reads the `.npmrc` with
   *  to know whether the owner's packages reader is needed (#237), before any clone exists. */
  readFile(input: { owner: string; repo: string; path: string; token: string; signal?: AbortSignal }): Promise<string | null>;

  /** Every tag name of the repository (paginated), for the next-version read (shared/release.ts
   *  nextReleaseVersion): the caller keeps the ones in the release grammar. A non-2xx is an error —
   *  the repository was cloneable a moment ago, so a refusal here is a right the token lacks. */
  listReleaseTags(input: { owner: string; repo: string; token: string; signal?: AbortSignal }): Promise<string[]>;
  /** Fire the release workflow once (POST .../actions/workflows/<file>/dispatches — HTTP 204, no
   *  body). Throws WorkflowNotFoundError on a 404: a workflow committed moments ago is not indexed
   *  yet, and the trigger step RETRIES exactly that case. A 422 (the workflow refuses the inputs —
   *  an old kit without the stage input, or no workflow_dispatch trigger at all) and a 403 throw
   *  GitHubConsumerError carrying GitHub's own message, surfaced immediately, never retried. */
  dispatchWorkflow(input: DispatchWorkflowInput): Promise<void>;
  /** The workflow's runs, newest first — the correlation read behind watch-release-workflow: the
   *  watcher matches displayTitle + the trigger's t0 and aborts on ambiguity. */
}

/** The PAT lacks the admin:repo_hook scope — GitHub answers 403 (or 404, to avoid leaking repo
 *  existence) on the /hooks endpoint. Typed so the onboard step turns it into a LOUD, actionable
 *  failure ("provide a PAT with admin:repo_hook") rather than a generic 4xx. */
export class WebhookScopeError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "WebhookScopeError";
    this.status = status;
  }
}

/** The dispatch endpoint answered 404: the workflow file is not (yet) indexed under that name.
 *  Typed apart from every other failure because it is the ONE case trigger-release retries — a kit
 *  committed seconds earlier takes GitHub a moment to register, while a 422 or 403 will never heal
 *  by waiting and is surfaced immediately. */
export class WorkflowNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowNotFoundError";
  }
}

/** Any other GitHub consumer API failure (a transport error, or a non-2xx that is not a scope
 *  refusal or the retryable dispatch 404). Mirrors github-platform/port.ts's GitHubPlatformError shape but kept a DISTINCT
 *  type (this adapter is decoupled from the platform-repo client). Carries GitHub's own message
 *  verbatim — never a generic mask. */
export class GitHubConsumerError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "GitHubConsumerError";
    this.status = status;
  }
}
