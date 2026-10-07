// shared/secret-sync-order.ts
// The secret sync order over a set of rendered documents, as the consumer gate G30 and the tenant gate
// T6 hold it: a workload whose pod reads a Secret that a controller writes, the service-provisioner for
// a ServiceClaim or ESO for an ExternalSecret, stands in a LATER sync wave than the object that has it
// written, and no PreSync hook reads such a Secret.
//
// WHY: the service-provisioner writes a claim's Secret, then marks the claim Ready (hostyour-cloud
// clusters/inventories/service-provisioner/templates/configmap.yaml, reconcile); ESO marks an
// ExternalSecret Ready once its target Secret is written. Argo CD holds the next sync wave until the
// objects of the current one are Healthy (its ServiceClaim check in clusters/bootstrap/argocd/values.tpl,
// its built-in ExternalSecret check). That orders nothing inside ONE wave: a Deployment beside its pull
// claim starts its pod before the pull Secret exists, the first pull fails, and the pod waits on the
// kubelet's back-off. A PreSync hook runs before every wave, so no wave puts a writer ahead of it; a
// PostSync, SyncFail or PostDelete hook runs after every wave, so every writer is Ready by then.
//
// Pure and synchronous. A document's `raw` is UNTRUSTED, so every nested read is guarded and a malformed
// shape reads as "no reference", never a crash.

/** The fields of one rendered document the order reads; `docIndex` names an unnamed one. */
export interface SyncOrderDoc {
  kind: string;
  name: string;
  raw: Record<string, unknown>;
  docIndex?: number;
}

export const SYNC_WAVE_ANNOTATION = "argocd.argoproj.io/sync-wave";
const HOOK_ANNOTATION = "argocd.argoproj.io/hook";

export const SYNC_ORDER_EXPECTED =
  "every workload that reads a Secret a ServiceClaim or an ExternalSecret has written stands in a later sync wave than that object, " +
  "and no PreSync hook reads such a Secret (Argo CD holds a wave until its objects are Healthy, and runs PreSync before every wave)";

/** Hook phases that run after every sync wave: whatever their numbers, every writer is Ready by then. */
const AFTER_EVERY_WAVE = ["PostSync", "SyncFail", "PostDelete"];

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const list = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.map(record).filter((r): r is Record<string, unknown> => r !== null) : [];
const text = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

function annotationsOf(doc: SyncOrderDoc): Record<string, unknown> {
  return record(record(doc.raw.metadata)?.annotations) ?? {};
}

/** A wave annotation as Argo CD reads it (strconv.Atoi): an optional sign and digits, nothing around
 *  them; 0 when absent or not such an integer. */
export function waveOf(doc: SyncOrderDoc): number {
  const value = annotationsOf(doc)[SYNC_WAVE_ANNOTATION];
  if (typeof value === "number") return Number.isInteger(value) ? value : 0;
  return typeof value === "string" && /^[+-]?\d+$/.test(value) ? Number(value) : 0;
}

function hookPhases(doc: SyncOrderDoc): string[] {
  const value = annotationsOf(doc)[HOOK_ANNOTATION];
  return typeof value === "string" ? value.split(",").map((s) => s.trim()) : [];
}

/** The Secret a controller writes for `doc`: a claim's `spec.secretName`, else `<claim>-<service>` as the
 *  provisioner names it; an ExternalSecret's `spec.target.name`, else its own name, as ESO names it. */
function writtenSecret(doc: SyncOrderDoc): string | null {
  const spec = record(doc.raw.spec);
  if (doc.kind === "ServiceClaim") {
    const service = text(spec?.service);
    return text(spec?.secretName) ?? (service && doc.name ? `${doc.name}-${service}` : null);
  }
  if (doc.kind === "ExternalSecret") return text(record(spec?.target)?.name) ?? (doc.name || null);
  return null;
}

/** The pod spec of a workload kind, or null for anything that runs no pod. */
function podOf(doc: SyncOrderDoc): Record<string, unknown> | null {
  const spec = record(doc.raw.spec);
  if (doc.kind === "Pod") return spec;
  if (doc.kind === "CronJob") return record(record(record(record(spec?.jobTemplate)?.spec)?.template)?.spec);
  if (["Deployment", "StatefulSet", "DaemonSet", "ReplicaSet", "Job"].includes(doc.kind)) return record(record(spec?.template)?.spec);
  return null;
}

