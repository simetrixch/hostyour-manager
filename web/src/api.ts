import type {
  ClustersView, ReleasesView, RunView, ServerView, HealthView,
  BranchesView, BranchDiffView, ResetRequest, ResetResult, ApiErrorCode,
  // The tenant-purge targeting surface + the two reads that name one. Declared
  // ONCE in shared/api-types.ts and returned by the server domain module itself (tenant-orphans.ts), so
  // the shapes this client resolves to are the shapes that module answers in — there is no browser-side
  // twin of them left to fall behind a server change, which is exactly how a `not-deployed` state the
  // callout had never heard of once unmounted the whole Run screen.
  TenantPurgeInput, OrphanScanView, RunTenantStateView,
  // The two live-reconciliation payloads. Same rule, same reason: the server
  // answers in these exact shapes and this client resolves to them, so the `argo` union the cards
  // narrow on `.ok` is the server's OWN union — a member added there stops THIS build, instead of
  // reaching a ternary chain that has never heard of it.
  ConsumerLiveView, TenantLiveView,
  // The DETECTED-consumer surface: the scan result the Detected tab renders and
  // the row-less live probe its rows are verified with. One declaration, both ends — as above.
  DetectedScanView, ConsumerLiveProbeView,
  // The channel table the onboard wizard reads — served literally from the platform repo's
  // platform/values-common.yaml (global.channelStages); the manager keeps no copy.
  ChannelStagesView,
  // The operator-key rows the /servers/keys page renders. One declaration, both ends — as above.
  OperatorKeyView,
} from "../../shared/api-types.ts";
// The tenant reads project three server enums verbatim; importing them (rather than restating the
// literals here) is what makes a rename in shared/enums.ts break THIS build — the same rule
// runKinds.ts follows for RunKind. TenantStatus carries the tenant-only "provisioning" state.
// AppProvenance is ONE list for both unit kinds, so ConsumerView and TenantView print the same word
// for the same fact — a hand-written union here is what let the two cards disagree about it.
import type { AppProvenance, RunKind, Stage, TenantAdminState, TenantStatus } from "../../shared/enums.ts";

/** Carries the server's error CODE (not just the message) so a caller can branch on it —
 *  e.g. the Reset wizard renders a DB-only form on NOT_CONFIGURED instead of a dead end. */
export class ApiRequestError extends Error {
  readonly code: ApiErrorCode | undefined;
  constructor(message: string, code?: ApiErrorCode) {
    super(message);
    this.name = "ApiRequestError";
    this.code = code;
  }
}

/**
 * Typed API client. Same-origin fetch, so the browser sends
 * Sec-Fetch-Site: same-origin automatically — the server's csrf guard is satisfied without a
 * token. A 401 means the session lapsed → bounce to OIDC login. Errors surface ApiError.message.
 */
async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (init?.body) headers["content-type"] = "application/json";
  const res = await fetch(path, { ...init, headers });
  if (res.status === 401) {
    window.location.assign("/auth/login");
    throw new Error("Not signed in");
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string; code?: ApiErrorCode } | null;
    throw new ApiRequestError(body?.message ?? `Request failed (${res.status})`, body?.code);
  }
  return (await res.json()) as T;
}

const post = <T>(path: string, body: Record<string, unknown> = {}): Promise<T> =>
  req<T>(path, { method: "POST", body: JSON.stringify(body) });
/** PUT — a full replacement of one addressed thing, where POST creates or triggers. The size table's
 *  update is the one caller: a size is read and written as a whole (all six figures at once), so a
 *  partial update would be a screen silently keeping a number the operator believed they replaced. */
const put = <T>(path: string, body: Record<string, unknown>): Promise<T> =>
  req<T>(path, { method: "PUT", body: JSON.stringify(body) });

/** Public health probe — carries the running version (image tag) for the UI footer. */
export const getHealth = (): Promise<HealthView> => req<HealthView>("/healthz");

export const getClusters = (): Promise<ClustersView> => req<ClustersView>("/api/clusters");
/** Which release each installation stands on, and which version each of its platform apps runs. The
 *  app half is fed by the SAME pin search that builds the registry reaper's protected floor, so a
 *  version shown here is a version retention refuses to delete. */
export const getReleases = (): Promise<ReleasesView> => req<ReleasesView>("/api/releases");
export const listRuns = (): Promise<RunView[]> => req<RunView[]>("/api/runs");
export const getRun = (id: string): Promise<RunView> => req<RunView>(`/api/runs/${id}`);

