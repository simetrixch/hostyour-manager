// The Manager's kube ports. A master Argo reader, a per-cluster
// client, and the master AppProject writer:
//  - MasterArgoReader — over the Manager pod's in-cluster ServiceAccount (or the dev kubeconfig
//    override); watch the generated Application CR (which lives on the master) reach Synced/Healthy
//    at the frozen SHA: watch-sync, watch-prune, watch-removal. No SSH tunnel — the CRs are local
//    to the master. Read-only: ArgoCD's own git poll is what picks a registration commit up.
//  - ClusterReader — over a slave's cluster-admin bearer (from the plane's credentialIds, harvested by
//    deploy-slave; or the pod SA's in-cluster access for the master); smoke-reads a namespace on the target cluster
//    and reads the deploy-state ConfigMap that attest-target checks fail-closed. It ALSO carries the
//    teardown writes on the TARGET cluster: deleteNamespace (ArgoCD's CreateNamespace=true never
//    removes the namespace on prune, so the offboard Run must). A tenant deprovision is NOT one
//    delete: no reconciler serves a cluster-scoped Tenant CR, so there is no finalizer to release
//    once everything is gone,
//    and each thing such a cascade would do is deprovisioned by whoever created it — the Vault entry by
//    tenant-purge's delete-tenant-crypto through the same seeder create-tenant wrote it with, the
//    databases by the ServiceClaim finalizers that fire when the member namespaces are reaped.
//    It lists namespaces by label, which is how a
//    tenant teardown reaps every member namespace rather than only the ones it can derive. It ALSO writes
//    the per-unit admission boundary (apply/deleteAdmissionPolicy): a
//    ValidatingAdmissionPolicy is CLUSTER-scoped and belongs where the unit's workloads are admitted,
//    which is this client's cluster and not the master's ArgoCD namespace. Its last write pair is
//    applySecret/deleteSecret, which exists so a relocation Job can reach the Storage Box through a
//    same-namespace Secret reference instead of a credential written flat onto the Job.
//  - MasterProjectWriter — the writing kube path on the MASTER argocd namespace: creates/updates/
//    deletes the per-consumer isolation AppProject there. Guarded (ownership label + reserved
//    names) so it fails closed and never touches a foreign/system project.
// The concrete impl uses @kubernetes/client-node; the fakes are scripted.

import type { ArgoSync, ArgoHealth } from "../../../shared/enums.ts";

/** One source of a MULTI-SOURCE Application's last sync: the source's repo paired with the
 *  revision Argo synced it to. Built by pairing `status.sync.revisions[i]` with
 *  `status.sync.comparedTo.sources[i].repoURL` (index-aligned by the Argo API contract). */
export interface ArgoSyncSource {
  repoURL: string | null;
  revision: string | null;
}

/** One source of a MULTI-SOURCE Application's SPEC — the DESIRED twin of ArgoSyncSource: the
 *  source's repo paired with the revision that source TARGETS. Read straight off
 *  `.spec.sources[i]`, where repoURL and targetRevision sit on the SAME object, so unlike the
 *  synced side there is no index-alignment contract to trust. */
export interface ArgoTargetSource {
  repoURL: string | null;
  targetRevision: string | null;
}

export interface ArgoAppStatus {
  syncRevision: string | null; // the revision Argo last synced to (single-source apps)
  /** MULTI-SOURCE apps only (the generated consumer Application carries several sources — the
   *  cluster's $values chain, the consumer chart, and a per-consumer service source when it claims
   *  one): Argo reports `status.sync.revisions[]` INSTEAD of the
   *  single `status.sync.revision`. Absent on a single-source app. Compare per-repo via
   *  syncedRevisionFor — never `syncRevision`, which stays null on a multi-source app. */
  syncSources?: readonly ArgoSyncSource[];
  /** What the app's SINGULAR `.spec.source` TARGETS — the revision the GitOps pointer pins, as
   *  ArgoCD sees it, for an app that declares one source the old way. The exact DESIRED twin of
   *  syncRevision, and null for the same reason that field is: an app that declares `.spec.sources[]`
   *  (every Application this Manager reads — see targetSources) leaves the singular form empty,
   *  as does a Missing app with no spec at all. Read it through targetedRevisionFor, never directly:
   *  that function is what knows which of the two forms an app expressed its sources in.
   *  REQUIRED (like syncRevision, not optional like the arrays): every constructor must state what it
   *  targets, so a hand-built status can never silently omit it and make a caller fall back unnoticed. */
  targetRevision: string | null;
  /** MULTI-SOURCE apps: the DESIRED side of `.spec.sources[]`, one entry per source. Absent when the
   *  app declares the singular `.spec.source` (or has no spec at all). This is the spec-side twin of
   *  syncSources and it exists for the same reason: the generated consumer Application's sources do not
   *  target the same thing at all — the platform-repo sources follow a branch while the consumer's own
   *  repo source follows its delivery branch. Anything that reads source 0 of such an app gets one
   *  source's answer where it wanted another's, so compare per-repo via targetedRevisionFor. */
  targetSources?: readonly ArgoTargetSource[];
  sync: ArgoSync;
  health: ArgoHealth;
  message?: string; // last operation / condition message, surfaced on failure
  /** The phase of the app's LAST sync operation (`status.operationState.phase`), server-provided text
   *  kept verbatim: 'Running' while a sync is IN FLIGHT — including while it is blocked on a PreSync
   *  hook — then 'Succeeded'/'Failed'/'Error'/'Terminating'. Absent when the app has never run a sync
   *  operation (a fresh/Missing CR). watch-sync reads it to tell a sync still IN FLIGHT (keep waiting)
   *  from a terminally FAILED one (stop now, rather than burning the whole budget on something that can
   *  no longer converge). */
  opPhase?: string;
}

