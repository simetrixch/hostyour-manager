// Pure mapping layer for the concrete kube adapter (kube.ts): raw API objects in, port types
// out. NO IO here — everything in this file is unit-tested in kube-impl.test.ts against
// hand-built raw objects, so the live calls in kube.ts stay thin (integration-tested on the
// live clusters). The Raw* shapes are structural subsets of the @kubernetes/client-node models
// (every field optional), so the live code passes V1Deployment & friends straight in.
import type {
  ArgoAppStatus, ArgoApplicationRow, ArgoSyncSource, ArgoTargetSource, ExternalSecretRow, WorkloadStatus, DeployState,
} from "./port.ts";
import { MANAGER_PROJECT_LABELS, RESERVED_PROJECT_NAMES } from "./port.ts";
import { ARGO_SYNC, ARGO_HEALTH } from "../../../shared/enums.ts";
import { errValidation } from "../../kernel/errors.ts";

/** A k8s-style condition — shared by workloads, ExternalSecrets and Argo Applications. */
export interface RawCondition {
  type?: string;
  status?: string;
  reason?: string;
  message?: string;
}

const asObject = <T extends object>(raw: unknown): T =>
  (typeof raw === "object" && raw !== null ? raw : {}) as T;

/** Keep `v` when it is one of the allowed enum values, else "Unknown" — a CRD status field is
 *  server-provided text, never trusted to match our union. */
const pick = <T extends string>(allowed: readonly T[], v: string | undefined): T | "Unknown" =>
  allowed.find((a) => a === v) ?? "Unknown";

// ---- Argo Application (argoproj.io/v1alpha1) ----------------------------------------------

interface RawArgoApp {
  /** The DESIRED side of the CR — where the GitOps pointer's pin lives. An app may declare either
   *  the single `source` or the `sources[]` array (the tenant base Application uses the array even
   *  with ONE source, which is why the singular status.sync.revision stays empty on it). Each entry
   *  of `sources[]` carries its OWN repoURL, so the desired side needs no index-alignment contract —
   *  unlike the synced side, which pairs revisions[i] with comparedTo.sources[i]. */
  spec?: {
    source?: { targetRevision?: unknown };
    sources?: Array<{ repoURL?: unknown; targetRevision?: unknown }>;
    syncPolicy?: { managedNamespaceMetadata?: { labels?: unknown } };
  };
  status?: {
    sync?: {
      status?: string;
      revision?: string;
      /** MULTI-SOURCE apps: one synced revision per source, index-aligned with comparedTo.sources
       *  (the Argo API contract) — `revision` stays empty on such an app. */
      revisions?: unknown[];
      comparedTo?: { sources?: Array<{ repoURL?: unknown; path?: unknown; helm?: { valueFiles?: unknown; valuesObject?: unknown } }> };
    };
    health?: { status?: string };
    operationState?: { message?: string; phase?: string };
    conditions?: RawCondition[];
  };
}

/** Map a raw Application CR to the port's ArgoAppStatus. A fresh CR without `.status` (Argo has
 *  not reconciled yet) maps to Unknown/Unknown with a null revision. A MULTI-SOURCE app (the
 *  generated consumer Application) reports `sync.revisions[]` index-aligned with
 *  `sync.comparedTo.sources[]` — mapped to syncSources so the caller compares per-repo
 *  (syncedRevisionFor); its single `sync.revision` is empty and stays null. Its DESIRED side maps
 *  the same way: `.spec.sources[]` becomes targetSources (read per-repo via targetedRevisionFor)
 *  and the singular `.spec.source` becomes targetRevision — the two forms are kept APART here rather
 *  than folded into one field, because folding them is exactly what let a caller read a multi-source
 *  app's source 0 believing it had the app's one pin. The message prefers
 *  the last operation's message (sync errors live there), then the first non-empty condition. The
 *  last sync operation's PHASE maps to opPhase (watch-sync tells a still-building sync from a failed
 *  one by it); absent when the app has never synced, so the port field stays omitted. */
export function mapArgoStatus(raw: unknown): ArgoAppStatus {
  const app = asObject<RawArgoApp>(raw);
  const status = app.status;
  const message = argoMessage(status);
  const opPhase = argoOpPhase(status);
  const deletionError = argoDeletionError(status);
  const syncSources = mapSyncSources(status?.sync);
  const targetSources = mapTargetSources(app.spec);
  const namespaceLabels = mapNamespaceLabels(app.spec);
  return {
    syncRevision: status?.sync?.revision ?? null,
    ...(namespaceLabels !== undefined ? { namespaceLabels } : {}),
    ...(syncSources !== undefined ? { syncSources } : {}),
    targetRevision: text(app.spec?.source?.targetRevision),
    ...(targetSources !== undefined ? { targetSources } : {}),
    sync: pick(ARGO_SYNC, status?.sync?.status),
    health: pick(ARGO_HEALTH, status?.health?.status),
    ...(message !== undefined ? { message } : {}),
    ...(opPhase !== undefined ? { opPhase } : {}),
    ...(deletionError !== undefined ? { deletionError } : {}),
  };
}

