// In-memory kube fakes for the onboarding domain tests — no cluster, no network. Script the
// Application status the master watch observes, and the smoke/deploy-state a cluster read returns.
import type { MasterArgoReader, ArgoAppStatus, ArgoAppStatusMap, ArgoApplicationRow, ExternalSecretRow, ClusterReader, SmokeResult, DeployState, MasterProjectWriter, AppProjectManifest, AdmissionPolicyManifest, AdmissionPolicyBindingManifest, ClusterKubeResolver, ResolvedClusterKube, BuildRbacWriter, BuildRbacGrant, BuildRbacObject, RoleManifest, RoleBindingManifest, RepoCredentialWriter, RepoCredentialManifest, JobSpec, JobResult } from "../port.ts";
import { assertWritableProjectName, isManagerOwned, MISSING_APP_STATUS } from "../kube-map.ts";
import { AppError, errValidation } from "../../../kernel/errors.ts";

export class FakeMasterArgoReader implements MasterArgoReader {
  /** Every `namespace/name` a single-app watch was asked for — lets a test assert a run watched
   *  the GENERATED Application name (`<consumer>-<stage>`, consumerArgoAppName), not the bare one. */
  readonly watched: string[] = [];
  /** The opts the most recent single-app watch was called with — lets a test inspect the budget and
   *  the fail-fast predicate watch-sync supplied for the phase-aware watch. */
  lastWatchOpts?: { timeoutMs: number; signal?: AbortSignal; failFast?: (s: ArgoAppStatus) => boolean };

  /** `everyName` answers a set-watch for ANY name asked, and is what a fixture whose subject is not
   *  the watch scripts: enumerating names there means a name added later times out silently instead
   *  of failing where it was added. It is opt-in precisely because the default — an unscripted name
   *  reads Missing — is the completeness gate the live watch has, and a test about that gate must
   *  keep it. `statuses` still wins per name where both are given. */
  constructor(private scripted: {
    status?: ArgoAppStatus | null;
    statuses?: ReadonlyMap<string, ArgoAppStatus>;
    everyName?: ArgoAppStatus;
    throwOnGet?: Error;
    throwOnSet?: Error;
    /** What a namespace HOLDS, per namespace — what listApplications answers. An unlisted namespace
     *  reads [], which is the "the ApplicationSet has not generated anything yet" case every caller
     *  of the list retries on rather than passing. */
    applicationsByNamespace?: Record<string, readonly ArgoApplicationRow[]>;
    /** Makes listApplications THROW — the UPSTREAM a kube API answers a list with while it is
     *  restarting. A gate that polls has to read that as a failing tick, not as a step death. */
    throwOnList?: Error | undefined;
  } = {}) {}

  /** Script what a namespace holds; a later call replaces it, so a test can converge a loop. */
  setApplications(namespace: string, rows: readonly ArgoApplicationRow[]): void {
    this.scripted = { ...this.scripted, applicationsByNamespace: { ...this.scripted.applicationsByNamespace, [namespace]: rows } };
  }

  /** Make the NEXT list throw, or stop throwing when given undefined. */
  setListFailure(error: Error | undefined): void {
    this.scripted = { ...this.scripted, ...(error ? { throwOnList: error } : { throwOnList: undefined }) };
  }

  /** Every namespace listApplications was asked for, in order. */
  readonly listed: string[] = [];

  async listApplications(namespace: string): Promise<ArgoApplicationRow[]> {
    this.listed.push(namespace);
    if (this.scripted.throwOnList) throw this.scripted.throwOnList;
    return [...(this.scripted.applicationsByNamespace?.[namespace] ?? [])];
  }

  setStatus(status: ArgoAppStatus | null): void {
    this.scripted = { ...this.scripted, status };
  }

  /** Script the per-name statuses a set-watch converges on; an EXPECTED name absent from the map
   *  reads Missing (the completeness gate), mirroring the live watchApplicationSet. */
  setStatuses(statuses: ReadonlyMap<string, ArgoAppStatus>): void {
    this.scripted = { ...this.scripted, statuses };
  }

  async getApplication(): Promise<ArgoAppStatus | null> {
    if (this.scripted.throwOnGet) throw this.scripted.throwOnGet; // model an ArgoCD read failure
    return this.scripted.status ?? null;
  }