// Typed on RunKind rather than on string: the plan route answers "unknown run kind" for anything
// else, and a front end that could still spell a kind the way it was spelled before a rename would
// find that out from a failed run instead of from this build.
export const planRun = (kind: RunKind, params: Record<string, unknown> = {}): Promise<{ runId: string }> =>
  post<{ runId: string }>("/api/runs", { kind, params });

// The API carries one-time secrets base64-encoded (server decodes; the value is memory-only,
// never persisted). UTF-8-safe so non-ASCII passwords survive.
function toBase64(s: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(s)));
}
function encodeSecrets(secrets?: Record<string, string>): { secrets: Record<string, string> } | undefined {
  if (!secrets) return undefined;
  return { secrets: Object.fromEntries(Object.entries(secrets).map(([k, v]) => [k, toBase64(v)])) };
}

export const approveRun = (id: string, secrets?: Record<string, string>): Promise<unknown> =>
  post(`/api/runs/${id}/approve`, encodeSecrets(secrets) ?? {});
/** Soft-delete a run: it disappears from the runs list, while its row and complete log
 *  stay in the audit DB for retroactive inspection. The server refuses with 409 unless
 *  the run is planned, failed, or cancelled — a succeeded run is the permanent record of
 *  a live deployment and an in-flight run must settle first. */
export const deleteRun = (id: string): Promise<unknown> => req(`/api/runs/${id}`, { method: "DELETE" });
export const cancelRun = (id: string): Promise<unknown> => post(`/api/runs/${id}/cancel`);
export const retryRun = (id: string, stepName?: string, secrets?: Record<string, string>): Promise<unknown> =>
  post(`/api/runs/${id}/retry`, { ...(stepName ? { stepName } : {}), ...encodeSecrets(secrets) });
export const skipRun = (id: string, stepName: string, reason: string): Promise<unknown> => post(`/api/runs/${id}/skip`, { stepName, reason });
export const abortRun = (id: string, secrets?: Record<string, string>): Promise<unknown> =>
  post(`/api/runs/${id}/abort`, { ...encodeSecrets(secrets) });

// Server inventory (adopt entry point + inventory CRUD).
export const listServers = (): Promise<{ servers: ServerView[] }> => req("/api/servers");
export interface NewServer {
  name: string;
  host: string;
  sshUser: string;
  sshPort?: number;
  lanHost?: string;
  /** The address the master's in-cluster components will dial this machine's kube-apiserver on once
   *  it is a slave — the cluster map's apiHost. */
  tailnetHost?: string;
  notes?: string;
  /** Optional stored bootstrap password (enables 1-click adopt; sealed keyfile-encrypted). */
  password?: string;
}
export const createServer = (input: NewServer): Promise<{ server: ServerView }> =>
  post("/api/servers", input as unknown as Record<string, unknown>);
export const deleteServerById = (id: string): Promise<unknown> => req(`/api/servers/${id}`, { method: "DELETE" });
/** 1-click adopt from the list. Uses the server's stored password if present; otherwise the
 *  returned run is planned and the Run screen prompts for the password. */
export const adoptServer = (id: string, opts?: { password?: string; intendedDomain?: string }): Promise<{ runId: string; approved: boolean }> =>
  post(`/api/servers/${id}/adopt`, opts ?? {});
/** Plan a cluster-deploy-slave Run for a READY (adopted) server. The run comes back planned;
 *  approval on the Run screen needs no secret — the read-only repo PAT is always
 *  auto-sourced from the platform Vault (GITOPS_REPO_PAT); there is no manual override. */
export const deploySlave = (serverId: string, opts: { stage: string; domain: string }): Promise<{ runId: string }> =>
  planRun("cluster-deploy-slave", { serverId, stage: opts.stage, domain: opts.domain });
/** Rebuild the machine layer of a cluster that is already live, in place. It takes ONLY the server:
 *  the FQDN and the stage are what that server's active cluster row already says, so there is nothing
 *  for the operator to re-state and nothing to get wrong. */
export const redeploySlave = (serverId: string): Promise<{ runId: string }> => planRun("cluster-redeploy", { serverId });
/** Raise the platform version a live cluster stands on: pin the cluster map, re-run the installer over
 *  SSH, then wait for ArgoCD. The operator names version + channel; the run stamps the timestamp and
 *  mints the tag. The channel ceiling is checked against the cluster's marked stage before the pin. */
