// The concrete kube adapter behind port.ts — the ONLY module that speaks @kubernetes/client-node
// (dep-cruiser: adapters own IO libs). Two readers, matching the two access paths:
//  - KubeMasterArgoReader: the Manager's own cluster over the pod ServiceAccount (the
//    Manager pod runs ON the master, so the generated Argo Application CRs are local; no SSH
//    tunnel, no mounted kubeconfig — RBAC for the SA is provisioned GitOps-side).
//  - KubeClusterReader: a target cluster via the slave's CLUSTER-ADMIN bearer from the plane's
//    credentialIds, or the pod SA's in-cluster access for the master.
// All raw→port mapping is pure and lives in kube-map.ts (unit-tested in kube-impl.test.ts);
// the methods here are thin IO shells — they NEED a live cluster and are integration-tested
// on the live clusters, never unit-tested. Scripted fakes for domain tests live in testing/fake.ts.
import { KubeConfig, CoreV1Api, AppsV1Api, BatchV1Api, CustomObjectsApi, ApiException, setHeaderOptions, PatchStrategy } from "@kubernetes/client-node";
import type { MasterArgoReader, ClusterReader, ArgoAppStatus, ArgoAppStatusMap, SmokeResult, DeployState, WorkloadStatus, AdmissionPolicyManifest, AdmissionPolicyBindingManifest, JobSpec, JobResult } from "./port.ts";
import { RESTART_ANNOTATION } from "./port.ts";
import { runKubeJob } from "./kube-job.ts";
import * as ns from "./kube-namespace.ts";
import { AppError } from "../../kernel/errors.ts";
import {
  mapArgoStatus,
  mapApplicationSet,
  MISSING_APP_STATUS,
  mapDeployment,
  mapStatefulSet,
  mapDaemonSet,
  externalSecretsAllReady,
  mapDeployState,
} from "./kube-map.ts";

const ARGO = { group: "argoproj.io", version: "v1alpha1", plural: "applications" } as const;
const EXTERNAL_SECRETS = { group: "external-secrets.io", version: "v1beta1", plural: "externalsecrets" } as const;
/** The two CLUSTER-scoped halves of a unit's admission boundary. Written as a pair (a policy without
 *  its binding enforces nothing) and deleted as a pair. */
const ADMISSION_POLICY = { group: "admissionregistration.k8s.io", version: "v1", plural: "validatingadmissionpolicies" } as const;
const ADMISSION_BINDING = { group: "admissionregistration.k8s.io", version: "v1", plural: "validatingadmissionpolicybindings" } as const;
const DEPLOY_STATE = { namespace: "kube-system", name: "hostyour-cloud-deploy-state" } as const;
const DEFAULT_POLL_MS = 2000;

/** What a watch observes while the Application CR does not exist (yet, or anymore): watch-sync
 *  keeps polling a CR Argo has not created yet, watch-removal's `until` matches it as "gone". The
 *  set-watch reuses the same constant for an expected-but-absent member (kube-map.ts). */
const MISSING_APP = MISSING_APP_STATUS;

// ---- Construction inputs --------------------------------------------------------------------

/** Master access: the pod ServiceAccount's in-cluster credentials (the production deployment — the
 *  Manager acts on its OWN cluster over SA RBAC), a kubeconfig file path (dev/test override), or
 *  an already-built KubeConfig (tests/special wiring). */
export type MasterKubeInput = { inCluster: true } | { kubeconfigPath: string } | { kubeConfig: KubeConfig };

/** Target-cluster access: the pod SA's in-cluster credentials or a kubeconfig file for the master (the
 *  same two master variants), or a SLAVE's cluster-admin bearer + API server URL from the plane's
 *  credentialIds. `caData` is the base64 CA bundle (kubeconfig `certificate-authority-data`);
 *  without it the system trust store must know the API server's cert — there is deliberately NO
 *  skip-TLS-verify escape hatch.
 *
 *  The bearer variant is NOT read-only, and nothing on this side narrows it.
 *  Its ONE producer is the resolver (domains/units/cluster-kube.ts), which unseals
 *  plane.credentialIds.clusterBearer — the token deploy-slave harvested as the mgmt-creds blob's
 *  `argocdToken`, whose contract states plainly that it is CLUSTER-ADMIN on the slave and that "a
 *  leaked blob is RCE across the clusters" (runs/defs/deploy-slave.remote.ts, MgmtCredsBlob). So
 *  whatever a Run asks of a slave's ClusterReader, the credential permits: what actually limits this
 *  client is the ClusterReader port surface and the domain guards, never the token. */
