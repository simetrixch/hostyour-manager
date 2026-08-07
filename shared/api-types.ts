// Request/response shapes shared by server and web. The web API client is generated against these;
// ApiError.message renders verbatim.
import type {
  ServerRole, ServerStatus, ServerTailnetState, ServerPasswordLoginState, AuthorizedKeyKind,
  ServerAuthorizedKeysState, RunKind, RunStatus, StepStatus, RunOutputStream,
  TargetKind, LockResource,
  Stage, TenantStatus, AppStatus, ArgoSync, ArgoHealth, DriftVerdict,
} from "./enums.ts";
import type { ReleaseChannel } from "./release.ts";

export type ApiErrorCode =
  | "VALIDATION"
  | "MISSING_RUN_SECRET"
  | "UNAUTHENTICATED"
  | "NOT_A_MEMBER"
  | "CSRF_REFUSED"
  | "NOT_FOUND"
  | "ILLEGAL_TRANSITION"
  | "RESOURCE_BUSY"
  | "PLAN_REFUSED"
  | "IDP_UNREACHABLE"
  | "NOT_CONFIGURED"
  | "UPSTREAM"
  | "UNDECLARED_TARGET"
  | "RUNNER_BUSY"
  | "SANDBOX_DEGRADED"
  | "INTERNAL";

export interface ApiError {
  code: ApiErrorCode;
  message: string;
  /** Structured payload for codes that carry one (RESOURCE_BUSY, PLAN_REFUSED, …). */
  detail?: Record<string, unknown>;
}

/** The stable marker the onboard `activate` step prefixes the returned activate_url with, so the run
 *  screen can lift the one-shot value out of the live log into a copyable callout. Lives here (a pure,
 *  zod-free module) so BOTH the server log line and the web parser share one string and can never
 *  drift — without pulling the manifest schemas (zod) into the web bundle. The activate_url is a
 *  root-admin credential: it rides ONE line on the live-only "ephemeral" stream — never an `events`
 *  row, so a reload or replay cannot resurface it. */
export const ACTIVATION_RESULT_MARKER = "activate_url (shown once, not stored):";

/** The facts one tailnet READING recorded about a host — the v0 body of servers.tailnet_json, the
 *  ONE declaration both ends use (the zod schema in shared/tailnet.ts is `satisfies`-checked
 *  against it, so the parsed shape and the wire shape cannot drift).
 *
 *  Every field is a MEASUREMENT, not a setting: `observedAt` is when the reading was taken and
 *  `runId` is the run that took it, so the surface can always name where the numbers came from and
 *  how old they are. There is no "last seen" here: that would be the coordinator's view of the
 *  node, and nothing in this product reads the coordinator. */
export interface ServerTailnetFacts {
  v: 0;
  observedAt: number;
  runId: string;
  /** `tailscale version`, or null when the host carries no client — or carries one that would not
   *  answer, which `backendState` tells apart. */
  clientVersion: string | null;
  /** What the client says it is doing: "Running" is on a network, "NeedsLogin"/"Stopped"/… is not,
   *  and null is a client that could not be asked at all. The daemon is up from the moment the
   *  client is installed, so only this answers the membership question. */
  backendState: string | null;
  /** The tailnet address the host holds, or null when it holds none. */
  address: string | null;
  /** The coordinator the client is logged in to. Carried because an address alone cannot say WHOSE
   *  network it is on: a host brought up against a different coordinator holds an address out of
   *  the same range and reports Running exactly like ours. The card names it rather than judging
   *  it — the controller is told no coordinator URL of its own to compare against. */
  coordinator: string | null;
}

/** What reading servers.tailnet_json produced. A UNION rather than `ServerTailnetFacts | null`,
 *  because the four outcomes say different things and the card must not paint three of them the
 *  same: no document at all is not the same as a document this build cannot read, and neither is
 *  the same as a document that failed its schema. Narrowed by readServerTailnet (shared/tailnet.ts)
 *  on the stored `v` BEFORE the body is parsed — a versioned document nobody narrows on is a
 *  comment, and the plane document beside it shows what that costs: two of its readers ask for
 *  fields the schema never declared and silently get nothing, forever. */
export type ServerTailnetRead =
  | { kind: "none" }
  | { kind: "v0"; facts: ServerTailnetFacts }
  | { kind: "unsupported"; v: number }
  | { kind: "unreadable"; reason: string };

/** The facts one PASSWORD-LOGIN reading recorded about a host — the v0 body of
 *  servers.password_login_json, the ONE declaration both ends use (the zod schema in
 *  shared/password-login.ts is `satisfies`-checked against it).
 *
 *  All three values come out of `sshd -T`, the daemon's own printout of what it resolved after
 *  every Include and every ordering rule. Nothing here is read off a file: the whole reason this
 *  reading exists is that a file named `99-disable-passwords.conf` can say `PasswordAuthentication
 *  no` while the daemon answers `yes`, because a `50-` drop-in stated the keyword first. */
export interface ServerPasswordLoginFacts {
  v: 0;
  observedAt: number;
  runId: string;
  /** `sshd -T`'s `passwordauthentication` — "yes" or "no", or null when the line was absent. */
  passwordAuthentication: string | null;
  /** `sshd -T`'s `kbdinteractiveauthentication`. The SAME door: PAM serves passwords through
   *  keyboard-interactive, so a host that turned only the keyword above off still takes one. */
  kbdInteractiveAuthentication: string | null;
  /** `sshd -T`'s `pubkeyauthentication`. Carried because it is what says the host is still
   *  reachable at all — a machine with both doors shut answers nobody. */
  pubkeyAuthentication: string | null;
}