export const releaseCluster = (serverId: string, opts: { version: string; channel: string }): Promise<{ runId: string }> =>
  planRun("cluster-release", { serverId, version: opts.version, channel: opts.channel });

// The three tailnet repair run kinds. Each takes ONLY the server: the address they reach it on is the
// public one and the plan states it, and a rejoin reads the FQDN and the stage off the server's own
// cluster row — so there is nothing here for the operator to re-state and nothing to get wrong.
/** Take the host off the private network. It keeps answering on its public address, which is how
 *  the two run kinds below reach it afterwards. */
export const disconnectTailnet = (serverId: string): Promise<{ runId: string }> => planRun("cluster-tailnet-disconnect", { serverId });
/** Put the host back on with the credential it already holds — nothing is minted, and the master is
 *  not touched. */
export const reconnectTailnet = (serverId: string): Promise<{ runId: string }> => planRun("cluster-tailnet-reconnect", { serverId });
/** Log the host out and join it again with a credential minted on the master — for the case
 *  reconnect cannot answer, where the host holds none. */
export const rejoinTailnet = (serverId: string): Promise<{ runId: string }> => planRun("cluster-tailnet-rejoin", { serverId });

// The password-login switch. A run kind and not a PATCH field: nothing this manager stores changes
// what a daemon answers on port 22, so the switch has to be a run that writes the drop-in,
// validates it, reloads the daemon and reads back what the daemon resolved.
/** Stop this host's sshd taking passwords, and destroy the bootstrap password sealed for it — two
 *  doors. The run proves key login works before it shuts either. */
export const disablePasswordLogin = (serverId: string): Promise<{ runId: string }> =>
  planRun("cluster-password-login-disable", { serverId });
/** Let this host's sshd take passwords again, for a repair. Nothing re-seals a bootstrap password:
 *  this run has none, and adoption is what shuts the door in the first place. */
export const enablePasswordLogin = (serverId: string): Promise<{ runId: string }> =>
  planRun("cluster-password-login-enable", { serverId });

// A human operator's own key on the machines. The ROWS are plain CRUD — a public key and a label,
// no secret anywhere — while everything that touches a host is a run, because putting a key on a
// machine is an act with a plan, an approval and a log.
export const listOperatorKeys = (): Promise<{ keys: OperatorKeyView[] }> => req("/api/operator-keys");
export const createOperatorKey = (input: { label: string; publicKey: string }): Promise<{ key: OperatorKeyView }> =>
  post("/api/operator-keys", input);
/** Forgets the row. It takes nothing off any machine, and the server refuses while a stored reading
 *  still finds the key on a host — the removal run kind needs this row to name the line it deletes. */
export const deleteOperatorKey = (id: string): Promise<unknown> => req(`/api/operator-keys/${id}`, { method: "DELETE" });
/** Put ONE key in ONE host's authorized_keys. One server per run on purpose: which hosts carry a key
 *  is a per-server state, so five that took it and a sixth that refused are five runs that succeeded
 *  and one that failed, each with its own log. */
export const placeOperatorKey = (serverId: string, operatorKeyId: string): Promise<{ runId: string }> =>
  planRun("cluster-operator-key-place", { serverId, operatorKeyId });
/** Take that one line back out. A host that never carried the key is left alone and the run still
 *  succeeds; a host where the key sits under some other comment fails, saying so. */
export const removeOperatorKey = (serverId: string, operatorKeyId: string): Promise<{ runId: string }> =>
  planRun("cluster-operator-key-remove", { serverId, operatorKeyId });
/** Read a host's authorized_keys and change nothing. The only way a key that appeared while nobody
 *  was placing anything becomes visible. */
export const readAuthorizedKeys = (serverId: string): Promise<{ runId: string }> =>
  planRun("cluster-authorized-keys-read", { serverId });

// GitOps repo — the Branches view (read-only) and the Reset wizard (destructive). Both need
// config.github on the server (GITHUB_REPO + GITHUB_WRITE_PAT); without it the endpoints refuse
// with NOT_CONFIGURED and the message renders verbatim — never a quiet empty list.
export const getBranches = (): Promise<BranchesView> => req<BranchesView>("/api/branches");
export const getBranchDiff = (name: string): Promise<BranchDiffView> =>
  req<BranchDiffView>(`/api/branches/${encodeURIComponent(name)}/diff`);
/** DESTRUCTIVE: strips the selected install branches' pointer files, deletes the branches on
 *  GitHub and (optionally) wipes the Manager DB. Every safety rule is re-validated
 *  server-side — the wizard is UX, not the boundary. */