  async watchApplication(
    namespace: string,
    name: string,
    _until: (s: ArgoAppStatus) => boolean,
    opts: { timeoutMs: number; signal?: AbortSignal; failFast?: (s: ArgoAppStatus) => boolean },
  ): Promise<ArgoAppStatus> {
    // Single-shot: the test scripts the terminal status the watch converges on; the caller
    // evaluates `until` against it (so a non-terminal scripted status models a timeout, and a
    // scripted Failed/Error opPhase models the observation the live loop's fail-fast stops on). The
    // opts are recorded so a test can assert the budget + the fail-fast predicate the step supplied.
    this.watched.push(`${namespace}/${name}`);
    this.lastWatchOpts = opts;
    return this.scripted.status ?? { syncRevision: null, targetRevision: null, sync: "Unknown", health: "Unknown" };
  }

  async watchApplicationSet(
    _namespace: string,
    names: readonly string[],
    _until: (byName: ArgoAppStatusMap) => boolean,
    _opts: { timeoutMs: number; signal?: AbortSignal; labelSelector?: string },
  ): Promise<ArgoAppStatusMap> {
    if (this.scripted.throwOnSet) throw this.scripted.throwOnSet; // model an ArgoCD list failure
    // Single-shot: script the terminal per-name statuses via setStatuses; every EXPECTED name
    // absent from the script reads Missing, so the caller's `until` sees the whole set (a
    // non-terminal or incomplete scripted map models a timeout).
    const byName = new Map<string, ArgoAppStatus>();
    for (const name of names) byName.set(name, this.scripted.statuses?.get(name) ?? this.scripted.everyName ?? MISSING_APP_STATUS);
    return byName;
  }
}

export class FakeClusterReader implements ClusterReader {
  /** Every namespace deleteNamespace was called with — lets an offboard test assert the delete-namespace
   *  step issued the delete for the consumer name on the RESOLVED target client. */
  readonly deletedNamespaces: string[] = [];
  constructor(
    private scripted: {
      smoke?: SmokeResult;
      deployState?: DeployState | null;
      absentNamespaces?: readonly string[];
      /** Namespaces that answer "terminating" — a delete was accepted but a finalizer still holds
       *  them. Wins over the delete bookkeeping, so a test can model exactly the stuck case. */
      terminatingNamespaces?: readonly string[];
      /** Scripted Secret values, keyed `${namespace}/${name}/${key}` — an unlisted key reads null
       *  (an absent Secret/key), exactly like the live reader. Lets a tenant activate test seed the
       *  bootstrap token the first-admin invite reads. */
      secretValues?: Record<string, string | null>;
      /** The namespaces the cluster holds, keyed by label selector — what listNamespaces answers. An
       *  unlisted selector reads []. Lets a tenant teardown test put a member namespace on the cluster
       *  that no inventory row names, which is the case the label reap exists for. */
      namespacesByLabel?: Record<string, readonly string[]>;
      /** Smoke results PER namespace, consulted before the namespace-agnostic `smoke` above. The
       *  cluster-orphan scan smokes every consumer namespace it finds and reports each one's own ready
       *  count, so a test that cannot vary the answer per namespace cannot tell its two cases apart —
       *  a namespace still SERVING from an empty one an offboard left behind. */
      smokeByNamespace?: Record<string, SmokeResult>;
      /** How many workloads a restart reports rolled, per namespace. Unlisted falls back to the
       *  namespace's scripted smoke, then to 0 — which is the honest answer for a suspended unit. */
      workloadsPerNamespace?: Record<string, number>;
      /** Makes restartWorkloads THROW — the 403 a cluster credential without `patch` on Deployments
       *  gets. A run that could not roll the pods must FAIL rather than report a delivery that only
       *  got as far as the Secret. */
      throwOnRestart?: Error;
      /** Makes listNamespaces THROW, modelling the cluster this Manager cannot read at all: a slave
       *  that is down, a harvested bearer that expired, a kube API refusing the list. The
       *  cluster-orphan scan has to carry that OUT as an unscanned cluster rather than report the
       *  cluster as holding no orphans. */
      throwOnListNamespaces?: Error;
      /** Scripted Job outcomes, matched by the LONGEST job-name prefix (job names carry a run-unique
       *  suffix, so tests script by purpose prefix, e.g. "reloc-dump"). An unmatched name succeeds
       *  with empty logs — the benign default a happy-path relocation test wants. */
      jobResults?: Record<string, JobResult>;
      /** The PVC names of a namespace — what listPersistentVolumeClaims answers; unlisted reads []. */
      pvcsByNamespace?: Record<string, readonly string[]>;
      /** The ExternalSecrets a namespace holds — what listExternalSecrets answers; unlisted reads [],
       *  which is the "the sync has not applied them yet" case a gate retries on. */
      externalSecretsByNamespace?: Record<string, readonly ExternalSecretRow[]>;
      /** Makes listExternalSecrets THROW — the UPSTREAM a kube API answers a list with while it is
       *  restarting, which a polling gate must read as a failing tick. */
      throwOnListExternalSecrets?: Error | undefined;
    } = {},
  ) {}