/** What reading servers.password_login_json produced. A union for the same reason
 *  ServerTailnetRead is one: no document at all, a document from a version this build does not
 *  read, and a document that failed its schema are three different things, and a surface that
 *  paints them alike claims to know something it does not. */
export type ServerPasswordLoginRead =
  | { kind: "none" }
  | { kind: "v0"; facts: ServerPasswordLoginFacts }
  | { kind: "unsupported"; v: number }
  | { kind: "unreadable"; reason: string };

/** ONE key line found in a host's ~/.ssh/authorized_keys.
 *
 *  The BLOB is deliberately absent. The fingerprint is this codebase's public, non-secret
 *  identifier for a key (server/security/fingerprint.ts) and is exactly what `ssh-keygen -lf`
 *  prints, so an operator can cross-check a line on the box against what the card shows — while the
 *  base64 body would put a full copy of every key on every host into one JSON column for nothing. */
export interface AuthorizedKeyFact {
  /** SHA256:… over the key blob — the same string `ssh-keygen -lf` prints for this line. */
  fingerprint: string;
  /** The key type field as it stood in the file: "ssh-ed25519", "ssh-rsa", "ecdsa-sha2-nistp256". */
  type: string;
  /** Everything after the blob, verbatim. It is what carries a marker, so it is kept unedited —
   *  a comment that IMITATES the operator marker but does not parse as one reads as foreign, and
   *  the operator has to be able to see the text that made that call. */
  comment: string;
  kind: AuthorizedKeyKind;
  /** The operator label the line was placed under, for an "operator" line; null for the other two.
   *  This is the string a removal keys on, so the card can name exactly what it would take off. */
  label: string | null;
}

/** The facts one AUTHORIZED-KEYS reading recorded about a host — the v0 body of
 *  servers.authorized_keys_json, the ONE declaration both ends use (the zod schema in
 *  shared/operator-keys.ts is `satisfies`-checked against it). */
export interface ServerAuthorizedKeysFacts {
  v: 0;
  observedAt: number;
  runId: string;
  /** Every key line the file held, in the order sshd reads them. */
  keys: AuthorizedKeyFact[];
  /** Lines that were neither blank nor a `#` comment and did not parse as a key HERE. Counted
   *  rather than dropped, and it moves the state to "unaccounted": this parser and sshd's are not
   *  the same one, so such a line may well be a certificate or a key type this build never heard of
   *  that authenticates on the host. A line nobody here can name is the opposite of accounted. */
  unparsed: number;
}

/** What reading servers.authorized_keys_json produced. A union for the same reason the two above
 *  are: no document, a document from a version this build does not read, and a document that failed
 *  its schema are three different things. */
export type ServerAuthorizedKeysRead =
  | { kind: "none" }
  | { kind: "v0"; facts: ServerAuthorizedKeysFacts }
  | { kind: "unsupported"; v: number }
  | { kind: "unreadable"; reason: string };

/** An operator's own SSH public key, as this controller holds it. There is no private half here and
 *  never will be: the operator keeps that, and this row is the public line plus the label the key is
 *  placed and removed under. `label` is free text the operator chooses, not a link to an operators
 *  row — an operator row only exists after that human's first OIDC login, and a key is usually added
 *  for someone who has not signed in yet. */
export interface OperatorKeyView {
  id: string;
  label: string;
  /** The key TYPE and its fingerprint, and not the key body: the fingerprint is what every surface
   *  here identifies a key by, and the run that places one reads the stored line from the row it
   *  loads. Projecting the body would ship a copy of every operator's key to the browser on each
   *  load of the page for nothing to read. */
  type: string;
  fingerprint: string;
  createdAt: number;
  /** The servers whose LAST reading found this key's fingerprint. Derived from those readings, not
   *  from a placement ledger: what a host actually carries is the only thing worth reporting, and a
   *  ledger of what was placed would go on claiming a key a reinstall took away. */
  onServerIds: string[];
}

export interface ServerView {
  id: string;
  name: string;
  host: string;
  lanHost: string | null;
  /** The address the master's in-cluster components dial this machine's kube-apiserver on once it is
   *  a slave — the cluster map's apiHost, stated by the operator. Not an SSH transport: which address
   *  a run's session opens on is resolved from `host` and `lanHost` alone. */
  tailnetHost: string | null;
  sshPort: number;
  sshUser: string;
  role: ServerRole;
  status: ServerStatus;
  /** Tailnet membership as the last run to look at this host found it — a SECOND axis beside
   *  `status`, not a part of it (a server joins before it is ever deployed). */
  tailnetState: ServerTailnetState;
  /** The reading behind `tailnetState`: when it was taken, by which run, and what it found.
   *  Projected across the trust boundary deliberately — a tailnet address is an internal address
   *  of the same kind as `lanHost`, which this projection has always carried. */
  tailnet: ServerTailnetRead;
  /** Whether this host's sshd takes a password, as the last run to look at it found — a THIRD axis
   *  beside `status` and `tailnetState`, and never a setting the browser may flip: only a run can
   *  change what the daemon resolves, and only a run can prove it did. */
  passwordLoginState: ServerPasswordLoginState;
  /** The reading behind `passwordLoginState`: when it was taken, by which run, and the three
   *  `sshd -T` values it found. */
  passwordLogin: ServerPasswordLoginRead;
  /** What this host's ~/.ssh/authorized_keys held, as the last run to read it found — a FOURTH axis
   *  beside `status`, `tailnetState` and `passwordLoginState`. It answers a different question from
   *  `hasKey` below: that one says this controller HAS a key for the server, this one says who else
   *  the machine lets in. */
  authorizedKeysState: ServerAuthorizedKeysState;
  /** The reading behind `authorizedKeysState`: when it was taken, by which run, and every key line
   *  it found. */
  authorizedKeys: ServerAuthorizedKeysRead;
  createdAt: number;
  adoptedAt: number | null;
  /** A bootstrap password is on file (never the value) — enables 1-click adopt. */
  hasPassword: boolean;
  /** A dedicated SSH key has been installed (i.e. adopt reached generate-key). */
  hasKey: boolean;
}