export const resetManager = (input: ResetRequest): Promise<ResetResult> =>
  post<ResetResult>("/api/reset", input as unknown as Record<string, unknown>);

// Consumer onboarding. The onboard POST returns a runId whose run sits in
// `planning` while the gate-runner validates — the operator watches the live gate report on the
// Run screen (the SSE log) and approves there. The lifecycle triggers plan synchronously.
export interface OnboardTargetView {
  id: string;
  domain: string;
  stage: string;
  tier: string;
  status: string;
}
export interface ConsumerView {
  id: string;
  name: string;
  clusterId: string;
  domain: string;
  stage: string;
  repoUrl: string | null;
  chartPath: string | null;
  /** The server enum verbatim (shared/enums.ts APP_PROVENANCE): "manager" marks a consumer this
   *  Manager onboarded and gate-validated, "adopted" one whose row was RECONSTRUCTED from the
   *  GitOps registration by an adopt-consumer run and never gate-validated by it. */
  provenance: AppProvenance;
  status: "active" | "suspended" | "offboarded";
  lastRunId: string | null;
  createdAt: number;
}
export interface OnboardInput {
  consumerName: string;
  repoURL: string;
  /** The release the onboarding TRIGGERS: version x.y.z + channel. The release script in the repo
   *  mints (or reuses) the full tag from them — the manager never composes a tag. */
  version: string;
  channel: "alpha" | "beta" | "stable";
  /** Deployable form: the target cluster (its stage is the cluster's own). Exactly one of clusterId
   *  and stage is sent. */
  clusterId?: string;
  /** Build-only form: the stage the ONE triggered release run puts the release on. */
  stage?: string;
  owner: string;
  chartPath?: string;
  /** The ONE per-consumer GitHub PAT (required — every consumer repo is private). Sent once over
   *  TLS; the Manager seals it server-side and it never appears in any run/params/log. */
  repoPat: string;
}
export const listConsumers = (): Promise<ConsumerView[]> => req<ConsumerView[]>("/api/consumers");
export const getConsumerLive = (appId: string): Promise<ConsumerLiveView> => req<ConsumerLiveView>(`/api/consumers/${appId}/live`);
export const listOnboardTargets = (): Promise<OnboardTargetView[]> => req<OnboardTargetView[]>("/api/consumers/targets");
/** The channel table (GET /api/consumers/channels): which stages each release channel may reach —
 *  read literally from platform/values-common.yaml global.channelStages, never a wizard copy. The
 *  pipeline enforces the ceiling at the point that writes; the wizard only uses this to offer valid
 *  choices up front. */
export const getChannelStages = (): Promise<ChannelStagesView> => req<ChannelStagesView>("/api/consumers/channels");
export const onboardConsumer = (input: OnboardInput): Promise<{ runId: string }> =>
  post<{ runId: string }>("/api/consumers", input as unknown as Record<string, unknown>);
export const offboardConsumer = (appId: string): Promise<{ runId: string }> => post(`/api/consumers/${appId}/offboard`);
/** The by-NAME identity a purge (force-offboard) targets — an orphaned consumer has no appId/row, so
 *  purge is keyed on name + stage + cluster (the G1 identity law), never a path :appId. */
export interface PurgeInput {
  consumerName: string;
  stage: "dev" | "test" | "prod";
  clusterId: string;
}
/** Force-remove a consumer's WHOLE footprint by NAME (works with NO inventory row — the orphaned
 *  partial-onboard case). Plans synchronously and returns a { runId } to approve on the Run screen. */
export const purgeConsumer = (input: PurgeInput): Promise<{ runId: string }> =>
  post<{ runId: string }>("/api/consumers/purge", input as unknown as Record<string, unknown>);
export const suspendConsumer = (appId: string): Promise<{ runId: string }> => post(`/api/consumers/${appId}/suspend`);
export const resumeConsumer = (appId: string): Promise<{ runId: string }> => post(`/api/consumers/${appId}/resume`);
/** The last step of putting a new secret value in front of a consumer: roll its pods so they read
 *  their Secrets again. Moves no secret itself — an env var is materialized at container start, so a
 *  value already written to Vault and fetched into the Secret reaches a RUNNING pod only when
 *  something restarts it. */
export const restartConsumerWorkloads = (appId: string): Promise<{ runId: string }> => post(`/api/consumers/${appId}/restart-workloads`);