export type ClusterKubeInput = { inCluster: true } | { kubeconfigPath: string } | { server: string; token: string; caData?: string };

/** EXPLICIT dispatch over the input variants — never loadFromDefault: which credentials a client
 *  runs on is a deployment fact the wiring states, not a silent fallback chain. `inCluster` loads
 *  the pod ServiceAccount's token + CA (loadFromCluster) — the production mode since the Vault-
 *  mounted kubeconfig file was retired. Exported for the dispatch unit tests (kube.test.ts); the
 *  IO shells below still need a live cluster and are only tested against live clusters.
 *
 *  Exactly ONE variant names a kubeconfig user — the bearer one — so no single name has to honestly
 *  cover both access paths. The two master variants let the client library
 *  name themselves (loadFromCluster's fixed inCluster user, or the file's own `users[]`), and the pod
 *  SA behind them really IS narrow: it holds exactly the Roles/ClusterRoles that hostyour-cloud
 *  apps/manager/templates/rbac.yaml binds to the `manager` ServiceAccount. The bearer variant is
 *  the slave's cluster-admin token, and is named for THAT. */
export function buildKubeConfig(input: MasterKubeInput | ClusterKubeInput): KubeConfig {
  if ("kubeConfig" in input) return input.kubeConfig;
  const kc = new KubeConfig();
  if ("kubeconfigPath" in input) {
    kc.loadFromFile(input.kubeconfigPath);
    return kc;
  }
  if ("inCluster" in input) {
    kc.loadFromCluster();
    return kc;
  }
  // The user name never leaves this in-memory KubeConfig (the API server authenticates the TOKEN, and
  // never sees the name), so it exists for exactly one purpose: telling a reader what this client is
  // holding. It therefore MUST NOT understate it. It once read "manager-readonly",
  // and two independent readers reasoned from that name that a cluster-scoped
  // delete (deleteTenantCr) could not be permitted on a slave — one step from a wrong conclusion, and from
  // designing around a constraint that does not exist. Understating a credential is the dangerous
  // direction to be wrong in; see the ClusterKubeInput note above for where the power comes from.
  kc.loadFromClusterAndUser(
    {
      name: "target",
      server: input.server,
      skipTLSVerify: false,
      ...(input.caData !== undefined ? { caData: input.caData } : {}),
    },
    { name: "cluster-admin-bearer", token: input.token },
  );
  return kc;
}

// ---- Error normalization ----------------------------------------------------------------------

/** The 1.x fetch client throws ApiException with `.code`; be liberal and also accept the older
 *  `.statusCode` / `.response.statusCode` shapes so 404 handling never depends on the client's
 *  vintage. Node system errors carry a STRING `.code` ("ECONNREFUSED") — filtered by typeof. */
function statusOf(e: unknown): number | undefined {
  if (e instanceof ApiException) return e.code;
  if (typeof e !== "object" || e === null) return undefined;
  const o = e as { statusCode?: unknown; code?: unknown; response?: { statusCode?: unknown } };
  for (const c of [o.statusCode, o.code, o.response?.statusCode]) {
    if (typeof c === "number") return c;
  }
  return undefined;
}

/** Exported so the sibling RBAC writer (kube-rbac.ts) reads a 404 exactly the way this file does —
 *  two definitions of "absent" would mean two different notions of idempotent. */
export const isNotFound = (e: unknown): boolean => statusOf(e) === 404;

/** Anything that is not a handled 404 surfaces as UPSTREAM with the kube API's own message
 *  (never a mask) and the operation + namespace/name for context. */
export function upstream(what: string, e: unknown): AppError {
  const msg = e instanceof Error ? e.message : String(e);
  return new AppError("UPSTREAM", `kube: ${what} failed: ${msg}`, { cause: e });
}