export interface StepView {
  name: string;
  title: string;
  status: StepStatus;
  startedAt: number | null;
  endedAt: number | null;
}

/** One operator-supplied NON-secret input a plan asks for at approve (a manifest-declared
 *  activation's dynamic arg, e.g. the first-admin email). Unlike requiredSecrets these are not
 *  credentials: the approve ceremony renders them as plaintext fields (never masked) and they are
 *  never sealed. The field name is the request-body key; label is the human prompt. */
export interface OperatorInput {
  field: string;
  label: string;
}

export interface RunView {
  id: string;
  kind: RunKind;
  targetKind: TargetKind;
  targetId: string;
  status: RunStatus;
  summary: string;
  steps: StepView[];
  /** The plan's operator-supplied secret keys (executor `requiredSecrets`). The approve
   *  ceremony renders one input per entry and passes them to /approve; empty for most runs
   *  (e.g. an onboard whose manifest secrets are all `generate:`). */
  requiredSecrets: string[];
  /** The plan's operator-supplied NON-secret inputs (onboard activation prompts). Empty for
   *  every run whose consumer declares no `activation:` block. Rendered as plaintext fields in the
   *  approve ceremony and carried in the approve payload under `activation-input:<field>` keys. */
  requiredInputs: OperatorInput[];
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  /** Soft-delete marker: set = the run is gone from the runs list (its row + full log
   *  remain in the DB). Non-null only on a by-id read — listRuns never returns such runs. */
  deletedAt: number | null;
}

export interface RunEventView {
  seq: number;
  /** "ephemeral" arrives only over the live SSE stream — such an event has no `events` row and is
   *  never replayed on reconnect or reload. */
  stream: RunOutputStream;
  text: string;
  at: number;
}

export interface LockView {
  resource: LockResource;
  key: string;
  runId: string;
  acquiredAt: number;
}

export type ClustersVerdict = "ok" | "warn" | "down";
export type ClustersSourceState = "ok" | "stale" | "error" | "unwired";
export type StoreMode = "plaintext" | "sealed";

/** The one-glance clusters view. Every collector fills its own entry in `sources`, so a collector
 *  that is not wired yet reports `unwired` instead of leaving the field out.
 *  Staleness is first-class — a source older than 3× its interval renders `stale` and can
 *  only degrade the verdict, never silently keep it green. */
export interface ClustersView {
  asOf: number;
  verdict: ClustersVerdict;
  needsYou: RunView[];
  running: RunView[];
  /** The MANAGED servers only (role !== master) — what this controller actually runs.
   *  The master (this controller itself) is never in this list; it rides `master` below,
   *  so the managed count mirrors reality 1:1. */
  servers: ServerView[];
  /** The control host itself (the one role=master row), surfaced separately — labeled,
   *  never counted as managed. Null until the controller has adopted itself. */
  master: ServerView | null;
  sources: {
    inventory: ClustersSourceState;
    argo: ClustersSourceState;
    vault: ClustersSourceState;
    alerts: ClustersSourceState;
    prom: ClustersSourceState;
    ssh: ClustersSourceState;
  };
  storeMode: StoreMode;
}

/** /readyz response — the degrading self-checks surface. */
export interface ReadyzView {
  ok: boolean;
  checks: { name: string; ok: boolean }[];
}

/** Public /healthz payload. `version` is the running image tag (the Deployment's
 *  CONTROLLER_VERSION = apps/controller values imageTag) — always present, never defaulted. */
export interface HealthView {
  status: "ok";
  version: string;
}

/* ---- GitOps repo: Branches (read-only) + Reset (destructive) ---- */

/** Branch classification, DERIVED server-side (derive-dont-type): master = the generic source;
 *  controller = the control host's install branch (name === the master FQDN);
 *  slave = <single-label>.<base-domain of the master FQDN>; other = the rest of the repo. */
export type BranchKind = "master" | "controller" | "slave" | "other";

/** Merge-base (three-dot) semantics: aheadBy/changedFiles = the branch's OWN work since it
 *  diverged from master; behindBy = master commits the branch lacks. truncated ⇒ GitHub's
 *  300-file cap — render "300+", never imply completeness. */
export interface BranchCompareSummary {
  aheadBy: number;
  behindBy: number;
  changedFiles: number;
  truncated: boolean;
}

export interface BranchView {
  name: string;
  /** HEAD commit sha. */
  sha: string;
  kind: BranchKind;
  /** Present for installer branches only (kind controller|slave). master is the base of every
   *  compare and "other" branches are not installer state — neither is compared. */
  compare?: BranchCompareSummary;
}

export interface BranchesView {
  /** "owner/repo" — the UI names WHICH repo it shows. */
  repo: string;
  branches: BranchView[];
}