/** Every Secret a pod names, with where: pull secrets, env, envFrom, secret and projected volumes. */
function secretsOf(pod: Record<string, unknown>): { name: string; fieldPath: string }[] {
  const found: { name: string; fieldPath: string }[] = [];
  const add = (name: unknown, fieldPath: string): void => {
    const n = text(name);
    if (n) found.push({ name: n, fieldPath });
  };
  list(pod.imagePullSecrets).forEach((s, i) => add(s.name, `imagePullSecrets[${i}].name`));
  for (const group of ["initContainers", "containers"]) {
    list(pod[group]).forEach((c, ci) => {
      list(c.env).forEach((e, ei) => add(record(record(e.valueFrom)?.secretKeyRef)?.name, `${group}[${ci}].env[${ei}].valueFrom.secretKeyRef.name`));
      list(c.envFrom).forEach((e, ei) => add(record(e.secretRef)?.name, `${group}[${ci}].envFrom[${ei}].secretRef.name`));
    });
  }
  list(pod.volumes).forEach((v, vi) => {
    add(record(v.secret)?.secretName, `volumes[${vi}].secret.secretName`);
    list(record(v.projected)?.sources).forEach((s, si) => add(record(s.secret)?.name, `volumes[${vi}].projected.sources[${si}].secret.name`));
  });
  return found;
}

/** The first workload that reads a written Secret too early: `doc` reads `secret` at `fieldPath`, and
 *  `owner` is the object whose controller writes it. */
export interface SyncOrderBreach<D extends SyncOrderDoc> {
  doc: D;
  owner: D;
  secret: string;
  fieldPath: string;
  isPreSync: boolean;
}

export interface SyncOrderReading<D extends SyncOrderDoc> {
  /** How many Secrets the documents have a controller write. */
  writtenSecrets: number;
  /** How many reads of a written Secret were judged, up to and including a breach. */
  uses: number;
  breach: SyncOrderBreach<D> | null;
}

/** Reads the order of `docs`, one sync of one Application, and returns the first breach in document order. */
export function readSyncOrder<D extends SyncOrderDoc>(docs: readonly D[]): SyncOrderReading<D> {
  const writers = new Map<string, D>();
  for (const doc of docs) {
    const secret = writtenSecret(doc);
    if (secret) writers.set(secret, doc);
  }
  let uses = 0;
  if (writers.size === 0) return { writtenSecrets: 0, uses, breach: null };
  for (const doc of docs) {
    const pod = podOf(doc);
    const phases = hookPhases(doc);
    if (!pod || phases.includes("Skip") || (phases.length > 0 && phases.every((p) => AFTER_EVERY_WAVE.includes(p)))) continue;
    const isPreSync = phases.includes("PreSync");
    for (const { name, fieldPath } of secretsOf(pod)) {
      const owner = writers.get(name);
      if (!owner) continue;
      uses++;
      if (!isPreSync && waveOf(doc) > waveOf(owner)) continue;
      return { writtenSecrets: writers.size, uses, breach: { doc, owner, secret: name, fieldPath, isPreSync } };
    }
  }
  return { writtenSecrets: writers.size, uses, breach: null };
}

const label = (doc: SyncOrderDoc): string => `${doc.kind}/${doc.name || `#${doc.docIndex ?? "?"}`}`;
const writer = (doc: SyncOrderDoc): string => (doc.kind === "ExternalSecret" ? "ESO" : "the service-provisioner");

/** The found sentence of a breach. */
export function syncOrderBreachFound(b: SyncOrderBreach<SyncOrderDoc>): string {
  return b.isPreSync
    ? `${label(b.doc)} is a PreSync hook and uses Secret "${b.secret}" of ${label(b.owner)} (wave ${waveOf(b.owner)}).`
    : `${label(b.doc)} (wave ${waveOf(b.doc)}) uses Secret "${b.secret}" of ${label(b.owner)} (wave ${waveOf(b.owner)}).`;
}

/** The reason sentence of a breach: why the pod meets no Secret, and what moves it. */
export function syncOrderBreachReason(b: SyncOrderBreach<SyncOrderDoc>): string {
  return b.isPreSync
    ? `${label(b.doc)} runs before every sync wave, so the Secret "${b.secret}" of ${label(b.owner)} does not exist yet; take the hook off PreSync or stop it using that Secret.`
    : `${label(b.doc)} stands in the same or an earlier sync wave than ${label(b.owner)}, so its pod starts before ${writer(b.owner)} has written "${b.secret}"; ` +
      `put ${label(b.owner)} in a wave below ${waveOf(b.doc)} (${SYNC_WAVE_ANNOTATION}).`;
}