/** Abortable sleep — resolves early (never rejects) on abort; the watch loop re-checks the
 *  signal and returns the last observed status, per the port contract. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const t = setTimeout(done, ms);
    function done(): void {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

// ---- MasterArgoReader ---------------------------------------------------------------------

export class KubeMasterArgoReader implements MasterArgoReader {
  private readonly custom: CustomObjectsApi;

  constructor(
    input: MasterKubeInput,
    /** Poll interval for watchApplication — overridable for (future) integration harnesses. */
    private readonly pollMs: number = DEFAULT_POLL_MS,
  ) {
    this.custom = buildKubeConfig(input).makeApiClient(CustomObjectsApi);
  }

  /** NEEDS a live cluster — integration-tested on the live clusters. Mapping is pure (kube-map.ts). */
  async getApplication(namespace: string, name: string): Promise<ArgoAppStatus | null> {
    let raw: unknown;
    try {
      raw = await this.custom.getNamespacedCustomObject({ ...ARGO, namespace, name });
    } catch (e) {
      if (isNotFound(e)) return null;
      throw upstream(`get Argo Application ${namespace}/${name}`, e);
    }
    return mapArgoStatus(raw);
  }

  /** Poll getApplication every pollMs until `until(status)` holds, `failFast(status)` trips (a
   *  terminally failed sync operation — the loop stops early and the caller then decides to throw,
   *  rather than waiting out the whole budget for a sync that can no longer converge), timeoutMs
   *  elapses, or the signal aborts; returns the LAST observed status — on timeout/abort/fail-fast it
   *  simply fails `until` and the caller decides (same semantics as the fake). A missing Application
   *  observes as {sync: "Unknown", health: "Missing"}. NEEDS a live cluster — integration-tested on
   *  the live clusters; the loop's control flow (until/failFast/budget) is unit-tested with a stubbed
   *  getApplication. */
  async watchApplication(
    namespace: string,
    name: string,
    until: (s: ArgoAppStatus) => boolean,
    opts: { timeoutMs: number; signal?: AbortSignal; failFast?: (s: ArgoAppStatus) => boolean },
  ): Promise<ArgoAppStatus> {
    const deadline = Date.now() + opts.timeoutMs;
    const stop = (s: ArgoAppStatus): boolean => until(s) || (opts.failFast?.(s) ?? false);
    let last = (await this.getApplication(namespace, name)) ?? MISSING_APP;
    while (!stop(last) && !opts.signal?.aborted) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await sleep(Math.min(this.pollMs, remaining), opts.signal);
      if (opts.signal?.aborted) break;
      last = (await this.getApplication(namespace, name)) ?? MISSING_APP;
    }
    return last;
  }

  /** Poll a SET of Applications (a tenant fan-out): one list per pollMs tick (filtered by
   *  `labelSelector` when given, e.g. platform/tenant=<guid>) mapped by the pure mapApplicationSet,
   *  which fills every EXPECTED name still absent with Missing (the completeness gate). Loops until
   *  `until(byName)` holds, timeoutMs elapses, or the signal aborts; returns the LAST observed map —
   *  on timeout/abort it simply fails `until` and the caller decides (same semantics as
   *  watchApplication). NEEDS a live cluster — integration-tested on the live clusters; the mapping is pure. */
  async watchApplicationSet(
    namespace: string,
    names: readonly string[],
    until: (byName: ArgoAppStatusMap) => boolean,
    opts: { timeoutMs: number; signal?: AbortSignal; labelSelector?: string },
  ): Promise<ArgoAppStatusMap> {
    const deadline = Date.now() + opts.timeoutMs;
    let last = await this.listApplicationSet(namespace, names, opts.labelSelector);
    while (!until(last) && !opts.signal?.aborted) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await sleep(Math.min(this.pollMs, remaining), opts.signal);
      if (opts.signal?.aborted) break;
      last = await this.listApplicationSet(namespace, names, opts.labelSelector);
    }
    return last;
  }

  /** One labelSelector-filtered list of the argocd Applications → the expected-name completeness
   *  map (mapApplicationSet). A list failure surfaces as UPSTREAM with the kube API's own message. */
  private async listApplicationSet(
    namespace: string,
    names: readonly string[],
    labelSelector: string | undefined,
  ): Promise<ArgoAppStatusMap> {
    let raw: unknown;
    try {
      raw = await this.custom.listNamespacedCustomObject({
        ...ARGO,
        namespace,
        ...(labelSelector !== undefined ? { labelSelector } : {}),
      });
    } catch (e) {
      throw upstream(`list Argo Applications in ${namespace}`, e);
    }
    const items = (raw as { items?: unknown[] }).items ?? [];
    return mapApplicationSet(items, names);
  }
}

// ---- ClusterReader -----------------------------------------------------------------------