/** One changed file of a branch-vs-master diff (GitHub compare file entry, passed through). */
export interface BranchDiffFileView {
  filename: string;
  /** "added" | "modified" | "removed" | "renamed" | … (GitHub file status). */
  status: string;
  additions: number;
  deletions: number;
  /** Absent for binary/too-large files OR when the server capped an oversized patch. */
  patch?: string;
}

export interface BranchDiffView {
  name: string;
  kind: BranchKind;
  aheadBy: number;
  behindBy: number;
  files: BranchDiffFileView[];
  /** GitHub capped the file list (300) — the diff shown is incomplete. */
  truncated: boolean;
}

/** POST /api/reset body. `confirm` must be the literal string "RESET". */
export interface ResetRequest {
  confirm: string;
  wipeDb: boolean;
  deleteBranches: string[];
  /** Explicit opt-in: without it the master's own install branch is refused. */
  includeMaster: boolean;
}

export interface ResetBranchOutcome {
  branch: string;
  ok: boolean;
  /** HEAD sha at deletion time — the undo anchor (git push origin <sha>:refs/heads/<branch>). */
  sha?: string;
  error?: string;
}

/** Cluster-map cleanup on the books branch (clusters/active/<fqdn>.yaml). Carries no failure: the map removal
 *  runs ahead of the branch deletes, so its failure REFUSES the whole request and there is no result
 *  to report. Null when the step did not run at all; `removed: []` when it ran and found nothing. */
export interface ResetPointerOutcome {
  branch: string;
  removed: string[];
  commit: string | null;
}

export interface ResetResult {
  /** True when every requested action succeeded. */
  ok: boolean;
  branches: ResetBranchOutcome[];
  pointers: ResetPointerOutcome | null;
  db:
    | { wiped: true; rows: Record<string, number>; backupFile: string; vaultOrphans: string[] }
    /** `error` is set only when a wipe was asked for and FAILED. The wipe is one transaction, so the
     *  database is then the one the reset started with — but the branches above are already gone, and
     *  the response carries their shas so they can be pushed back. */
    | { wiped: false; error?: string };
  /** The role=master row was re-seeded in-process after the wipe (seed-master.ts is idempotent). */
  reseeded: boolean;
}

/* ---- The LIVE RECONCILIATION reads: GET /api/consumers/:appId/live and GET /api/tenants/:id/live ----
 *
 * The SQL row is a TRACE of what the Controller BELIEVES; these two routes read the FACTS beside it —
 * a live cluster smoke (source 2) and the ArgoCD status (source 3) — and compare them. Both answer in
 * the SAME four-part envelope (row / cluster / argo / drift + the ArgoCD deep-link), so the three parts
 * that are IDENTICAL between them are declared ONCE below and shared by both, and by both ends.
 *
 * WHY these live here and not in the route module with a hand-written browser twin.
 * The server declared the `argo` union once and used it for both routes; the browser restated it TWICE
 * by hand and narrowed on `.ok`. That is the same arrangement that already shipped a crash: a member
 * added server-side to the run-tenant-state union fell through the browser's ternary chain into an arm
 * that read a field the new state does not carry, and the TypeError unmounted the whole Run screen (the
 * long note further down tells that story). Nothing links a mirror to its original, so `npm run check`
 * stays green while the two drift. Declared here, a member added to LiveArgoView breaks the browser's
 * narrowing at compile time — which is the only kind of guarantee worth having. */

/** One workload of a live cluster smoke (the server's SmokeResult.workloads[] entries). */
export interface WorkloadStatusView {
  kind: string;
  name: string;
  available: boolean;
  /** Replicas asked for / actually up. A workload switched off by a suspend reads 0 of 0, which is
   *  "available" — so the counts are what tells a paused unit from a running one. */
  desired: number;
  ready: number;
  message?: string;
}

/** The cluster FACTS one live read surfaces (source 2 — the namespace smoke), or the read's OWN
 *  failure. `ok:false` is per-SOURCE on purpose: the two live reads are fanned with allSettled, so an
 *  unreachable slave spins only this half and the ArgoCD half still answers. */
export type LiveClusterView =
  | { ok: true; namespaceExists: boolean; workloads: WorkloadStatusView[]; externalSecretsReady: boolean }
  | { ok: false; error: string };

/** The ArgoCD FACTS one live read surfaces (source 3), or the read's own failure — same per-source
 *  honesty as LiveClusterView. For a consumer these are its ONE Application's; for a tenant they are
 *  the whole fan-out ROLLED UP (Synced only if every member is Synced, health worst-of). */
export type LiveArgoView =
  | { ok: true; sync: ArgoSync; health: ArgoHealth; syncRevision: string | null; message?: string }
  | { ok: false; error: string };

/** The two revisions a live read compares, and the verdict over them. The whole point of the panel:
 *  what the pointer PINS and what the cluster RUNS.
 *
 *  `pinned` is read off the Application's own spec (targetedRevisionFor, adapters/kube/port.ts) — the
 *  pointer's pin AS ARGOCD SEES IT, per repo. `deployed` is what Argo last synced.
 *
 *  On a unit whose pointer deliberately generates NO Application — a SUSPENDED or offboarded consumer,
 *  a settled tenant — `pinned` is null, so the pair reads "pinned none · deployed none". There is no
 *  Controller-side record to fall back on and there must not be one: calling that absence drift reported
 *  the success condition of an approved action as a defect. A tenant SUSPEND is
 *  not such a case at all — its base Application survives by design, so it keeps both revisions and goes
 *  on being compared. What a unit with neither revision reads is not "converged" but the fourth verdict,
 *  "not-deployed": see `verdict` below for why the difference is the whole point.
 *
 *  `verdict` — does what RUNS match what is PINNED? FOUR answers (DRIFT_VERDICT, shared/enums.ts), two
 *  of which are neutral non-verdicts rather than a green claim: "unknown" when ArgoCD could not be read
 *  at all (painting "couldn't read ArgoCD" as "has drifted" would turn a FACT panel into a liar), and
 *  "not-deployed" when nothing is pinned AND nothing runs, i.e. when no comparison happened at all.
 *  "converged" is a statement ABOUT a comparison, so it may only be given when one actually took place —
 *  and the state it used to be given for is reachable BOTH by a finished suspend and by a lifecycle run
 *  that died half-way (see driftOf), which is exactly why the honest answer there is the one that asserts
 *  nothing. */