/** The revision the app last synced THE GIVEN REPO's source to: on a multi-source app, the entry
 *  of syncSources whose repoURL matches (the consumer chart's repoURL is unique among the generated
 *  sources — the others are the platform repo); on a single-source app, the plain
 *  syncRevision. Null when the repo is not among the synced sources — the caller's `until` then
 *  simply keeps failing (fail-closed watch), never a match against a WRONG source's revision. */
export function syncedRevisionFor(s: ArgoAppStatus, repoURL: string): string | null {
  if (s.syncSources !== undefined) {
    return s.syncSources.find((src) => src.repoURL === repoURL)?.revision ?? null;
  }
  return s.syncRevision;
}

/** The synced revision of an app that tracks a SINGLE repo, whether Argo reported it as the plain
 *  `status.sync.revision` (a bare single-source app) OR as the sole entry of `status.sync.revisions[]`
 *  — that one source expressed inside a one-element `.spec.sources` array. Prefer the singular; fall
 *  back to the first (and only) source;
 *  null when neither exists (a fresh/Missing app). Use ONLY for an app known to track ONE repo — a
 *  genuinely multi-source app (the consumer Application: $values + chart + image-guard) needs the
 *  per-repo syncedRevisionFor, which disambiguates by repoURL. */
export function singleSourceRevision(s: ArgoAppStatus): string | null {
  return s.syncRevision ?? s.syncSources?.[0]?.revision ?? null;
}

/** The revision the app's source for THE GIVEN REPO targets — the DESIRED twin of syncedRevisionFor,
 *  and the ONE way to read a pin off an Application: the entry of targetSources whose repoURL matches
 *  (`.spec.sources[]`), else the singular `.spec.source`'s targetRevision. Null when the repo is not
 *  among the app's sources, or when the CR has no spec at all (a Missing app) — the caller then knows
 *  it has no answer rather than being handed the WRONG source's revision, which is the whole point.
 *
 *  WHY per-repo and never `sources[0]`. The generated consumer Application's
 *  source 0 is the GitOps repo pinned to the install BRANCH, so the Consumers card read a branch name
 *  where it wanted a SHA; and the tenant base Application's sole source is catalog, which the
 *  tenant card matched by luck of ordering rather than by asking. Both now ASK, with the repo they
 *  already know (the consumer's apps.repoUrl, the tenant's platform-constant catalog URL), so a
 *  second source appearing on either can never silently change what the card calls "the pin". */
export function targetedRevisionFor(s: ArgoAppStatus, repoURL: string): string | null {
  if (s.targetSources !== undefined) {
    return s.targetSources.find((src) => src.repoURL === repoURL)?.targetRevision ?? null;
  }
  return s.targetRevision;
}

/** The per-name status a SET watch observes — keyed by Application name, one entry per EXPECTED
 *  name (an expected name whose CR does not exist yet reads Missing; see watchApplicationSet). */
export type ArgoAppStatusMap = ReadonlyMap<string, ArgoAppStatus>;

/** One Application a namespace HOLDS, as a listing reports it: its name beside the same status
 *  every other read of an Application answers with.
 *
 *  IT IS NOT THE SHAPE `watchApplicationSet` ANSWERS WITH, and the difference is the whole reason
 *  this exists. That map is keyed by the caller's EXPECTED names and throws away anything found
 *  under a name not in that list (kube-map.ts mapApplicationSet), which is right for a fan-out whose
 *  members the caller can name. A gate that waits on an ApplicationSet cannot name them — the set
 *  generates them — and reads zero found as "still generating". Asked with an empty expected list,
 *  that map is empty and every `every`-shaped predicate over it is vacuously true on the first
 *  tick. */
export interface ArgoApplicationRow extends ArgoAppStatus {
  name: string;
}