export class KubeClusterReader implements ClusterReader {
  private readonly core: CoreV1Api;
  private readonly apps: AppsV1Api;
  private readonly batch: BatchV1Api;
  private readonly custom: CustomObjectsApi;

  constructor(
    input: ClusterKubeInput,
    private readonly pollMs: number = DEFAULT_POLL_MS,
  ) {
    const kc = buildKubeConfig(input);
    this.core = kc.makeApiClient(CoreV1Api);
    this.apps = kc.makeApiClient(AppsV1Api);
    this.batch = kc.makeApiClient(BatchV1Api);
    this.custom = kc.makeApiClient(CustomObjectsApi);
  }

  /** NEEDS a live cluster — integration-tested on the live clusters. Mapping is pure (kube-map.ts). */
  async smoke(namespace: string): Promise<SmokeResult> {
    if (!(await this.namespaceExists(namespace))) {
      // Nothing to inspect in a missing namespace; externalSecretsReady=true is the honest
      // "zero ExternalSecrets" answer — the caller already fails the smoke on namespaceExists.
      return { namespaceExists: false, workloads: [], externalSecretsReady: true };
    }
    const [deployments, statefulSets, daemonSets, externalSecretsReady] = await Promise.all([
      this.list("Deployments", namespace, () => this.apps.listNamespacedDeployment({ namespace })),
      this.list("StatefulSets", namespace, () => this.apps.listNamespacedStatefulSet({ namespace })),
      this.list("DaemonSets", namespace, () => this.apps.listNamespacedDaemonSet({ namespace })),
      this.externalSecretsReady(namespace),
    ]);
    const workloads: WorkloadStatus[] = [
      ...deployments.items.map(mapDeployment),
      ...statefulSets.items.map(mapStatefulSet),
      ...daemonSets.items.map(mapDaemonSet),
    ];
    return { namespaceExists: true, workloads, externalSecretsReady };
  }

  /** NEEDS a live cluster — integration-tested on the live clusters. Absent ConfigMap → null, so
   *  attest-target fails closed upstream; a malformed one throws VALIDATION (kube-map.ts). */
  async readDeployState(): Promise<DeployState | null> {
    let data: Record<string, string> | undefined;
    try {
      const cm = await this.core.readNamespacedConfigMap({ name: DEPLOY_STATE.name, namespace: DEPLOY_STATE.namespace });
      data = cm.data;
    } catch (e) {
      if (isNotFound(e)) return null;
      throw upstream(`read ConfigMap ${DEPLOY_STATE.namespace}/${DEPLOY_STATE.name}`, e);
    }
    return mapDeployState(data);
  }

  /** Read ONE key from a namespaced Secret, base64-decoded (the wire form kube stores Secret data in)
   *  to a UTF-8 string. An absent Secret (404) OR an absent key resolves null — the caller (the tenant
   *  first-admin invite) fails loud with its own message, so a missing crypto secret is never confused
   *  with a wrong token. NEEDS a live cluster — integration-tested on the live clusters. */
  async readSecretValue(namespace: string, name: string, key: string): Promise<string | null> {
    let data: { [k: string]: string } | undefined;
    try {
      const sec = await this.core.readNamespacedSecret({ name, namespace });
      data = sec.data;
    } catch (e) {
      if (isNotFound(e)) return null;
      throw upstream(`read Secret ${namespace}/${name}`, e);
    }
    const b64 = data?.[key];
    if (b64 === undefined) return null;
    return Buffer.from(b64, "base64").toString("utf8");
  }

  /** Place a Secret of literal string values: delete any leftover of the name, then create. The delete
   *  first is what makes a crash-resumed relocation step work — it re-runs the SAME job name, so the
   *  Secret name repeats — and it keeps the grant at `create` + `delete` with no read verb, unlike a
   *  read-then-replace. Secrets carry no finalizers and no propagation, so the delete is complete when
   *  it returns and the create cannot race it. `stringData` hands the API server plain UTF-8 and lets
   *  it do the base64, so no credential is ever encoded in the Manager. NEEDS a live cluster —
   *  integration-tested on the live clusters. */
  async applySecret(namespace: string, name: string, data: Record<string, string>): Promise<void> {
    await this.deleteSecret(namespace, name);
    try {
      await this.core.createNamespacedSecret({ namespace, body: { metadata: { name, namespace }, type: "Opaque", stringData: data } });
    } catch (e) {
      throw upstream(`create Secret ${namespace}/${name}`, e);
    }
  }