/** The DESIRED side of `.spec.sources[]`: each source's own repoURL paired with its own
 *  targetRevision. Undefined (not empty) when the app declares no `sources[]` — the singular
 *  `.spec.source` form, and a Missing app with no spec at all — so the port field stays absent there
 *  and targetedRevisionFor falls through to the singular field. A server-provided entry of an
 *  unexpected type maps to null, never a fabricated string; the CR is server-provided text. */
function mapTargetSources(spec: RawArgoApp["spec"]): ArgoTargetSource[] | undefined {
  const sources = spec?.sources;
  if (!Array.isArray(sources) || sources.length === 0) return undefined;
  return sources.map((src) => ({ repoURL: text(src?.repoURL), targetRevision: text(src?.targetRevision) }));
}

/** A CR string field kept only when it IS a non-empty string, else null — the one coercion rule the
 *  spec mapping applies, so an unexpected type can never reach a caller as a revision or a repo. */
function text(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

/** Pair revisions[i] with comparedTo.sources[i].repoURL (the Argo index-alignment contract).
 *  Undefined (not empty) when the app is single-source, so the port field stays absent there;
 *  a server-provided entry of an unexpected type maps to null, never a fabricated string. */
function mapSyncSources(sync: NonNullable<RawArgoApp["status"]>["sync"]): ArgoSyncSource[] | undefined {
  const revisions = sync?.revisions;
  if (!Array.isArray(revisions) || revisions.length === 0) return undefined;
  const sources = sync?.comparedTo?.sources ?? [];
  return revisions.map((rev, i) => {
    const src = sources[i];
    const valueFiles = src?.helm?.valueFiles;
    const valuesObject = src?.helm?.valuesObject;
    return {
      repoURL: text(src?.repoURL),
      revision: text(rev),
      ...(src?.path !== undefined ? { path: text(src.path) } : {}),
      ...(Array.isArray(valueFiles) ? { valueFiles: valueFiles.filter((f): f is string => typeof f === "string") } : {}),
      ...(isRecord(valuesObject) ? { valuesObject } : {}),
    };
  });
}

/** `.spec.syncPolicy.managedNamespaceMetadata.labels`, kept only as a map of strings. */
function mapNamespaceLabels(spec: RawArgoApp["spec"]): Record<string, string> | undefined {
  const labels = spec?.syncPolicy?.managedNamespaceMetadata?.labels;
  if (!isRecord(labels)) return undefined;
  return Object.fromEntries(Object.entries(labels).filter((e): e is [string, string] => typeof e[1] === "string"));
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function argoMessage(status: RawArgoApp["status"]): string | undefined {
  const op = status?.operationState?.message;
  if (typeof op === "string" && op !== "") return op;
  return (status?.conditions ?? []).find((c) => typeof c.message === "string" && c.message !== "")?.message;
}

/** The message of the app's `DeletionError` condition, when ArgoCD reports one — the condition it
 *  sets while a deletion cannot proceed (`error getting app project …`). Kept apart from `message`,
 *  which prefers the last operation's own text and would hide it behind "successfully synced".
 *  Undefined otherwise, so the port field stays absent (exactOptionalPropertyTypes). */
function argoDeletionError(status: RawArgoApp["status"]): string | undefined {
  const c = (status?.conditions ?? []).find((c) => c.type === "DeletionError");
  return typeof c?.message === "string" && c.message !== "" ? c.message : undefined;
}

/** The phase of the app's last sync operation (`status.operationState.phase`) — a non-empty string
 *  when Argo has run a sync (Running/Succeeded/Failed/Error/Terminating), else undefined so the port
 *  field stays absent (exactOptionalPropertyTypes) on an app that has never synced. Kept verbatim,
 *  never coerced to a fixed vocabulary: watch-sync only tests for the terminal Failed/Error values. */
function argoOpPhase(status: RawArgoApp["status"]): string | undefined {
  const phase = status?.operationState?.phase;
  return typeof phase === "string" && phase !== "" ? phase : undefined;
}

// ---- Argo Application SET (the tenant fan-out watch, kube.ts:watchApplicationSet) -----------

/** The status a set-watch reports for an EXPECTED Application still ABSENT from the list — its
 *  ApplicationSet has not generated the CR yet, or it was pruned. The single Missing constant the
 *  set mapping owns; kube.ts's watchApplication reuses it for the same "gone/not-yet" case. */
export const MISSING_APP_STATUS: ArgoAppStatus = Object.freeze({ syncRevision: null, targetRevision: null, sync: "Unknown", health: "Missing" });

/** Build the name→status map one set-watch tick observes. Each raw list item is keyed by its
 *  metadata.name and mapped via the pure mapArgoStatus; then every EXPECTED name still absent is
 *  filled with MISSING_APP_STATUS — the completeness gate, so the caller's `until` waits for the
 *  whole fan-out to appear AND converge. The map is keyed EXACTLY by `expected`; present items not
 *  in `expected` (a foreign or stale Application caught by a loose label selector) are ignored, so
 *  they can never mask a missing member. Pure — the live list IO lives in kube.ts. */
export function mapApplicationSet(rawItems: readonly unknown[], expected: readonly string[]): Map<string, ArgoAppStatus> {
  const present = new Map<string, ArgoAppStatus>();
  for (const raw of rawItems) {
    const name = asObject<{ metadata?: { name?: string } }>(raw).metadata?.name;
    if (typeof name === "string" && name !== "") present.set(name, mapArgoStatus(raw));
  }
  const byName = new Map<string, ArgoAppStatus>();
  for (const name of expected) byName.set(name, present.get(name) ?? MISSING_APP_STATUS);
  return byName;
}

/** Every Application a list tick found, keyed by nothing: the row carries its own name, and a name
 *  the caller did not expect is KEPT. That is the difference from mapApplicationSet above, which
 *  answers a caller that can name its set; this answers one that counts what a generator produced. */
export function mapApplications(rawItems: readonly unknown[]): ArgoApplicationRow[] {
  const rows: ArgoApplicationRow[] = [];
  for (const raw of rawItems) {
    const name = asObject<{ metadata?: { name?: string } }>(raw).metadata?.name;
    if (typeof name !== "string" || name === "") continue;
    rows.push({ name, ...mapArgoStatus(raw) });
  }
  return rows;
}

// ---- Workloads (apps/v1) -------------------------------------------------------------------

export interface RawDeployment {
  metadata?: { name?: string; generation?: number };
  spec?: { replicas?: number };
  status?: { availableReplicas?: number; conditions?: RawCondition[]; observedGeneration?: number; updatedReplicas?: number; replicas?: number };
}

export interface RawStatefulSet {
  metadata?: { name?: string; generation?: number };
  spec?: { replicas?: number };
  status?: { readyReplicas?: number; conditions?: RawCondition[]; observedGeneration?: number; currentRevision?: string; updateRevision?: string };
}

/** A Deployment done rolling out its current template — what `kubectl rollout status` waits for:
 *  the controller has seen the newest generation, every replica runs that template, no old one is
 *  left, and all are available. A restarted Deployment reads false while an old pod still serves,
 *  which the availability `smoke` counts as ready. */
export function deploymentRolledOut(d: RawDeployment): boolean {
  const want = d.spec?.replicas ?? 1;
  const s = d.status;
  return (s?.observedGeneration ?? 0) >= (d.metadata?.generation ?? 0) && (s?.updatedReplicas ?? 0) >= want && (s?.replicas ?? 0) <= want && (s?.availableReplicas ?? 0) >= want;
}

/** The same for a StatefulSet: its current revision is the update revision, and every replica is ready. */
export function statefulSetRolledOut(s: RawStatefulSet): boolean {
  const want = s.spec?.replicas ?? 1;
  const st = s.status;
  return (st?.observedGeneration ?? 0) >= (s.metadata?.generation ?? 0) && st?.currentRevision === st?.updateRevision && (st?.readyReplicas ?? 0) >= want;
}

export interface RawDaemonSet {
  metadata?: { name?: string };
  status?: { numberAvailable?: number; desiredNumberScheduled?: number; conditions?: RawCondition[] };
}

/** Available when availableReplicas covers spec.replicas (absent spec.replicas defaults to 1,
 *  matching the API server's own default). */
export function mapDeployment(d: RawDeployment): WorkloadStatus {
  return workload("Deployment", d.metadata?.name, d.status?.availableReplicas ?? 0, d.spec?.replicas ?? 1, d.status?.conditions);
}

export function mapStatefulSet(s: RawStatefulSet): WorkloadStatus {
  return workload("StatefulSet", s.metadata?.name, s.status?.readyReplicas ?? 0, s.spec?.replicas ?? 1, s.status?.conditions);
}

/** A DaemonSet with nothing scheduled (0 desired, e.g. no matching nodes) counts as available —
 *  there is nothing that could be unready. */
export function mapDaemonSet(d: RawDaemonSet): WorkloadStatus {
  return workload("DaemonSet", d.metadata?.name, d.status?.numberAvailable ?? 0, d.status?.desiredNumberScheduled ?? 0, d.status?.conditions);
}

function workload(kind: string, name: string | undefined, ready: number, desired: number, conditions: RawCondition[] | undefined): WorkloadStatus {
  const available = ready >= desired;
  // ready/desired ride along even on the available path: a workload switched OFF reads 0 of 0, which is
  // available, so only the counts distinguish "running" from "suspended".
  if (available) return { kind, name: name ?? "(unnamed)", available, desired, ready };
  // Surface WHY: the first False condition's message (e.g. a Deployment's Progressing=False
  // "ReplicaSet ... has timed out progressing"), its reason as fallback, else the replica count.
  const bad = (conditions ?? []).find((c) => c.status === "False" && (c.message !== undefined || c.reason !== undefined));
  const message = bad?.message ?? bad?.reason ?? `${ready}/${desired} replicas available`;
  return { kind, name: name ?? "(unnamed)", available, desired, ready, message };
}

// ---- ExternalSecrets (external-secrets.io/v1) ----------------------------------------------

interface RawExternalSecret {
  metadata?: { name?: string };
  spec?: { target?: { name?: string } };
  status?: { conditions?: RawCondition[]; refreshTime?: string | null };
}

/** Every ExternalSecret a list tick found, one row each: the name, whether the Ready condition
 *  reads True, that condition's reason, the Secret the spec targets, and when ESO last wrote it.
 *
 *  ONE MAPPER AND NOT TWO. `SmokeResult.externalSecretsReady` is derived from these rows
 *  (kube.ts), so the bit a smoke reports and the rows a gate names cannot drift apart — which they
 *  would the first time one of two readings learned about a condition the other did not. */
export function mapExternalSecrets(rawItems: readonly unknown[]): ExternalSecretRow[] {
  const rows: ExternalSecretRow[] = [];
  for (const raw of rawItems) {
    const item = asObject<RawExternalSecret>(raw);
    const name = item.metadata?.name;
    if (typeof name !== "string" || name === "") continue;
    const ready = (item.status?.conditions ?? []).find((c) => c.type === "Ready");
    rows.push({
      name,
      ready: ready?.status === "True",
      reason: ready?.reason ?? "",
      targetSecret: item.spec?.target?.name ?? "",
      refreshTime: item.status?.refreshTime ?? "",
    });
  }
  return rows;
}

/** True when EVERY row reports Ready. Zero ExternalSecrets is ready — a namespace without secrets
 *  has nothing that could be unsynced. */
export function externalSecretsAllReady(rows: readonly ExternalSecretRow[]): boolean {
  return rows.every((row) => row.ready);
}

// ---- Deploy-state ConfigMap (kube-system/hostyour-deploy-state) --------------------------------

/** Map the ConfigMap's `.data` to DeployState. A present-but-malformed ConfigMap throws
 *  VALIDATION (never a silent default) — attest-target treats that as fail-closed, same as
 *  absence, but with an actionable message. */
export function mapDeployState(data: Record<string, string> | undefined): DeployState {
  const d = data ?? {};
  const need = (key: string): string => {
    const v = d[key];
    if (v === undefined || v === "") {
      throw errValidation(`deploy-state ConfigMap is missing "${key}"`, { presentKeys: Object.keys(d) });
    }
    return v;
  };
  const rawGeneration = need("generation");
  if (!/^-?\d+$/.test(rawGeneration)) {
    throw errValidation(`deploy-state generation is not an integer: "${rawGeneration}"`);
  }
  return {
    domain: need("domain"),
    stage: need("stage"),
    writtenAt: need("writtenAt"),
    generation: Number.parseInt(rawGeneration, 10),
  };
}

// ---- AppProject writer guards (MasterProjectWriter, kube.ts) --------------------------------

/** Fail closed before any write: the writer must never create/update/delete a reserved platform
 *  project. The name pattern + identity law already prevent collisions — this is defense in depth. */
export function assertWritableProjectName(name: string): void {
  if (RESERVED_PROJECT_NAMES.includes(name)) {
    throw errValidation(`refusing to write AppProject "${name}" — it is a reserved platform project`);
  }
}

/** True when a raw AppProject carries ANY Manager ownership label (consumer OR tenant) — the
 *  writer manages both formats' isolation projects, so one guard covers both. */
export function isManagerOwned(raw: unknown): boolean {
  const labels = asObject<{ metadata?: { labels?: Record<string, string> } }>(raw).metadata?.labels ?? {};
  return MANAGER_PROJECT_LABELS.some((l) => labels[l.key] === l.value);
}