export interface LiveDriftView {
  pinned: string | null;
  deployed: string | null;
  verdict: DriftVerdict;
}

/** The LIVE half of one consumer's reconciliation read — cluster/argo/drift + the deep-link, WITHOUT
 *  the inventory row, because one consumer surface has no row to echo: GET /api/consumers/live, the
 *  NAME-keyed probe (clusterId + name + stage) the Detected panel renders for a consumer the inventory
 *  does not know. Both routes answer through the server's ONE probe
 *  implementation (probeConsumerLive, server/domains/onboarding/api.ts), so the two cards can never
 *  answer the same situation differently. `cluster`/`argo`/`drift` are null TOGETHER when onboarding is
 *  not configured (`reason` set) — the same degrade-loud contract the 501 mutating routes follow. */
export interface ConsumerLiveProbeView {
  cluster: LiveClusterView | null;
  argo: LiveArgoView | null;
  drift: LiveDriftView | null;
  /** Server-derived ArgoCD UI deep-link for this consumer's Application (argo.<masterFqdn> for the
   *  master, argo-<slave>.<masterFqdn> for a slave). null when the master FQDN is unknown or onboarding
   *  is not configured — render no link then. Present even when `argo` is `ok:false` (a down ArgoCD is
   *  exactly when the operator wants to click through). */
  argocdUrl: string | null;
  reason?: "onboarding-not-configured";
}

/** GET /api/consumers/:appId/live — the FACTS beside the consumer row's TRACE. Loaded LAZILY per row
 *  by the Consumers reconciliation tab (a slow/unreachable slave spins only its own card). The live
 *  half is ConsumerLiveProbeView above; this row-keyed route additionally echoes the row. */
export interface ConsumerLiveView extends ConsumerLiveProbeView {
  /** Where this consumer SERVES: `<name>.<unitApex>` — the one host its ingress renders, its
   *  admission policy admits and its DNS record names. The apex is the target cluster's own
   *  (`global.unitApex` off that cluster's values chain) and is NOT the cluster's domain, so the
   *  browser cannot compose this from the row and is handed the finished host instead. Null when the
   *  chain could not be read; the card then shows no address rather than a name that resolves
   *  nowhere. */
  unitHost: string | null;
  /** Source (1): the SQL row — what the Controller BELIEVES, echoed beside the live facts so the
   *  payload is self-contained. The private repoUrl is deliberately NOT part of it: it is read
   *  server-side to resolve the drift comparison per repo, and never leaves the server. */
  row: {
    id: string;
    name: string;
    clusterId: string;
    domain: string;
    stage: Stage;
    status: AppStatus;
  };
}

/** GET /api/tenants/:id/live — the tenant analogue of ConsumerLiveView. A tenant fans out to MANY
 *  Applications across one namespace per member, so `cluster` folds a smoke of each of them and `argo` is
 *  the whole fan-out rolled up, while `drift` compares the BASE Application's targeted and synced
 *  revision against each other. Same null-together degrade, same per-source `ok:false`. */
export interface TenantLiveView {
  row: {
    id: string;
    guid: string;
    subdomain: string;
    clusterId: string;
    domain: string;
    stage: Stage;
    status: TenantStatus;
    suspended: boolean;
  };
  cluster: LiveClusterView | null;
  argo: LiveArgoView | null;
  drift: LiveDriftView | null;
  argocdUrl: string | null;
  reason?: "onboarding-not-configured";
}

/* ---- Tenants: what a tenant-purge is AIMED at, and the two reads that can NAME one ----
 *
 * THE ONE DECLARATION of each shape below, consumed by BOTH ends: the server domain module returns these
 * exact types (server/domains/onboarding/tenant-orphans.ts and tenant-registry.ts) and the web client
 * reads them (web/src/api.ts and the tenant/run screens). They live here — a pure, zod-free module, the
 * same reason ACTIVATION_RESULT_MARKER does — because the alternative was tried and failed: each of them
 * was declared once in the domain module and hand-mirrored again in the browser, and when the server's
 * run-tenant-state union gained a `not-deployed` member the mirror was never updated. Nothing linked the
 * two, so `npm run check` stayed green, the unknown state fell through the run callout's ternary chain
 * into the arm meant for an offboarded tenant, and that arm read `row` off an answer that carries none —
 * a TypeError that unmounted the entire Run screen for the commonest create-tenant failure there is. The
 * server's zod schemas (which additionally validate what a wire type cannot express — the guid alphabet,
 * the cls_ id prefix) are checked against these declarations at their own declaration sites, so the
 * PARSED shape and the WIRE shape cannot drift either. */