export interface MasterArgoReader {
  getApplication(namespace: string, name: string): Promise<ArgoAppStatus | null>;
  /** Every Application the namespace HOLDS, in the order the API server lists them. What it returns
   *  is what it FINDS, so a caller counting a set nobody can name — an ApplicationSet's own output —
   *  can tell "none generated yet" from "all converged". */
  listApplications(namespace: string): Promise<ArgoApplicationRow[]>;
  /** Watch until `until(status)` holds or the timeout fires; returns the last observed status.
   *  On timeout the returned status simply fails `until` — the caller decides it is a failure.
   *  An optional `failFast(status)` stops the poll EARLY when a status is terminally failed (a
   *  Failed/Error sync operation) and returns it, so a caller waiting through a slow but legitimate
   *  sync (a PreSync image-guard build) need not burn the whole budget on one that can no longer
   *  converge; the returned status still simply fails `until`, so the caller decides. */
  watchApplication(
    namespace: string,
    name: string,
    until: (s: ArgoAppStatus) => boolean,
    opts: { timeoutMs: number; signal?: AbortSignal; failFast?: (s: ArgoAppStatus) => boolean },
  ): Promise<ArgoAppStatus>;
  /** Watch a SET of Applications (a tenant fan-out) until `until(byName)` holds or the timeout
   *  fires; returns the last observed name→status map. One list per poll tick (filtered by
   *  `labelSelector` when given, e.g. `platform/tenant=<guid>`); every EXPECTED name still ABSENT
   *  from that list maps to health "Missing" — a completeness gate, since a fan-out Application may
   *  not have been generated by its ApplicationSet yet, so the caller waits for the whole set to
   *  appear AND converge. On timeout the returned map simply fails `until` and the caller decides. */
  watchApplicationSet(
    namespace: string,
    names: readonly string[],
    until: (byName: ArgoAppStatusMap) => boolean,
    opts: { timeoutMs: number; signal?: AbortSignal; labelSelector?: string },
  ): Promise<ArgoAppStatusMap>;
}

export interface WorkloadStatus {
  kind: string; // "Deployment" | "StatefulSet" | "DaemonSet" | ...
  name: string;
  available: boolean; // Available / all replicas Ready
  /** How many replicas the workload ASKS for (`.spec.replicas`, a DaemonSet's desiredNumberScheduled).
   *  `available` alone cannot tell a running workload from one that is switched OFF — 0 ready of 0
   *  desired is "available" too — so the OFF state a suspend renders (replicas 0, no Ingress) is only
   *  observable through this number. */
  desired: number;
  ready: number; // how many replicas are actually Available/Ready
  message?: string; // e.g. "ImagePullBackOff", "CrashLoopBackOff"
}

export interface SmokeResult {
  namespaceExists: boolean;
  workloads: WorkloadStatus[];
  externalSecretsReady: boolean; // every ExternalSecret Ready=True (SecretSynced)
}

/** One ExternalSecret a namespace holds: what it is called, whether ESO reports it Ready, WHY it
 *  says so, and which Secret it materializes.
 *
 *  THE REASON AND THE TARGET ARE WHAT A BOOLEAN CANNOT SAY. `SmokeResult.externalSecretsReady`
 *  collapses a whole namespace to one bit, so a gate built on it can report that something is stuck
 *  and never which credential it is — and the credential's name is the whole of what an operator
 *  acts on at two in the morning. */
export interface ExternalSecretRow {
  name: string;
  /** The `Ready` condition reads `True`. An ExternalSecret carrying no Ready condition at all — one
   *  ESO has not looked at yet — is not ready. */
  ready: boolean;
  /** The Ready condition's `reason`, or the empty text where there is no such condition. */
  reason: string;
  /** `.spec.target.name` — the Secret this materializes into, or the empty text where the
   *  ExternalSecret names none (ESO then uses its own name). */
  targetSecret: string;
}

/** kube-system/hostyour-cloud-deploy-state, written by the installer on every deploy — attest-target
 *  compares these and fails closed on absence/staleness. */
export interface DeployState {
  domain: string;
  stage: string;
  writtenAt: string; // ISO timestamp
  generation: number; // monotonic
}

/** ONE env var of a relocation Job's container: a literal value, or a key of a Secret IN THE JOB'S
 *  OWN NAMESPACE (a pod can only reference same-namespace Secrets — which is why the dump runs as
 *  several Jobs in several namespaces rather than one). `optional` mirrors the kube field: the pod
 *  starts without the var when the Secret/key is absent. */
export interface JobEnvVar {
  name: string;
  value?: string;
  secretKeyRef?: { name: string; key: string; optional?: boolean };
}

/** ONE PersistentVolumeClaim the Job mounts — how a consumer's PVC data is reached for the tar. */
export interface JobPvcMount {
  claimName: string;
  mountPath: string;
  readOnly?: boolean;
}