  /** Delete a Secret by name; an already-absent one is success, so the reap after a Job that never
   *  started is a no-op rather than a failure. NEEDS a live cluster — integration-tested there. */
  async deleteSecret(namespace: string, name: string): Promise<void> {
    try {
      await this.core.deleteNamespacedSecret({ name, namespace });
    } catch (e) {
      if (isNotFound(e)) return;
      throw upstream(`delete Secret ${namespace}/${name}`, e);
    }
  }

  /** Create-or-replace the unit's admission policy AND its binding, in that order: the binding
   *  references the policy by name, so writing the policy first means the reference is never dangling.
   *  `created` reports the POLICY's own outcome — the two are written together, so it answers for both.
   *  Idempotent (a crash-resumed onboard replaces both in place); a replace carries the observed
   *  resourceVersion for optimistic concurrency, exactly as the AppProject writer does. NEEDS a live
   *  cluster — integration-tested on the live clusters. */
  async applyAdmissionPolicy(policy: AdmissionPolicyManifest, binding: AdmissionPolicyBindingManifest): Promise<{ created: boolean }> {
    const created = await this.applyClusterObject(ADMISSION_POLICY, policy.metadata.name, policy);
    await this.applyClusterObject(ADMISSION_BINDING, binding.metadata.name, binding);
    return { created };
  }

  /** Offboard teardown — delete the unit's binding AND its policy, binding FIRST: the reverse of the
   *  write order, so the boundary is never left as a policy whose binding still points at it. `deleted`
   *  is true when either half was actually there. Idempotent — an already-absent pair resolves
   *  { deleted: false }. */
  async deleteAdmissionPolicy(name: string): Promise<{ deleted: boolean }> {
    const binding = await this.deleteClusterObject(ADMISSION_BINDING, name);
    const policy = await this.deleteClusterObject(ADMISSION_POLICY, name);
    return { deleted: binding || policy };
  }

  /** Does either half of the unit's admission boundary still stand? Asked of BOTH kinds, matching the
   *  delete above, which reports the pair as one. NEEDS a live cluster — integration-tested there. */
  async admissionPolicyExists(name: string): Promise<boolean> {
    if ((await this.readClusterObject(ADMISSION_POLICY, name)) !== null) return true;
    return (await this.readClusterObject(ADMISSION_BINDING, name)) !== null;
  }

  /** GET ONE cluster-scoped custom object, mapping a 404 to null. */
  private async readClusterObject(api: { group: string; version: string; plural: string }, name: string): Promise<unknown> {
    try {
      return await this.custom.getClusterCustomObject({ ...api, name });
    } catch (e) {
      if (isNotFound(e)) return null;
      throw upstream(`get ${api.plural}/${name}`, e);
    }
  }

  /** Create-or-replace ONE cluster-scoped custom object; returns true when it was CREATED. */
  private async applyClusterObject(api: { group: string; version: string; plural: string }, name: string, body: object): Promise<boolean> {
    const existing = await this.readClusterObject(api, name);
    if (existing === null) {
      try {
        await this.custom.createClusterCustomObject({ ...api, body });
      } catch (e) {
        throw upstream(`create ${api.plural}/${name}`, e);
      }
      return true;
    }
    const resourceVersion = (existing as { metadata?: { resourceVersion?: string } }).metadata?.resourceVersion;
    const withVersion = { ...body, metadata: { ...(body as { metadata: object }).metadata, ...(resourceVersion !== undefined ? { resourceVersion } : {}) } };
    try {
      await this.custom.replaceClusterCustomObject({ ...api, name, body: withVersion });
    } catch (e) {
      throw upstream(`replace ${api.plural}/${name}`, e);
    }
    return false;
  }

  /** Delete ONE cluster-scoped custom object; returns true when it was actually there. */
  private async deleteClusterObject(api: { group: string; version: string; plural: string }, name: string): Promise<boolean> {
    try {
      await this.custom.deleteClusterCustomObject({ ...api, name });
    } catch (e) {
      if (isNotFound(e)) return false;
      throw upstream(`delete ${api.plural}/${name}`, e);
    }
    return true;
  }

  // The four namespace operations live in kube-namespace.ts (400-line budget); the access path is
  // this reader's own client, handed in.
  async deleteNamespace(name: string): Promise<{ deleted: boolean }> {
    return ns.deleteNamespace(this.core, name);
  }