/** One row of the size table — what `small`, `medium` and `large` mean on THIS installation, for ONE
 *  component of a unit. A unit's ceiling is `base` plus, when it brings them, `postgresql` and
 *  `mongodb` times its member count, all read at the unit's one size. */
export interface UnitSizeView {
  component: "base" | "postgresql" | "mongodb";
  name: "small" | "medium" | "large";
  requestsCpu: string;
  requestsMemory: string;
  limitsCpu: string;
  limitsMemory: string;
  pods: number;
  persistentVolumeClaims: number;
}
export const listUnitSizes = (): Promise<{ sizes: UnitSizeView[] }> => req<{ sizes: UnitSizeView[] }>("/api/unit-sizes");

/** The three sizes as they apply to ONE unit: the figures already SUMMED from what that unit brings,
 *  with the parts they were summed from. The picker shows these rather than the bare table, because a
 *  unit's ceiling is base + postgresql + mongodb x members and nobody should add that up by hand. */
export interface UnitSizeOptions {
  unit: string;
  brings: { postgresql: boolean; mongodb: "shared" | "standalone" | "replicaset" };
  /** false ⇒ what the unit brings could not be read (consumer onboarding unwired), so the figures are
   *  the base rows only and the dialog says so. */
  composed: boolean;
  sizes: Array<{
    name: "small" | "medium" | "large";
    quota: Omit<UnitSizeView, "name" | "component">;
    parts: Array<{ component: UnitSizeView["component"]; members: number; each: Omit<UnitSizeView, "name" | "component"> }>;
  }>;
}
export const unitSizeOptions = (kind: "consumer" | "tenant", id: string): Promise<UnitSizeOptions> =>
  req<UnitSizeOptions>(kind === "consumer" ? `/api/consumers/${id}/sizes` : `/api/tenants/${id}/sizes`);
/** Change what one size MEANS. It reaches no running unit: a registration carries the figures it was
 *  written with, so an already-deployed unit moves only when setConsumerSize/setTenantSize rewrites
 *  it. Two acts on purpose — re-pricing a table and re-sizing a customer are not the same thing. */
export const updateUnitSize = (component: string, name: string, size: Omit<UnitSizeView, "name" | "component">): Promise<{ size: UnitSizeView }> =>
  put<{ size: UnitSizeView }>(`/api/unit-sizes/${component}/${name}`, size as unknown as Record<string, unknown>);
/** Put a consumer on a size — and, when it is the size it already has, onto that size's CURRENT
 *  figures. This is the only path by which a table edit reaches something already deployed. */
export const setConsumerSize = (appId: string, size: string): Promise<{ runId: string }> =>
  post<{ runId: string }>(`/api/consumers/${appId}/size`, { size });
/** Backup: close access, dump every store into the Storage Box folder, verify it, reopen — the
 *  folder stays and the consumer keeps running where it is. */
export const backupConsumer = (appId: string): Promise<{ runId: string }> => post(`/api/consumers/${appId}/backup`);
/** Restore the consumer from its Storage Box folder onto the named cluster — the disaster-recovery
 *  half of the one relocation mechanism, and the path that rebuilds an offboarded consumer. */
export const restoreConsumer = (appId: string, targetClusterId: string): Promise<{ runId: string }> =>
  post<{ runId: string }>(`/api/consumers/${appId}/restore`, { targetClusterId });
/** Move the consumer to the named cluster through its Storage Box folder — dump, restore, repoint,
 *  one DNS record updated; the source is cleared last. */
export const migrateConsumer = (appId: string, targetClusterId: string): Promise<{ runId: string }> =>
  post<{ runId: string }>(`/api/consumers/${appId}/migrate`, { targetClusterId });

/** Scan every ACTIVE cluster for consumers the inventory does not know — the consumer twin of
 *  scanTenantOrphans below, in TWO halves. The GitOps registrations diffed against the inventory
 *  (`detected`), and the clusters' own consumer NAMESPACES diffed against both books
 *  (`clusterOrphans`) — the second because the first starts from the registrations and therefore
 *  cannot express a consumer that has none, which is the case where the pods keep serving and nothing
 *  in the product can see them.
 *
 *  EXPLICIT by design: this fetches the install branches AND smokes every consumer namespace on every
 *  active cluster, so it is wired to an operator action and never to a page load. Fail-soft by
 *  contract, and PER HALF — see DetectedScanView (shared/api-types.ts) for what `error`, `reason`, a
 *  non-empty `skipped` and a non-empty `unscanned` each mean, and why none of them may be rendered as
 *  "none detected". */