  /** Every namespace listExternalSecrets was asked for, in order. */
  readonly listedExternalSecrets: string[] = [];

  /** Script what a namespace holds; a later call replaces it, so a test can converge a loop. */
  setExternalSecrets(namespace: string, rows: readonly ExternalSecretRow[]): void {
    this.scripted = {
      ...this.scripted,
      externalSecretsByNamespace: { ...this.scripted.externalSecretsByNamespace, [namespace]: rows },
    };
  }

  /** Make the NEXT list throw, or stop throwing when given undefined. */
  setExternalSecretsFailure(error: Error | undefined): void {
    this.scripted = { ...this.scripted, ...(error ? { throwOnListExternalSecrets: error } : { throwOnListExternalSecrets: undefined }) };
  }

  async listExternalSecrets(namespace: string): Promise<ExternalSecretRow[]> {
    this.listedExternalSecrets.push(namespace);
    if (this.scripted.throwOnListExternalSecrets) throw this.scripted.throwOnListExternalSecrets;
    return [...(this.scripted.externalSecretsByNamespace?.[namespace] ?? [])];
  }

  /** The admission boundary as it stands, keyed by policy name — what apply wrote, minus what delete
   *  removed. Lets a test read back the CEL clauses the onboard actually armed. */
  readonly admissionPolicies = new Map<string, { policy: AdmissionPolicyManifest; binding: AdmissionPolicyBindingManifest }>();
  /** Every name deleteAdmissionPolicy was called with — the teardown's own record. */
  readonly deletedAdmissionPolicies: string[] = [];

  setSmoke(smoke: SmokeResult): void {
    this.scripted = { ...this.scripted, smoke };
  }

  setDeployState(deployState: DeployState | null): void {
    this.scripted = { ...this.scripted, deployState };
  }

  /** Script one Secret key (see `secretValues`) — the shape readSecretValue answers. */
  setSecretValue(namespace: string, name: string, key: string, value: string | null): void {
    this.scripted = { ...this.scripted, secretValues: { ...this.scripted.secretValues, [`${namespace}/${name}/${key}`]: value } };
  }

  async smoke(namespace: string): Promise<SmokeResult> {
    return (
      this.scripted.smokeByNamespace?.[namespace] ??
      this.scripted.smoke ?? { namespaceExists: true, workloads: [], externalSecretsReady: true }
    );
  }

  /** Records the applied pair so a test can assert WHAT the boundary says, then models the live
   *  client's idempotency: the first apply of a name creates, a re-apply replaces. */
  async applyAdmissionPolicy(policy: AdmissionPolicyManifest, binding: AdmissionPolicyBindingManifest): Promise<{ created: boolean }> {
    const created = !this.admissionPolicies.has(policy.metadata.name);
    this.admissionPolicies.set(policy.metadata.name, { policy, binding });
    return { created };
  }

  /** Records the name, then models the live client's idempotency: an absent pair is { deleted: false }. */
  async deleteAdmissionPolicy(name: string): Promise<{ deleted: boolean }> {
    this.deletedAdmissionPolicies.push(name);
    return { deleted: this.admissionPolicies.delete(name) };
  }

  /** The pair as it stands — what an orphan scan reads back after the delete. */
  async admissionPolicyExists(name: string): Promise<boolean> {
    return this.admissionPolicies.has(name);
  }

  async readDeployState(): Promise<DeployState | null> {
    return this.scripted.deployState ?? null;
  }

  /** Return the scripted value at `${namespace}/${name}/${key}`, else null (absent Secret/key). */
  async readSecretValue(namespace: string, name: string, key: string): Promise<string | null> {
    return this.scripted.secretValues?.[`${namespace}/${name}/${key}`] ?? null;
  }