/** What ClusterReader.runJob creates: one batch/v1 Job running ONE container of the pinned dbtools
 *  image, whose whole work is `script` under `sh -ec`. The Manager composes these and never runs a
 *  database client itself — the clients live in the image, on the cluster where the databases are. */
export interface JobSpec {
  /** The Job name — a DNS label, unique per run+purpose (the caller composes it). */
  name: string;
  image: string;
  script: string;
  env?: JobEnvVar[];
  pvcMounts?: JobPvcMount[];
}

/** What one Job run observed: whether the Job SUCCEEDED, and the container's collected log — the
 *  channel a listing job answers through (the caller parses it). On timeout/abort `succeeded` is
 *  simply false with whatever log was collected; the caller decides, like every watch on this port. */
export interface JobResult {
  succeeded: boolean;
  logs: string;
}

export interface ClusterReader {
  smoke(namespace: string): Promise<SmokeResult>;
  /** Every ExternalSecret in `namespace`, one row each. `smoke`'s `externalSecretsReady` is derived
   *  from exactly these rows, so the bit and the rows can never disagree. */
  listExternalSecrets(namespace: string): Promise<ExternalSecretRow[]>;
  /** Run ONE Job to completion in `namespace` and return its outcome + collected pod log. The job
   *  carrier of the move/backup/restore mechanism: dumps, restores and listings all run as in-cluster
   *  Jobs of the pinned dbtools image, because the databases are reachable there and the Manager
   *  carries no database clients. Idempotent by name: a crash-resumed step re-runs the SAME job name,
   *  and the writer replaces a leftover Job of that name before creating the new one. */
  runJob(namespace: string, spec: JobSpec, opts: { timeoutMs: number; signal?: AbortSignal }): Promise<JobResult>;
  /** Every PersistentVolumeClaim name in `namespace` — what the consumer dump mounts for the tar
   *  (PVC names are chart-chosen, so only the cluster can answer which exist). */
  listPersistentVolumeClaims(namespace: string): Promise<string[]>;
  /** Create-or-replace the unit's ValidatingAdmissionPolicy + its Binding on the TARGET cluster, as
   *  one unit: the policy alone enforces nothing (a policy without a binding is inert) and a binding
   *  alone is a dangling reference, so they are written together or not at all. Idempotent — a
   *  crash-resumed onboard re-runs the apply and the writer replaces both in place. Cluster-scoped,
   *  which is why it rides the TARGET-cluster client rather than the master's project writer. */
  applyAdmissionPolicy(policy: AdmissionPolicyManifest, binding: AdmissionPolicyBindingManifest): Promise<{ created: boolean }>;
  /** Offboard teardown: delete the unit's policy AND its binding by name. Idempotent — an
   *  already-absent pair resolves { deleted: false }. */
  deleteAdmissionPolicy(name: string): Promise<{ deleted: boolean }>;
  /** Does EITHER half of the unit's admission boundary still stand? The mirror of the delete above,
   *  which reports the pair as one, so this answers for the pair as one: a policy left without its
   *  binding is inert and a binding left without its policy is a dangling reference, and both are a
   *  leftover of a teardown that did not finish. Read back by the offboard orphan scan, because a
   *  cluster-scoped object belongs to no Application and no ArgoCD prune ever reaps it. */
  admissionPolicyExists(name: string): Promise<boolean>;
  readDeployState(): Promise<DeployState | null>;
  /** Read ONE key from a namespaced Secret, base64-decoded to a UTF-8 string. The tenant first-admin
   *  invite (create-tenant-activate.ts) reads AUTH_BOOTSTRAP_TOKEN out of the tenant's crypto Secret
   *  `hostyour-app-secrets` in <guid> to authenticate the one-shot bootstrap call to its own example-auth.
   *  An absent Secret OR an absent key resolves null (the caller fails loud with its own message), so a
   *  missing crypto secret never masquerades as a wrong token. Over the SAME per-cluster access as the
   *  reads above (a slave's harvested bearer, or the pod SA for the master) — this port stays READ-only in
   *  spirit; the only writes are the teardown deletes and the relocation credential pair below. */
  readSecretValue(namespace: string, name: string, key: string): Promise<string | null>;
  /** Place a namespaced Secret of literal string values. The ONE caller is the relocation job carrier
   *  (runRelocationJob), which puts the Storage Box credential in the job's namespace just before the
   *  Job starts and deletes it again the moment the Job settles. A pod can only reference Secrets in
   *  its OWN namespace, so a credential the job needs has to stand where the job runs; carrying it as
   *  a literal `value:` on the jobSpec instead writes it into the Job object AND into the pod that Job
   *  renders, both readable by anyone holding `get jobs` / `get pods` in a unit's own namespace, and
   *  the Job outlives its run by its TTL. Idempotent for the crash-resumed step, which re-runs the
   *  SAME job name: a leftover Secret of the name is deleted before the create, mirroring how runJob
   *  replaces a leftover Job. That delete-then-create is also what keeps the grant to `create` +
   *  `delete` with no read verb — the Manager never needs to GET a Secret it wrote itself. */
  applySecret(namespace: string, name: string, data: Record<string, string>): Promise<void>;
  /** Delete a namespaced Secret by name — the reap half of applySecret, and the resumed-step delete
   *  inside it. Absent is success: a run whose Job died before the Secret was written must still settle
   *  clean. */
  deleteSecret(namespace: string, name: string): Promise<void>;
  /** Offboard teardown: delete the target-cluster namespace by name (the G1 identity law makes it the
   *  consumer name; for a tenant it is ONE member namespace <guid>-<member>). ArgoCD's
   *  CreateNamespace=true CREATES the namespace but does NOT delete it on prune, so the offboard Run
   *  deletes it explicitly — otherwise it lingers empty (only the default ServiceAccount + a leftover
   *  cert-manager TLS Secret remain), violating "on delete, everything but the inventory row is gone".
   *  Over the SAME per-cluster access as its reads: the pod SA for the master self-cluster (which then
   *  needs the `delete namespaces` RBAC, granted GitOps-side) or a slave's harvested cluster-admin
   *  bearer (which already can). Idempotent — an already-absent namespace resolves { deleted: false }.
   *  Non-blocking: it issues the delete and returns, never waiting on finalizers (the namespace may sit
   *  Terminating). */
  deleteNamespace(name: string): Promise<{ deleted: boolean }>;
  /** What a namespace IS right now: "absent" (gone, or never existed), "terminating" (delete accepted,
   *  finalizers still holding it) or "active".
   *
   *  deleteNamespace above returns the moment the API accepts the delete, so its `deleted: true` means
   *  "asked", never "gone". A surface stating a purged tenant's namespace as gone on that
   *  basis says more than it knows — a single stuck finalizer on any namespaced resource leaves it Terminating with
   *  everything still in it, while the run reports success. This read is what lets the run say which
   *  of the three it actually is. */
  namespacePhase(name: string): Promise<"absent" | "terminating" | "active">;
  /** Every namespace carrying `labelSelector`, by name. A tenant holds one namespace per member and
   *  they all carry platform/tenant=<guid>, so a teardown that only deleted the names it can DERIVE
   *  would miss a member the inventory no longer lists — a remove-app that dropped the row before the
   *  namespace was reaped, or an orphan whose registration named apps no row ever recorded. Asking the
   *  cluster which namespaces are labelled for this tenant is the only complete answer. */
  listNamespaces(labelSelector: string): Promise<string[]>;
  /** Merge-patch a namespace's metadata.annotations: a string value sets the key, null removes it. The
   *  ONE write is {@link CLAIM_RELOCATING_ANNOTATION}, set by the move's repoint on every SOURCE
   *  namespace of the unit before it commits the new cluster. Fails on an absent namespace (NOT_FOUND):
   *  annotating nothing must never read as success — the whole point is that the mark is standing when
   *  the cascade arrives. */
  annotateNamespace(name: string, annotations: Record<string, string | null>): Promise<void>;
  /** Roll every Deployment and StatefulSet of a namespace, and return how many were rolled.
   *
   *  WHY THIS EXISTS. A unit reads its secrets as environment variables (secretKeyRef), and an env var
   *  is materialized ONCE, when the container starts. ESO updates the Kubernetes Secret when the Vault
   *  value changes; the running process never learns. So a new value is only half delivered when the Secret
   *  changes — the other half is the pods reading it again, and nothing on the platform did that.
   *
   *  HOW: a merge-patch that stamps `hostyour.cloud/restartedAt` on the pod TEMPLATE's annotations.
   *  Changing the template is what makes the manager roll its pods — the same mechanism
   *  `kubectl rollout restart` uses, and the reason the annotation goes on spec.template.metadata and
   *  not on the workload's own metadata, where it would change nothing.
   *
   *  Rolled, not deleted: a rolling update replaces pods one at a time within the workload's own
   *  surge/availability budget, so a unit with more than one replica keeps serving through it.
   *  Returns the count so the run can say what it actually touched; a namespace with no workloads
   *  answers 0 rather than failing, which is the honest answer for a suspended unit. */
  restartWorkloads(namespace: string, stampedAt: string): Promise<number>;
  /** A namespace's current annotations, or null when the namespace is absent. The read half of
   *  annotateNamespace, and what tenant-purge asks before it reaps: a member namespace carrying
   *  {@link CLAIM_RELOCATING_ANNOTATION} belongs to a move in flight, and purging it would drop the
   *  databases that mark exists to keep. The namespace is where the mark that ACTS lives: nothing
   *  reconciles the Tenant CR, so its own relocating annotation moves nothing. */
  readNamespaceAnnotations(namespace: string): Promise<Record<string, string> | null>;
}