export const scanDetectedConsumers = (): Promise<DetectedScanView> => req<DetectedScanView>("/api/consumers/detected");
/** The by-NAME identity an adopt targets — identical to PurgeInput (the G1 identity law), its own
 *  name so the two run kinds read as what they are: one removes a footprint, one records it. */
export interface AdoptConsumerInput {
  consumerName: string;
  stage: Stage;
  clusterId: string;
}
/** Reconstruct a DETECTED consumer's missing inventory row FROM its GitOps pointer — nothing is
 *  deployed or changed on the cluster; the run attests the live state and writes the one row that
 *  makes the consumer visible/offboardable again (provenance "adopted"). Plans synchronously and
 *  returns a { runId } to approve on the Run screen. */
export const adoptConsumer = (input: AdoptConsumerInput): Promise<{ runId: string }> =>
  post<{ runId: string }>("/api/consumers/adopt", input as unknown as Record<string, unknown>);
/** The NAME-keyed live probe: the same live read getConsumerLive answers, without an appId — a
 *  detected consumer has no row. `repoURL` is the pointer's repo (from the scan result): the generated
 *  Application is multi-source, so the two compared revisions are resolved FOR that repo. */
export const probeConsumerLive = (q: { clusterId: string; name: string; stage: Stage; repoURL?: string }): Promise<ConsumerLiveProbeView> =>
  req<ConsumerLiveProbeView>(
    `/api/consumers/live?clusterId=${encodeURIComponent(q.clusterId)}&name=${encodeURIComponent(q.name)}&stage=${encodeURIComponent(q.stage)}` +
      (q.repoURL ? `&repoURL=${encodeURIComponent(q.repoURL)}` : ""),
  );
// Tenant (multi-app) onboarding. Same thin contract as the consumer
// client above: create-tenant + add-app POST through the streaming planner and return a { runId }
// whose run sits in `planning` while the T1..T4 fan-out gates validate — the operator watches
// the live gate report on the Run screen and approves there. remove-app + the tenant-wide
// lifecycle (suspend/resume/offboard) plan synchronously. The list/detail reads stay live even
// when the mutating routes answer 501 NOT_CONFIGURED (the catalog write PAT is absent).

/** A cluster a tenant can be created on (mirrors OnboardTargetView; tenants share the clusters). */
export interface TenantTargetView {
  id: string;
  domain: string;
  stage: string;
  tier: string;
  status: string;
}
/** One tenant list/detail row — the tenant identity + its lifecycle state instead of a consumer's
 *  single repoUrl/chartPath. Mirrors the server TENANT_COLUMNS projection. */
export interface TenantView {
  id: string;
  guid: string;
  subdomain: string;
  clusterId: string;
  domain: string;
  stage: Stage;
  seedUsers: boolean;
  suspended: boolean;
  owner: string | null;
  /** The same server enum ConsumerView carries, taken from shared/enums.ts rather than restated as a
   *  union here: a literal that leaves that list must break THIS build, not survive as a word the
   *  server never sends. A tenant is only ever "manager" — there is no adopt run kind for one. */
  provenance: AppProvenance;
  /** "provisioning" ⇒ create-tenant recorded this row BEFORE deploying and its run never finished
   * — the tenant may be half-deployed or not deployed at all. */
  status: TenantStatus;
  /** What the last administrator check found, or null where none has run yet.
   *
   *  Null is not "fine": a tenant that has never been checked must not read as healthy, which is
   *  why the three are nullable together rather than defaulted to something reassuring. */
  adminState: TenantAdminState | null;
  /** How many the tenant reported. Null where the check could not reach it — a count of zero and
   *  no answer at all say opposite things. */
  adminCount: number | null;
  adminCheckedAt: number | null;
  lastRunId: string | null;
  createdAt: number;
  updatedAt: number;
}
/** One app of the tenant's guid × apps[] matrix — a MEMBER of its own: namespace <guid>-<name>,
 *  AppProject <guid>-<name>, Application <guid>-<name>-<stage>. */
export interface TenantAppView {
  id: string;
  name: string;
  status: TenantStatus;
  lastRunId: string | null;
  createdAt: number;
}
/** GET /api/tenants/:id — the tenant row plus its per-app rows. */
export type TenantDetailView = TenantView & { apps: TenantAppView[] };