  /** Records the call, then models the real client's idempotency: a namespace scripted absent — or
   *  already deleted on an earlier call (the re-run) — resolves { deleted: false }; the first delete of
   *  a present namespace resolves { deleted: true }. */
  async deleteNamespace(name: string): Promise<{ deleted: boolean }> {
    const already = this.deletedNamespaces.includes(name) || (this.scripted.absentNamespaces?.includes(name) ?? false);
    this.deletedNamespaces.push(name);
    return { deleted: !already };
  }

  /** What the namespace IS. A test scripts `terminatingNamespaces` to model the case this read exists
   *  for: a delete that was accepted while a finalizer still holds the namespace. Anything this fake
   *  has been asked to delete, and anything scripted absent, reads "absent"; everything else "active". */
  async namespacePhase(name: string): Promise<"absent" | "terminating" | "active"> {
    if (this.scripted.terminatingNamespaces?.includes(name)) return "terminating";
    if (this.deletedNamespaces.includes(name) || (this.scripted.absentNamespaces?.includes(name) ?? false)) return "absent";
    return "active";
  }

  /** The namespaces scripted for this selector, else [] (a cluster holding none) — unless the whole
   *  list is scripted to fail, which is the unreadable cluster. */
  async listNamespaces(labelSelector: string): Promise<string[]> {
    if (this.scripted.throwOnListNamespaces) throw this.scripted.throwOnListNamespaces;
    return [...(this.scripted.namespacesByLabel?.[labelSelector] ?? [])];
  }

  /** The annotations each namespace carries, keyed by namespace name — lets a relocation test read
   *  back the relocating mark the repoint wrote on the SOURCE side. */
  readonly namespaceAnnotations = new Map<string, Record<string, string>>();

  /** Every (namespace, stamp) a restart was asked for — lets a test assert the run rolled
   *  the unit's workloads, and with which stamp. The count answers from `workloadsPerNamespace`, so a
   *  test can model both a unit with workloads and a suspended one that has none. */
  readonly restarted: { namespace: string; stampedAt: string }[] = [];

  async restartWorkloads(namespace: string, stampedAt: string): Promise<number> {
    if (this.scripted.throwOnRestart) throw this.scripted.throwOnRestart;
    this.restarted.push({ namespace, stampedAt });
    return this.scripted.workloadsPerNamespace?.[namespace] ?? (this.scripted.smokeByNamespace?.[namespace] ?? this.scripted.smoke)?.workloads.length ?? 0;
  }

  /** The read half: what annotateNamespace left, or null for a namespace that is not there. Absence is
   *  modelled the same way every other namespace read models it, so a test can put a relocation mark on
   *  a namespace and prove a purge refuses over it. */
  async readNamespaceAnnotations(name: string): Promise<Record<string, string> | null> {
    if (this.deletedNamespaces.includes(name) || (this.scripted.absentNamespaces?.includes(name) ?? false)) return null;
    return { ...(this.namespaceAnnotations.get(name) ?? {}) };
  }

  /** Mirrors the live merge-patch: string sets, null removes, and a namespace that is scripted absent
   *  or already deleted is NOT_FOUND — the same absence model deleteNamespace uses, so a test can prove
   *  the run refuses to treat marking nothing as success. */
  async annotateNamespace(name: string, annotations: Record<string, string | null>): Promise<void> {
    if (this.deletedNamespaces.includes(name) || (this.scripted.absentNamespaces?.includes(name) ?? false)) {
      throw new AppError("NOT_FOUND", `namespace ${name} not found — nothing to annotate`);
    }
    const current = this.namespaceAnnotations.get(name) ?? {};
    for (const [key, value] of Object.entries(annotations)) {
      if (value === null) delete current[key];
      else current[key] = value;
    }
    this.namespaceAnnotations.set(name, current);
  }

  /** The Secrets standing right now, keyed `${namespace}/${name}` — so a test can prove the box
   *  credential was placed for the job AND that nothing was left behind after it. */
  readonly secrets = new Map<string, Record<string, string>>();

  /** Every applySecret/deleteSecret in order. The ORDER against `jobs` is the point: it shows the
   *  credential standing before its job ran and gone after, which a final-state map alone cannot. */
  readonly secretWrites: { op: "apply" | "delete"; namespace: string; name: string }[] = [];