/** The by-GUID identity a tenant purge (force-offboard) targets — the POST /api/tenants/purge body, and
 *  the tenant analogue of the consumer purge's name + stage + cluster. An ORPHAN has no tenants row and
 *  therefore no tenantId; the guid is the sole tenant identity (namespace == AppProject == pointer dir),
 *  so a purge is keyed on guid + stage + cluster, never on a path :id. The guid is MINTED by the
 *  create-tenant plan and typed by nobody — every caller must pass a guid it RECEIVED (from the orphan
 *  scan, or from a run's own frozen target), NEVER one an operator keyed in.
 *
 *  Server side this is the zod TenantPurgeRequest (tenant-purge.run.ts), which is `satisfies`-checked
 *  against this type where it is declared. */
export interface TenantPurgeInput {
  guid: string;
  stage: Stage;
  clusterId: string;
}

/** What a purge is AIMED at: the three fields the run is keyed on plus the subdomain, which is the only
 *  part of a tenant's identity a human recognises (the guid is minted, not chosen). Declared beside the
 *  input it extends, because both places that hand a target to PurgeTenantDialog carry this one shape —
 *  the orphan scan and a create-tenant run's own frozen params (server CreateTenantPurgeTarget, a zod
 *  extension of TenantPurgeRequest checked against this type). */
export interface PurgeTenantTarget extends TenantPurgeInput {
  subdomain: string;
}

/** One tenant deployed in GitOps that the inventory does not know — everything the operator needs to
 *  RECOGNISE it (subdomain + stage + slave) and everything a tenant-purge needs to AIM at it. */
export interface OrphanTenantView {
  /** The sole tenant identity (namespace == AppProject == pointer dir). MINTED by the create-tenant
   *  plan — an operator can only ever select one of these, never type one. */
  guid: string;
  subdomain: string;
  stage: Stage;
  /** The pointer's `cluster` field: the ArgoCD-REGISTERED slave name the fan-out is destined for. */
  cluster: string;
  /** That slave resolved to the controller's own clusters row id (resolveClusterIdByName), or null
   *  when NO registered cluster carries the name. Null is honest and load-bearing: a purge is keyed on a
   *  clusterId, so an unresolvable orphan cannot be purged through the product at all — the UI must show
   *  it and say why rather than offer an action that would 400. */
  clusterId: string | null;
}

/** One registrations/<guid>/<stage>.yaml the scan could NOT read (a drifted/corrupt body, or one
 *  whose body guid disagrees with its directory), carried OUT of the scan instead of dropped inside it.
 *  `guid` is the DIRECTORY name — the identity, since the body is precisely what could not be trusted —
 *  and `reason` is the same one-line WHY the strict fold would have thrown with. It carries no clusterId,
 *  so the UI can offer no purge for it: it says what is broken and where, which is the whole point — a
 *  pointer dropped in silence makes an empty orphan list read as "everything is accounted for", an
 *  unfalsifiable answer that strands exactly the tenant nobody can see. */
export interface SkippedTenantPointerView {
  guid: string;
  stage: Stage;
  reason: string;
}

/** What ONE pointer scan found: the orphans, AND every pointer it could not read. The two travel together
 *  because they answer the SAME operator question ("what is out there that I do not know about?") and
 *  because `orphans` alone is not a truthful answer while `skipped` is non-empty — a pointer nobody could
 *  parse might BE an orphan, so the UI must say "N pointers could not be read" instead of "every deployed
 *  tenant pointer has a matching inventory row". */
export interface OrphanScan {
  orphans: OrphanTenantView[];
  skipped: SkippedTenantPointerView[];
}

/** GET /api/tenants/orphans — the scan plus the route's FAIL-SOFT envelope, which is the same honesty
 *  rule applied per SCAN that `skipped` applies per pointer: `error` set means the scan itself could not
 *  read catalog, so `orphans: []` means NOTHING and the UI must render the error, never "no orphans
 *  found"; `reason` set means tenant onboarding is not wired at all, so there was nothing to scan with. */
export interface OrphanScanView extends OrphanScan {
  error?: string;
  reason?: "onboarding-not-configured";
}

/* ---- Consumers: the DETECTED scan + the adopt verb it feeds ----
 *
 * The CONSUMER TWIN of the tenant orphan scan above, declared beside it so the two families keep one
 * vocabulary. A DETECTED consumer is one whose GitOps registration (registrations/<name>/<stage>.yaml)
 * names an active cluster while NO unsettled apps row carries it —
 * its onboard died before record-inventory (the LAST onboard step), or the pointer was written by
 * hand. Such a consumer is INVISIBLE in the Controller: the Consumers list is a projection of the apps
 * rows, and offboard resolves its target BY that row. Unlike a tenant orphan (whose remedy is purge,
 * removal), a detected consumer is usually HEALTHY — swissbookai is the founding case — so the remedy
 * is ADOPT: reconstruct the row from the pointer, via a Run with a live cluster attest. */

/** What ONE detected consumer's REGISTRATION claims — copied VERBATIM from the ConsumerRegistration
 *  the scan parsed, and labeled as the registration's claim everywhere it is rendered: the bulk scan
 *  probes nothing live, so none of this may be presented as "running" (the live truth is the separate
 *  per-row probe, GET /api/consumers/live). repoCredentialId is a credential-store id (never a token);
 *  the adopt run re-reads the registration in-run rather than trusting any of these fields off the
 *  wire. There is no revision here at all — the registration carries none, because the consumer's pin
 *  is the consumer's own. */
export interface DetectedConsumerPointerView {
  repoURL: string;
  chartPath: string;
  cluster: string;
  repoCredentialId?: string;
  onboardedAt?: string;
  owner?: string;
  suspended: boolean;
  quiesced: boolean;
}