  async namespacePhase(name: string): Promise<"absent" | "terminating" | "active"> {
    return ns.namespacePhase(this.core, name);
  }

  async listNamespaces(labelSelector: string): Promise<string[]> {
    return ns.listNamespaces(this.core, labelSelector);
  }

  async annotateNamespace(name: string, annotations: Record<string, string | null>): Promise<void> {
    return ns.annotateNamespace(this.core, name, annotations);
  }

  /** Run ONE batch/v1 Job to completion — the Job lifecycle lives in kube-job.ts (replace a
   *  leftover, create, poll, collect the pod log). NEEDS a live cluster — integration-tested on the
   *  live clusters. */
  async runJob(namespace: string, spec: JobSpec, opts: { timeoutMs: number; signal?: AbortSignal }): Promise<JobResult> {
    return runKubeJob({ batch: this.batch, core: this.core, pollMs: this.pollMs }, namespace, spec, opts);
  }

  /** Every PVC name in the namespace — what the consumer dump/restore mounts. NEEDS a live cluster. */
  async listPersistentVolumeClaims(namespace: string): Promise<string[]> {
    try {
      const res = await this.core.listNamespacedPersistentVolumeClaim({ namespace });
      return res.items.map((p) => p.metadata?.name).filter((n): n is string => typeof n === "string");
    } catch (e) {
      throw upstream(`list PersistentVolumeClaims in ${namespace}`, e);
    }
  }

  /** Roll every Deployment and StatefulSet of the namespace by stamping the pod TEMPLATE's
   *  annotations — see the port for why the template and not the workload. DaemonSets are
   *  deliberately not included: a unit runs none, and the ones on the platform belong to the base
   *  layer, which this call must never reach into. NEEDS a live cluster. */
  async restartWorkloads(namespace: string, stampedAt: string): Promise<number> {
    const body = { spec: { template: { metadata: { annotations: { [RESTART_ANNOTATION]: stampedAt } } } } };
    const opts = setHeaderOptions("Content-Type", PatchStrategy.MergePatch);
    let rolled = 0;
    try {
      const [deployments, statefulSets] = await Promise.all([
        this.apps.listNamespacedDeployment({ namespace }),
        this.apps.listNamespacedStatefulSet({ namespace }),
      ]);
      for (const d of deployments.items) {
        const name = d.metadata?.name;
        if (!name) continue;
        await this.apps.patchNamespacedDeployment({ name, namespace, body }, opts);
        rolled += 1;
      }
      for (const s of statefulSets.items) {
        const name = s.metadata?.name;
        if (!name) continue;
        await this.apps.patchNamespacedStatefulSet({ name, namespace, body }, opts);
        rolled += 1;
      }
    } catch (e) {
      throw upstream(`restart workloads in ${namespace}`, e);
    }
    return rolled;
  }

  /** A namespace's annotations, or null when the namespace is absent. NEEDS a live cluster. */
  async readNamespaceAnnotations(namespace: string): Promise<Record<string, string> | null> {
    return ns.readNamespaceAnnotations(this.core, namespace);
  }

  private async namespaceExists(namespace: string): Promise<boolean> {
    try {
      await this.core.readNamespace({ name: namespace });
      return true;
    } catch (e) {
      if (isNotFound(e)) return false;
      throw upstream(`read namespace ${namespace}`, e);
    }
  }

  private async list<T>(what: string, namespace: string, call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (e) {
      throw upstream(`list ${what} in ${namespace}`, e);
    }
  }

  private async externalSecretsReady(namespace: string): Promise<boolean> {
    let raw: unknown;
    try {
      raw = await this.custom.listNamespacedCustomObject({ ...EXTERNAL_SECRETS, namespace });
    } catch (e) {
      // 404 here means the ExternalSecret CRD is not installed at all — zero ExternalSecrets
      // exist, and zero ExternalSecrets is Ready by the port contract.
      if (isNotFound(e)) return true;
      throw upstream(`list ExternalSecrets in ${namespace}`, e);
    }
    const items = (raw as { items?: unknown[] }).items ?? [];
    return externalSecretsAllReady(items);
  }
}

// The MasterProjectWriter impl lives in kube-project.ts (400-line budget); re-exported here so the
// adapter keeps ONE import surface.
export { KubeMasterProjectWriter } from "./kube-project.ts";