  /** Mirrors the live delete-then-create: a leftover of the name goes first, so a re-run replaces. */
  async applySecret(namespace: string, name: string, data: Record<string, string>): Promise<void> {
    this.secretWrites.push({ op: "apply", namespace, name });
    this.secrets.set(`${namespace}/${name}`, { ...data });
  }

  /** Absent is success, exactly as the live client treats a 404. */
  async deleteSecret(namespace: string, name: string): Promise<void> {
    this.secretWrites.push({ op: "delete", namespace, name });
    this.secrets.delete(`${namespace}/${name}`);
  }

  /** Every Job runJob was asked to run, in order — the record a relocation test asserts the dump/
   *  restore/listing choreography against (which namespace, which script, which env). Each entry also
   *  freezes the Secrets STANDING at the moment the job ran, which is how a test reads back the
   *  credential a job could actually resolve rather than only what was written at some point. */
  readonly jobs: { namespace: string; spec: JobSpec; secretsAtRun: Map<string, Record<string, string>> }[] = [];

  /** Script one job outcome by name prefix (see `jobResults`). */
  setJobResult(namePrefix: string, result: JobResult): void {
    this.scripted = { ...this.scripted, jobResults: { ...this.scripted.jobResults, [namePrefix]: result } };
  }

  /** Records the call, then answers with the LONGEST matching scripted prefix — success with empty
   *  logs when nothing matches. Single-shot like every fake watch: the scripted world does not change
   *  while the job "runs". */
  async runJob(namespace: string, spec: JobSpec, _opts: { timeoutMs: number; signal?: AbortSignal }): Promise<JobResult> {
    this.jobs.push({ namespace, spec, secretsAtRun: new Map(this.secrets) });
    const results = this.scripted.jobResults ?? {};
    const match = Object.keys(results)
      .filter((prefix) => spec.name.startsWith(prefix))
      .sort((a, b) => b.length - a.length)[0];
    return match !== undefined ? results[match]! : { succeeded: true, logs: "" };
  }

  /** The PVC names scripted for this namespace, else [] (a namespace holding none). */
  async listPersistentVolumeClaims(namespace: string): Promise<string[]> {
    return [...(this.scripted.pvcsByNamespace?.[namespace] ?? [])];
  }

}

/** In-memory MasterProjectWriter — an ownership-guarded map keyed `${namespace}/${name}`. Honors
 *  the same guards as the real writer (reserved names + consumer-ownership) so domain tests exercise
 *  the fail-closed paths without a cluster. `get()` reads a project back for assertions. */
export class FakeMasterProjectWriter implements MasterProjectWriter {
  private readonly store = new Map<string, AppProjectManifest>();

  /** Test helper: the stored project (or undefined) at `${namespace}/${name}`. */
  get(namespace: string, name: string): AppProjectManifest | undefined {
    return this.store.get(`${namespace}/${name}`);
  }

  async applyAppProject(namespace: string, project: AppProjectManifest): Promise<{ created: boolean }> {
    assertWritableProjectName(project.metadata.name);
    const key = `${namespace}/${project.metadata.name}`;
    const existing = this.store.get(key);
    if (existing && !isManagerOwned(existing)) {
      throw errValidation(`refusing to overwrite AppProject "${project.metadata.name}" — it is not Manager-managed`);
    }
    this.store.set(key, project);
    return { created: existing === undefined };
  }

  async deleteAppProject(namespace: string, name: string): Promise<{ deleted: boolean }> {
    assertWritableProjectName(name);
    const key = `${namespace}/${name}`;
    const existing = this.store.get(key);
    if (!existing) return { deleted: false };
    if (!isManagerOwned(existing)) {
      throw errValidation(`refusing to delete AppProject "${name}" — it is not Manager-managed`);
    }
    this.store.delete(key);
    return { deleted: true };
  }

  /** Unguarded like the live presence read — a look never refuses. */
  async appProjectExists(namespace: string, name: string): Promise<boolean> {
    return this.store.has(`${namespace}/${name}`);
  }
}

/** In-memory ClusterKubeResolver — hands the run tests a fixed ResolvedClusterKube (the fake
 *  reader/argo/writer trio + an argoNamespace), with an optional per-clusterId override so a test
 *  can prove a run resolves the RIGHT clients for a given target. Records every clusterId it was
 *  asked to resolve (`resolved`) so a test can assert WHICH cluster a run resolved against. */