/** The namespace annotation the hostyour-cloud service-provisioner reads before it tears a ServiceClaim
 *  down: while it is set, the claim's teardown keeps the claim's DATA — the Mongo databases, the object
 *  storage bucket — and drops only the credentials. Named here, beside the write that sets it, for the
 *  same reason the finalizer above is: the mechanism it belongs to lives in another repo, and this
 *  string is the whole contract between them.
 *
 *  It exists because a repoint is a DELETE from the source's point of view. The source appset stops
 *  selecting the unit, the source Application is deleted with its resources-finalizer, and every
 *  ServiceClaim of the unit falls with it — so without the mark the provisioner drops the source
 *  databases at repoint time, before the restore has read anything and before verify-source-released
 *  measures. It is the ONE relocating mark now (a consumer has
 *  no CR), and it is needed for a TENANT too: a tenant's member charts render ServiceClaims of their
 *  own, so the CR-level release alone does not save a tenant's member databases from this cascade.
 *
 *  A DIFFERENT group from the tenant operator's annotation on purpose: each component owns the
 *  annotations in its own API group, and the reader here is the service-provisioner
 *  (platform.hostyour.cloud), not the tenant operator (operator.hostyour.cloud). */
export const CLAIM_RELOCATING_ANNOTATION = "platform.hostyour.cloud/relocating";