/** The create-tenant wizard's raw state (before it is shaped into the request body). appNames are
 *  the dynamic apps[] rows. There is NO secret field (v1: create-tenant seeds no secrets — a tenant's
 *  charts pull from Vault via ExternalSecret), and nothing selects the trio: auth, jobs and report are
 *  mandatory members of every tenant. */
export interface TenantCreateForm {
  clusterId: string;
  subdomain: string;
  owner: string;
  /** The selected app-types with their two per-app seed tiers: seedReference ⇒ reference
   *  data (roles, navigation → the operator app is usable), seedDemo ⇒ demo/sample records. Both
   *  default off. */
  apps: { name: string; seedReference: boolean; seedDemo: boolean }[];
  seedUsers: boolean;
  /** OPTIONAL first-admin email. Empty ⇒ omitted from the body (no first-admin invite). */
  adminEmail?: string;
}
/** The POST /api/tenants body == the server's CreateTenantRequest (stage/domain are derived from
 *  the target cluster row server-side, never sent). */
export interface CreateTenantBody {
  clusterId: string;
  subdomain: string;
  owner: string;
  apps: { name: string; seedReference: boolean; seedDemo: boolean }[]; // per-app seed tiers; default off
  seedUsers: boolean; // flips the tenant IdP's user boot-seed
  adminEmail?: string; // OPTIONAL — omitted when the operator left the field blank
}

/** Shape the wizard state into the CreateTenantRequest body: trim every field, drop blank app rows,
 *  and de-duplicate app names (the server refines uniqueness too — this is the early UX guard). */
export function buildCreateTenantBody(f: TenantCreateForm): CreateTenantBody {
  const seen = new Set<string>();
  const apps: { name: string; seedReference: boolean; seedDemo: boolean }[] = [];
  for (const raw of f.apps) {
    const name = raw.name.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    apps.push({ name, seedReference: raw.seedReference, seedDemo: raw.seedDemo }); // carry both seed tiers to the server
  }
  const adminEmail = f.adminEmail?.trim();
  return {
    clusterId: f.clusterId,
    subdomain: f.subdomain.trim(),
    owner: f.owner.trim(),
    apps,
    seedUsers: f.seedUsers,
    // Omit the field entirely when blank (never send adminEmail: "" — the server treats absent as "no invite").
    ...(adminEmail ? { adminEmail } : {}),
  };
}

export const listTenants = (): Promise<TenantView[]> => req<TenantView[]>("/api/tenants");
export const listTenantTargets = (): Promise<TenantTargetView[]> => req<TenantTargetView[]>("/api/tenants/targets");
/** The tenant app-type catalog (GET /api/tenants/app-catalog) — the app-types the create-tenant wizard
 *  offers as checkboxes, discovered from catalog charts/example-engine/values-<app>.yaml. The
 *  server route is fail-soft (empty when tenant onboarding is not wired or catalog is momentarily
 *  unreadable), so the wizard just shows an inline "catalog unavailable" note and can still onboard a
 *  tenant with no apps. */
export const listTenantAppCatalog = (): Promise<string[]> =>
  req<{ apps: string[] }>("/api/tenants/app-catalog").then((r) => r.apps);
export const getTenant = (id: string): Promise<TenantDetailView> => req<TenantDetailView>(`/api/tenants/${id}`);
export const getTenantLive = (id: string): Promise<TenantLiveView> => req<TenantLiveView>(`/api/tenants/${id}/live`);
export const createTenant = (form: TenantCreateForm): Promise<{ runId: string }> =>
  post<{ runId: string }>("/api/tenants", buildCreateTenantBody(form) as unknown as Record<string, unknown>);
export const addTenantApp = (tenantId: string, app: string, opts?: { seedReference?: boolean; seedDemo?: boolean }): Promise<{ runId: string }> =>
  post<{ runId: string }>(`/api/tenants/${tenantId}/apps`, { app, ...(opts ?? {}) });
export const removeTenantApp = (tenantId: string, app: string): Promise<{ runId: string }> =>
  post<{ runId: string }>(`/api/tenants/${tenantId}/apps/${encodeURIComponent(app)}/remove`);
export const offboardTenant = (tenantId: string): Promise<{ runId: string }> => post(`/api/tenants/${tenantId}/offboard`);

/** Scan the LIVE GitOps pointers for tenants the inventory does not know. EXPLICIT by design: this
 *  clones catalog server-side, so it is wired to an operator action and never to a page load.
 *  Fail-soft by contract — see OrphanScanView (shared/api-types.ts) for what `error`, `reason` and a
 *  non-empty `skipped` each mean, and why none of them may be rendered as "no orphans found". */