export class FakeClusterKubeResolver implements ClusterKubeResolver {
  readonly resolved: string[] = [];
  private readonly byCluster = new Map<string, ResolvedClusterKube>();

  constructor(private readonly fallback: ResolvedClusterKube) {}

  /** Script the resolution for one clusterId (e.g. a slave with its own reader + ns). */
  set(clusterId: string, resolved: ResolvedClusterKube): void {
    this.byCluster.set(clusterId, resolved);
  }

  async resolve(clusterId: string): Promise<ResolvedClusterKube> {
    this.resolved.push(clusterId);
    return this.byCluster.get(clusterId) ?? this.fallback;
  }
}

/** In-memory BuildRbacWriter — keeps every applied Role/RoleBinding by "<kind> <namespace>/<name>" so
 *  a test can assert the exact grants a run provisioned, and that a teardown removed the same ones.
 *  `failApply` models a cluster that refuses the write (a fail-closed onboard abort). */
export class FakeBuildRbacWriter implements BuildRbacWriter {
  private readonly store = new Map<string, RoleManifest | RoleBindingManifest>();
  private applyError: Error | null = null;

  /** The keys currently present, sorted — the shape a test asserts against. */
  keys(): string[] {
    return [...this.store.keys()].sort();
  }

  /** Test helper: one stored object back, for asserting rules/subjects/resourceNames. */
  get(kind: "Role" | "RoleBinding", namespace: string, name: string): RoleManifest | RoleBindingManifest | undefined {
    return this.store.get(`${kind} ${namespace}/${name}`);
  }

  failApply(err: Error): void {
    this.applyError = err;
  }

  async applyBuildRbac(grants: readonly BuildRbacGrant[]): Promise<{ created: number }> {
    if (this.applyError) throw this.applyError;
    let created = 0;
    for (const { role, binding } of grants) {
      for (const o of [role, binding] as const) {
        const key = `${o.kind} ${o.metadata.namespace}/${o.metadata.name}`;
        if (!this.store.has(key)) created++;
        this.store.set(key, o);
      }
    }
    return { created };
  }

  async deleteBuildRbac(grants: readonly BuildRbacGrant[]): Promise<{ deleted: number }> {
    let deleted = 0;
    for (const { role, binding } of grants) {
      for (const o of [binding, role] as const) {
        if (this.store.delete(`${o.kind} ${o.metadata.namespace}/${o.metadata.name}`)) deleted++;
      }
    }
    return { deleted };
  }

  /** The objects of these grants that are still in the store — each half asked about on its own, as
   *  the live reader does, so a store holding only the Role reports only the Role. */
  async listBuildRbac(grants: readonly BuildRbacGrant[]): Promise<BuildRbacObject[]> {
    const standing: BuildRbacObject[] = [];
    for (const { role, binding } of grants) {
      for (const o of [role, binding] as const) {
        if (this.store.has(`${o.kind} ${o.metadata.namespace}/${o.metadata.name}`)) {
          standing.push({ kind: o.kind, namespace: o.metadata.namespace, name: o.metadata.name });
        }
      }
    }
    return standing;
  }
}

/** In-memory RepoCredentialWriter — keeps every applied ArgoCD repository Secret by
 *  "<namespace>/<name>" so a test can assert the exact credential a run provisioned (url/username,
 *  never asserting the PAT into a snapshot) and that a teardown removed it again. */
export class FakeRepoCredentialWriter implements RepoCredentialWriter {
  private readonly store = new Map<string, RepoCredentialManifest>();

  /** The keys currently present, sorted — the shape a test asserts against. */
  keys(): string[] {
    return [...this.store.keys()].sort();
  }

  get(namespace: string, name: string): RepoCredentialManifest | undefined {
    return this.store.get(`${namespace}/${name}`);
  }

  async applyRepoCredential(secret: RepoCredentialManifest): Promise<{ created: boolean }> {
    const key = `${secret.metadata.namespace}/${secret.metadata.name}`;
    const created = !this.store.has(key);
    this.store.set(key, secret);
    return { created };
  }

  async deleteRepoCredential(namespace: string, name: string): Promise<{ deleted: boolean }> {
    return { deleted: this.store.delete(`${namespace}/${name}`) };
  }

  async repoCredentialExists(namespace: string, name: string): Promise<boolean> {
    return this.store.has(`${namespace}/${name}`);
  }
}