// ---- MasterProjectWriter (the one writing kube path) --------------------------------------

/** The ownership label every Manager-managed consumer AppProject carries. The writer only ever
 *  updates/deletes a project that carries a Manager label — it never touches a foreign/system one. */
/** The pod-template annotation a restart stamps. Its VALUE is never read — what makes the workload
 *  roll is that the template CHANGED — so the timestamp is there for the operator who runs
 *  `kubectl describe` afterwards and wants to know when, and by what. */
export const RESTART_ANNOTATION = "hostyour.cloud/restartedAt";

export const CONSUMER_PROJECT_LABEL = { key: "hostyour.cloud/consumer", value: "true" } as const;

/** The ownership label every Manager-managed TENANT AppProject (<guid>) carries — the tenant
 *  analogue of CONSUMER_PROJECT_LABEL, so one guard covers both formats. */
export const TENANT_PROJECT_LABEL = { key: "hostyour.cloud/tenant", value: "true" } as const;

/** Every label that marks an AppProject as Manager-managed (consumer OR tenant). The writer only
 *  ever updates/deletes a project carrying one of these (isManagerOwned, kube-map.ts) — it fails
 *  closed on a project without any, so it never touches a foreign/system project. */
export const MANAGER_PROJECT_LABELS = [CONSUMER_PROJECT_LABEL, TENANT_PROJECT_LABEL] as const;

/** AppProject names the writer must NEVER create/update/delete — the platform's shared/system
 *  projects: the ones hostyour-cloud's argocd/<stage>/apps/projects.yaml renders, plus ArgoCD's own
 *  built-in "default". Defense in depth behind the plan-time name gate (gates/compose.ts), which
 *  refuses these as unit names before a run exists: the writer fails closed regardless. */
export const RESERVED_PROJECT_NAMES: readonly string[] = ["default", "core", "data", "services", "observability", "cicd", "builds", "manager"];

/** The per-consumer / per-tenant AppProject the Manager renders + writes
 *  (domains/units/appproject.ts). Isolation: name == namespace == the unit; only its own
 *  repo(s) as a source; only its own namespace as a destination; only Namespace (+ the tenant's own
 *  Tenant CR) as a cluster-scoped resource; Application/ApplicationSet/AppProject/Role/RoleBinding
 *  blacklisted so a chart cannot escalate. A destination pins the target by `server` (consumer:
 *  "*" — the appset chooses the cluster) OR by `name` (tenant: the ArgoCD-registered slave name, so
 *  the project only permits deploys to its own slave) — the ArgoCD destination contract accepts
 *  either, exactly one is set per entry. */
export interface AppProjectManifest {
  apiVersion: "argoproj.io/v1alpha1";
  kind: "AppProject";
  metadata: { name: string; namespace: string; labels: Record<string, string> };
  spec: {
    description: string;
    sourceRepos: string[];
    destinations: Array<{ server?: string; name?: string; namespace: string }>;
    clusterResourceWhitelist: Array<{ group: string; kind: string }>;
    namespaceResourceBlacklist: Array<{ group: string; kind: string }>;
    roles: never[];
  };
}

/** ONE clause of a ValidatingAdmissionPolicy: the CEL that must hold, and what an operator is told
 *  when it does not. `message` is the whole explanation the unit's deploy fails with, so it names the
 *  rule rather than restating the expression. */