/** One consumer deployed in GitOps that the inventory does not know — everything the operator needs to
 *  RECOGNISE it and everything an adopt-consumer (or purge) run needs to AIM at it. Unlike
 *  OrphanTenantView there is no `clusterId: null` arm: the consumer scan ITERATES the registered active
 *  clusters rows (each install branch belongs to exactly one), so every detected consumer arrives with
 *  its cluster already resolved. */
export interface DetectedConsumerView {
  /** The consumer name == namespace == AppProject == pointer file name (the G1 identity law). */
  name: string;
  stage: Stage;
  clusterId: string;
  domain: string;
  pointer: DetectedConsumerPointerView;
}

/** One registrations/<name>/<stage>.yaml the scan could NOT read (unparseable bytes, a failed schema,
 *  or a body name disagreeing with its directory name), carried OUT of the scan instead of dropped
 *  inside it — the consumer twin of SkippedTenantPointerView, for the same reason: a registration
 *  dropped in silence makes an empty detected list read as "everything is accounted for". `name` is the
 *  DIRECTORY name (the identity — the body is precisely what could not be trusted). */
export interface SkippedConsumerPointerView {
  name: string;
  stage: Stage;
  reason: string;
}

/** One consumer NAMESPACE standing on a cluster that neither a registration nor an inventory row
 *  accounts for — the blind spot the registration diff structurally cannot see, because it starts from
 *  the registrations and this consumer has none. It is the case a removed registration leaves behind
 *  when the cluster workloads were never pruned: the Consumers list is empty of it, the detected scan
 *  returns nothing for it, and the pods keep serving.
 *
 *  Unlike DetectedConsumerView there is no `pointer`: there is nothing to claim anything, so every
 *  field here is a LIVE READ of the cluster. The three that aim a purge — clusterId, name, stage — are
 *  the G1 identity (the namespace IS the consumer name), which is why a purge can reach this without a
 *  row and without a registration. ADOPT cannot: it reconstructs the inventory row FROM the
 *  registration, and there is none. */
export interface ClusterOrphanConsumerView {
  /** The namespace name, which IS the consumer name (G1). */
  name: string;
  stage: Stage;
  clusterId: string;
  domain: string;
  /** How many of the namespace's workloads have at least one ready replica, out of how many it holds.
   *  `running > 0` is what separates a consumer that is SERVING from an empty namespace an offboard
   *  left behind — the difference between a leak and a leftover, and the operator decides differently
   *  on each. */
  running: number;
  workloads: number;
  externalSecretsReady: boolean;
}

/** One ACTIVE cluster the cluster-orphan half could not read, carried out of the scan instead of
 *  passing as "no orphans there". A slave that is down, a harvested bearer that expired or a kube API
 *  that refused the namespace list all produce the same silence, and silence read as an all-clear is
 *  the exact failure this whole scan exists to end. */
export interface UnscannedClusterView {
  clusterId: string;
  domain: string;
  stage: Stage;
  reason: string;
}

/** What ONE detected scan found. Four lists, because the scan has two independent halves and each owes
 *  its own honesty:
 *
 *  REGISTRATION side — `detected` (consumers only the registrations know) and `skipped` (registrations
 *  that could not be read). They travel together for the same reason OrphanScan's do: `detected` alone
 *  is not a truthful answer while `skipped` is non-empty. Nothing here is probed live.
 *
 *  CLUSTER side — `clusterOrphans` (namespaces neither a registration nor a row accounts for) and
 *  `unscanned` (clusters that could not be read at all). This half IS live by construction: it asks
 *  each cluster which consumer namespaces it holds. It exists because the registration diff cannot see
 *  a consumer that has no registration, which was the founding case — pods serving, zero detected. */
export interface DetectedScan {
  detected: DetectedConsumerView[];
  skipped: SkippedConsumerPointerView[];
  clusterOrphans: ClusterOrphanConsumerView[];
  unscanned: UnscannedClusterView[];
}

/** GET /api/consumers/detected — the scan plus the route's FAIL-SOFT envelope, exactly OrphanScanView's
 *  contract: `error` set means the REGISTRATION half could not read the install branches, so
 *  `detected: []` means NOTHING and the UI must render the error, never "none detected"; `reason` set
 *  means consumer onboarding is not wired at all, so there was nothing to scan with.
 *
 *  `error` covers the registration half ALONE. The cluster half fails per cluster, into `unscanned` —
 *  one unreachable slave must not turn the other clusters' answers into an error, and it must not
 *  vanish either. So a response can carry real `clusterOrphans` beside a set `error`, and the UI has to
 *  say both. */
export interface DetectedScanView extends DetectedScan {
  error?: string;
  reason?: "onboarding-not-configured";
}

/** The inventory row behind a run's tenant, projected to exactly what the run screen needs: the id it
 *  links to, and the two fields TenantStatusBadge labels a tenant by (a tenant carrying the suspend flag
 *  reads "suspended" while its row still says "active"). Projected rather than passed whole for the same
 *  reason the target is — only what the screen renders goes on the wire. */
export interface RunTenantRowView {
  tenantId: string;
  status: TenantStatus;
  suspended: boolean;
}