export const scanTenantOrphans = (): Promise<OrphanScanView> => req<OrphanScanView>("/api/tenants/orphans");
/** Force-remove a tenant's WHOLE footprint by GUID (works with NO inventory row — the orphaned partial
 *  create-tenant case). Plans through the streaming planner and returns a { runId } to approve on the
 *  Run screen; nothing is deleted until that approval. */
export const purgeTenant = (input: TenantPurgeInput): Promise<{ runId: string }> =>
  post<{ runId: string }>("/api/tenants/purge", input as unknown as Record<string, unknown>);
/** What the tenant a create-tenant run MINTED is right now, decided SERVER-SIDE from the tenants row —
 *  never from the run's kind + status. The union it answers in is RunTenantStateView
 *  (shared/api-types.ts), the SAME declaration resolveRunTenantState returns: the six states, why the row
 *  decides, and what keeps the run screen's two consumers total are all documented there. */
export const getRunTenantState = (runId: string): Promise<RunTenantStateView> =>
  req<RunTenantStateView>(`/api/tenants/runs/${runId}/tenant-state`);
export const suspendTenant = (tenantId: string): Promise<{ runId: string }> => post(`/api/tenants/${tenantId}/suspend`);
export const resumeTenant = (tenantId: string): Promise<{ runId: string }> => post(`/api/tenants/${tenantId}/resume`);
/** The tenant twin of restartConsumerWorkloads — one tenant owns one namespace per member, and the
 *  run rolls all of them under one stamp. */
export const restartTenantWorkloads = (tenantId: string): Promise<{ runId: string }> => post(`/api/tenants/${tenantId}/restart-workloads`);
/** The tenant twin of setConsumerSize — the figures bound EACH member namespace of the tenant. */
export const setTenantSize = (tenantId: string, size: string): Promise<{ runId: string }> =>
  post<{ runId: string }>(`/api/tenants/${tenantId}/size`, { size });
/** Backup: close access, dump every store of the whole bracket into the Storage Box folder, verify
 *  it, reopen — the folder stays and the tenant keeps running where it is. */
export const backupTenant = (tenantId: string): Promise<{ runId: string }> => post(`/api/tenants/${tenantId}/backup`);
/** Restore the tenant from its Storage Box folder onto the named cluster — rebuilds an offboarded
 *  tenant data-identically, under its unchanged guid. */
export const restoreTenant = (tenantId: string, targetClusterId: string): Promise<{ runId: string }> =>
  post<{ runId: string }>(`/api/tenants/${tenantId}/restore`, { targetClusterId });
/** Move the tenant to the named cluster through its Storage Box folder — the whole bracket, one
 *  wildcard record updated; the source is cleared last. */
export const migrateTenant = (tenantId: string, targetClusterId: string): Promise<{ runId: string }> =>
  post<{ runId: string }>(`/api/tenants/${tenantId}/migrate`, { targetClusterId });

/** The invite-mail delivery outcome — a zod-free mirror of the server's ConsumerActivationMail, kept
 *  out of the web bundle deliberately (same rule as api-types.ts). */
export interface InviteMailOutcome {
  status: "sent" | "failed" | "skipped";
  transport: string;
  detail?: string;
}
/** What POST /api/tenants/:id/invite-admin resolved to (server tenant-admin-invite.ts): `invited`
 *  created a fresh first admin, `resent` re-issued the pending admin's link, `already-activated` = the
 *  admin was already set up (nothing to send). `activateUrl` is a one-time root-admin credential —
 *  present only for invited|resent, shown once and stored NOWHERE. */
export interface TenantInviteAdminResult {
  outcome: "invited" | "resent" | "already-activated";
  activateUrl: string | null;
  mail: InviteMailOutcome | null;
  message: string;
}
/** (Re)send a tenant's first-admin invite (owner-approved invite+resend). Synchronous — unlike
 *  suspend/resume/offboard this returns the RESULT directly (activate_url + mail outcome), NOT a
 *  { runId }, because example-auth's bootstrap invite is a single-shot call the operator watches inline,
 *  not a plan-then-approve run. The email is PII, sent plaintext (not a secret via encodeSecrets); the
 *  returned activate_url is a credential the caller surfaces once and never persists. */
export const inviteTenantAdmin = (tenantId: string, adminEmail: string): Promise<TenantInviteAdminResult> =>
  post<TenantInviteAdminResult>(`/api/tenants/${tenantId}/invite-admin`, { email: adminEmail });