export interface AdmissionValidation {
  expression: string;
  message: string;
}

/** The per-unit ValidatingAdmissionPolicy the Manager renders + writes
 *  (domains/units/admission-policy.ts). Cluster-scoped, `failurePolicy: Fail` — an unevaluable
 *  expression must REFUSE the object, never wave it through. matchConstraints narrows the kinds the
 *  policy sees at all; matchConditions narrow WHICH requests of those kinds are evaluated — a false
 *  condition SKIPS the request (scope, not verdict), while under `failurePolicy: Fail` an
 *  unevaluable one refuses it. */
export interface AdmissionPolicyManifest {
  apiVersion: "admissionregistration.k8s.io/v1";
  kind: "ValidatingAdmissionPolicy";
  metadata: { name: string; labels: Record<string, string> };
  spec: {
    failurePolicy: "Fail";
    matchConstraints: {
      resourceRules: Array<{ apiGroups: string[]; apiVersions: string[]; operations: string[]; resources: string[] }>;
    };
    matchConditions: Array<{ name: string; expression: string }>;
    validations: AdmissionValidation[];
  };
}

/** The Binding that ARMS one policy. `validationActions: ["Deny"]` is what turns a failing clause into
 *  a refused admission (a binding that only warns would leave the boundary advisory). It carries no
 *  matchResources — for an object that IS a Namespace, a namespaceSelector is matched against the
 *  object's own labels, so a selector pinned to the unit's namespace would skip every foreign
 *  namespace name; the scoping lives in the policy's matchConditions instead. */
export interface AdmissionPolicyBindingManifest {
  apiVersion: "admissionregistration.k8s.io/v1";
  kind: "ValidatingAdmissionPolicyBinding";
  metadata: { name: string; labels: Record<string, string> };
  spec: {
    policyName: string;
    validationActions: ["Deny"];
  };
}

/** The Manager's ONE writing kube port: the per-consumer / per-tenant AppProject on the master's
 *  argocd namespace, over the pod SA's in-cluster access. Guarded — only ever manages a project
 *  carrying a MANAGER_PROJECT_LABELS label, and refuses RESERVED_PROJECT_NAMES (fail-closed). */
export interface MasterProjectWriter {
  /** Idempotent create-or-update (a crash-resumed executor re-runs apply-appproject). Refuses a
   *  reserved name; refuses to overwrite an existing project that is not consumer-owned. */
  applyAppProject(namespace: string, project: AppProjectManifest): Promise<{ created: boolean }>;
  /** Idempotent delete — an already-absent project resolves { deleted: false }. Refuses a reserved
   *  name; refuses to delete a project that is not consumer-owned. */
  deleteAppProject(namespace: string, name: string): Promise<{ deleted: boolean }>;
  /** Does the project still stand? The offboard orphan scan reads it back after the delete: the
   *  isolation project is written outside any chart, so nothing but this Manager ever removes it,
   *  and a project outliving its unit is what a re-onboard of the same name would then find. */
  appProjectExists(namespace: string, name: string): Promise<boolean>;
}

// ---- BuildRbacWriter (a unit's build grants) ------------------------------------------------

/** A namespaced Role the Manager writes (domains/units/build-rbac.ts). `resourceNames` is what
 *  keeps the argo-sync grant to the unit's OWN Applications in a namespace that holds everyone's. */
export interface RoleManifest {
  apiVersion: "rbac.authorization.k8s.io/v1";
  kind: "Role";
  metadata: { name: string; namespace: string; labels: Record<string, string> };
  rules: Array<{ apiGroups: string[]; resources: string[]; verbs: string[]; resourceNames?: string[] }>;
}

/** The RoleBinding that ARMS one Role for one ServiceAccount. The subject may live in ANOTHER
 *  namespace than the binding — that is how the shared EventListener reaches a unit's build namespace,
 *  and how a unit's pipeline reaches the ArgoCD namespace. */
export interface RoleBindingManifest {
  apiVersion: "rbac.authorization.k8s.io/v1";
  kind: "RoleBinding";
  metadata: { name: string; namespace: string; labels: Record<string, string> };
  roleRef: { apiGroup: "rbac.authorization.k8s.io"; kind: "Role"; name: string };
  subjects: Array<{ kind: "ServiceAccount"; name: string; namespace: string }>;
}

/** ONE grant — a Role and the Binding that arms it. They are written and deleted as a pair: a Role
 *  without its Binding grants nothing, and a Binding without its Role is a dangling reference. */
export interface BuildRbacGrant {
  role: RoleManifest;
  binding: RoleBindingManifest;
}

/** ONE object of a grant, as a presence read names it. The two halves are reported separately even
 *  though they are written and deleted as a pair, because a half-deleted grant is exactly what a
 *  teardown that failed between the two leaves behind, and the operator has to be told which half. */