/** GET /api/tenants/runs/:runId/tenant-state — what the tenant a create-tenant run MINTED looks like
 *  right now, and therefore which remedy that run's screen may offer for it. Resolved SERVER-SIDE from
 *  the tenants row (resolveRunTenantState, tenant-orphans.ts, whose return type IS this union) and
 *  rendered by the run screen, which derives BOTH its copy and its action from it so the words and the
 *  button can never describe different tenants. The seven states are exhaustive and each names a different
 *  truth:
 *
 *   - "none"         — the run never froze a guid (its params carry none): it created nothing.
 *   - "not-deployed" — a guid WAS frozen, but the run never got past attest-target, its fail-closed
 *                      precondition (step 0) — the ordinary create-tenant failure (a deploy-state
 *                      mismatch, an unreachable slave). Every mutation is after that step, so nothing was
 *                      deployed and nothing was recorded: the tenant is NAMED and yet carries no row.
 *                      NOT purgeable — there is nothing out there to purge.
 *   - "orphan"       — a guid was frozen, the run mutated, and NO tenants row carries the tenant. Nothing
 *                      else in the product can name it (every other removal verb resolves BY that row),
 *                      so the run screen is the only place it can be reached. PURGEABLE.
 *   - "unfinished"   — the row is "provisioning": record-provisional wrote it and the run never settled
 *                      it. The same state the Tenants list badges "unfinished". PURGEABLE.
 *   - "live"         — the row is "active"/"suspended": record-inventory SETTLED the tenant and its app
 *                      rows, i.e. the fan-out synced and the namespace smoke-checked. NOT purgeable.
 *   - "offboarded" — the row is settled UN-DEPLOYED (kept for audit). Its cluster state was
 *                      deliberately kept, so a purge is still the verb that reaps it — but not from HERE:
 *                      one removal already ran on this screen's tenant, and the tenant page is where the
 *                      second half is aimed. NOT purgeable.
 *   - "purged" — the row is settled DEPROVISIONED: a tenant-purge completed,
 *                      so the Tenant CR, the namespace, the Vault path, the object-storage credential and
 *                      the Mongo databases are gone and only the object-storage bucket survives. Its own
 *                      state rather than a second reading of "offboarded", because the screen says the
 *                      opposite thing about each: one still has a removal ahead of it, the other has
 *                      nothing left to remove. NOT purgeable.
 *
 *  WHY the answer is resolved from the ROW and not from the run's kind + status. `activate` (the
 *  first-admin invite) is deliberately the LAST create-tenant step, placed AFTER record-inventory
 *  precisely so a failed invite never rolls back a live deployment (create-tenant.run.ts) — and
 *  create-tenant-activate throws on any non-2xx other than 409, with an HTTP 503 from a freshly started
 *  tenant example-auth a known live condition. A run that failed ONLY there therefore sits behind a tenant
 *  that is deployed, recorded active and serving. Deciding from "failed create-tenant" alone would tell
 *  that operator the tenant "may still exist in GitOps and on the cluster" and is "listed as unfinished
 *  on the Tenants page" — both untrue — and would offer the one verb that deletes the Tenant CR and
 *  thereby drops the live tenant's Mongo databases and its Vault path. The Tenants list and the tenant
 *  detail page already gate their purge on status === "provisioning" (web tenantRows.ts); this makes the
 *  run screen decide from the same fact, so it cannot describe — or act on — the same tenant differently.
 *
 *  WHY "no row" alone is NOT enough to call a tenant an orphan. record-provisional is create-tenant's
 *  first step after attest-target and the ONLY step before any mutation — so a run refused AT
 *  attest-target has no tenants row for the very same reason a mid-deploy failure has none, and the two
 *  are opposite truths: the first deployed NOTHING, the second may have left a fan-out, an isolation
 *  AppProject, a namespace and a Tenant CR standing. The server tells them apart from the run's own step
 *  rows, which is where "how far did this run get" is recorded.
 *
 *  WHAT KEEPS BOTH CONSUMERS TOTAL. Purge is offered for "orphan" and "unfinished" and for nothing else,
 *  decided in ONE place — web runScreen.ts runTenantPurgeTarget, an exhaustive `switch` over every member.
 *  That switch is the hard guarantee: a member added here and not answered there fails the typecheck,
 *  full stop. FailedCreateTenantCallout then renders one branch per member with NO catch-all, its last arm
 *  narrowing to a single state, so the words follow the same partition as the action. That arrangement is
 *  a discipline rather than a proof — a new member shaped like an existing one (carrying the same `row`)
 *  would type-check inside whichever arm happens to be last and be DESCRIBED as that state — which is why
 *  every addition gets its own branch here and there, and why the switch above is the thing that cannot be
 *  skipped. Back when the browser kept its own copy of this union it did not even learn of "not-deployed":
 *  the unknown state fell into the last arm, that arm read `row` off a state that carries none, and the
 *  TypeError unmounted the whole Run screen. */
export type RunTenantStateView =
  | { state: "none"; reason: string }
  | { state: "not-deployed"; target: PurgeTenantTarget }
  | { state: "orphan"; target: PurgeTenantTarget }
  | { state: "unfinished"; target: PurgeTenantTarget; row: RunTenantRowView }
  | { state: "live"; target: PurgeTenantTarget; row: RunTenantRowView }
  | { state: "offboarded"; target: PurgeTenantTarget; row: RunTenantRowView }
  | { state: "purged"; target: PurgeTenantTarget; row: RunTenantRowView };

/** GET /api/consumers/channels — the channel table the onboard wizard reads: WHICH stages a release
 *  channel may reach. Served LITERALLY from the platform repo's platform/values-common.yaml
 *  (global.channelStages) — the ONE table, enforced in the release pipeline at the point that
 *  writes; the controller keeps no copy. Keys are the channels the file states (normally all
 *  three), each value the stages that channel admits, in the file's own order. */
export interface ChannelStagesView {
  channelStages: Partial<Record<ReleaseChannel, Stage[]>>;
}