export interface BuildRbacObject {
  kind: "Role" | "RoleBinding";
  namespace: string;
  name: string;
}

/** Writes a unit's build grants. Master-local like the AppProject writer: the build namespace and
 *  the ArgoCD namespace both live on the cluster the Manager itself runs on. Guarded — it only ever
 *  updates or deletes an object carrying the Manager ownership label, so it fails closed and never
 *  touches a Role somebody else put there under the same name. */
export interface BuildRbacWriter {
  /** Idempotent create-or-update of every grant; returns how many objects were CREATED (as opposed to
   *  replaced), so a resumed onboard can say plainly that it changed nothing. */
  applyBuildRbac(grants: readonly BuildRbacGrant[]): Promise<{ created: number }>;
  /** Idempotent delete of every grant by name; returns how many objects were actually there. */
  deleteBuildRbac(grants: readonly BuildRbacGrant[]): Promise<{ deleted: number }>;
  /** Which of these grants' objects still stand — empty when none does. Takes the same grants the
   *  delete takes, so a caller reads back exactly what it asked to have removed. The offboard orphan
   *  scan uses it: the unit's AppProject blacklists Role and RoleBinding, so no chart renders these
   *  and no prune reaps them; only the Manager's own delete does. */
  listBuildRbac(grants: readonly BuildRbacGrant[]): Promise<BuildRbacObject[]>;
}

// ---- RepoCredentialWriter (the per-unit ArgoCD repository credential) ----------------------

/** The ArgoCD repository credential of ONE unit — a Secret labeled
 *  `argocd.argoproj.io/secret-type: repository` in the unit's ArgoCD namespace, carrying the
 *  consumer repo's URL + the unit's own PAT so the generated Application can fetch its private
 *  chart repo. Written IMPERATIVELY at onboarding (like the AppProject and the build grants) and
 *  deleted at offboard/purge: the PAT lives in the sealed store and the local build Vault, neither
 *  of which the target's ESO reads, so no chart-rendered ExternalSecret can materialize it. */
export interface RepoCredentialManifest {
  apiVersion: "v1";
  kind: "Secret";
  metadata: { name: string; namespace: string; labels: Record<string, string> };
  type: "Opaque";
  stringData: { type: "git"; url: string; username: string; password: string };
}

/** Writes the per-unit ArgoCD repository Secret. Master-local like the AppProject writer — every
 *  ArgoCD instance's namespace lives on the cluster this pod runs on. Guarded the same way: it only
 *  ever replaces or deletes a Secret carrying the Manager ownership label, so it fails closed on
 *  a name collision with something somebody else put there. */
export interface RepoCredentialWriter {
  /** Idempotent create-or-replace (a crash-resumed onboard re-runs the step). */
  applyRepoCredential(secret: RepoCredentialManifest): Promise<{ created: boolean }>;
  /** Idempotent delete — an already-absent Secret resolves { deleted: false }. */
  deleteRepoCredential(namespace: string, name: string): Promise<{ deleted: boolean }>;
  /** Does the Secret still stand? The offboard orphan scan reads it back: the credential carries the
   *  unit's PAT and is written outside any chart, so a Secret that outlives its unit is a live
   *  credential nothing deploys with and nothing else will remove. */
  repoCredentialExists(namespace: string, name: string): Promise<boolean>;
}

// ---- ClusterKubeResolver (per-cluster client selection) ------------------------------------

/** The kube clients a Run needs to act on ONE target cluster, plus the ArgoCD namespace its
 *  Application CRs live in. A slave's `clusterReader` speaks to the slave's own API over its
 *  harvested bearer, while `argoReader`/`projectWriter` STAY master-local — a slave's Application
 *  CRs + AppProject live in the per-slave ArgoCD instance ON the master (ns == the slave's name), not
 *  on the slave — so those two are always the master-host clients and only `argoNamespace` moves. */
export interface ResolvedClusterKube {
  clusterReader: ClusterReader;
  argoReader: MasterArgoReader;
  projectWriter: MasterProjectWriter;
  /** Where the Application CR / AppProject live: "argocd" for the master self-cluster, or
   *  the slave's server-row name (the per-slave ArgoCD namespace on the master, e.g. "s1"). */
  argoNamespace: string;
}

/** Returns the RIGHT kube clients for a target cluster (the master self-cluster or a
 *  slave), resolved from inventory (the clusters/servers rows) + the plane credentials — never a
 *  hardcoded cluster-name list. The manager pod holds only its OWN cluster's access (the pod SA
 *  in-cluster); this port is the seam that turns a target `clusterId` into per-cluster access. The
 *  default impl lives in the onboarding domain (cluster-kube.ts); a scripted fake lives in testing/. */
export interface ClusterKubeResolver {
  resolve(clusterId: string): Promise<ResolvedClusterKube>;
}
