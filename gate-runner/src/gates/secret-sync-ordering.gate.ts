// gate-runner/src/gates/secret-sync-ordering.gate.ts
// G30 "secret sync ordering" (HARD). A workload whose pod reads a Secret that a controller writes, the
// service-provisioner for a ServiceClaim or ESO for an ExternalSecret, stands in a LATER sync wave than
// the object that has it written, and no PreSync hook reads such a Secret.
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
// Pure and synchronous over the read-only GateContext. ctx.rendered[i].raw is UNTRUSTED, so every
// nested read is guarded and a malformed shape reads as "no reference", never a crash.
import type { CheckGate, GateContext, RenderedDoc } from "./gate.ts";
import type { GateEvidence, GateResult } from "../../../shared/gates.ts";
import { fail, pass } from "./result.ts";

const ID = "G30";
const TITLE = "secret sync ordering";
const SEVERITY = "hard" as const;

const WAVE_ANNOTATION = "argocd.argoproj.io/sync-wave";
const HOOK_ANNOTATION = "argocd.argoproj.io/hook";

const EXPECTED =
  "every workload that reads a Secret a ServiceClaim or an ExternalSecret has written stands in a later sync wave than that object, " +
  "and no PreSync hook reads such a Secret (Argo CD holds a wave until its objects are Healthy, and runs PreSync before every wave)";

/** Hook phases that run after every sync wave: whatever their numbers, every writer is Ready by then. */
const AFTER_EVERY_WAVE = ["PostSync", "SyncFail", "PostDelete"];

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const list = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.map(record).filter((r): r is Record<string, unknown> => r !== null) : [];
const text = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

function annotationsOf(doc: RenderedDoc): Record<string, unknown> {
  return record(record(doc.raw.metadata)?.annotations) ?? {};
}

/** A wave annotation as Argo CD reads it (strconv.Atoi): an optional sign and digits, nothing around
 *  them; 0 when absent or not such an integer. */
function waveOf(doc: RenderedDoc): number {
  const value = annotationsOf(doc)[WAVE_ANNOTATION];
  if (typeof value === "number") return Number.isInteger(value) ? value : 0;
  return typeof value === "string" && /^[+-]?\d+$/.test(value) ? Number(value) : 0;
}

function hookPhases(doc: RenderedDoc): string[] {
  const value = annotationsOf(doc)[HOOK_ANNOTATION];
  return typeof value === "string" ? value.split(",").map((s) => s.trim()) : [];
}

/** The Secret a controller writes for `doc`: a claim's `spec.secretName`, else `<claim>-<service>` as the
 *  provisioner names it; an ExternalSecret's `spec.target.name`, else its own name, as ESO names it. */
function writtenSecret(doc: RenderedDoc): string | null {
  const spec = record(doc.raw.spec);
  if (doc.kind === "ServiceClaim") {
    const service = text(spec?.service);
    return text(spec?.secretName) ?? (service && doc.name ? `${doc.name}-${service}` : null);
  }
  if (doc.kind === "ExternalSecret") return text(record(spec?.target)?.name) ?? (doc.name || null);
  return null;
}

/** The pod spec of a workload kind, or null for anything that runs no pod. */
function podOf(doc: RenderedDoc): Record<string, unknown> | null {
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

const label = (doc: RenderedDoc): string => `${doc.kind}/${doc.name || `#${doc.docIndex}`}`;
const writer = (doc: RenderedDoc): string => (doc.kind === "ExternalSecret" ? "ESO" : "the service-provisioner");

export const secretSyncOrderingGate: CheckGate = {
  id: ID,
  title: TITLE,
  severity: SEVERITY,
  check(ctx: GateContext): GateResult {
    const writers = new Map<string, RenderedDoc>();
    for (const doc of ctx.rendered) {
      const secret = writtenSecret(doc);
      if (secret) writers.set(secret, doc);
    }
    if (writers.size === 0) {
      return pass({ id: ID, title: TITLE, severity: SEVERITY, expected: EXPECTED, found: "no ServiceClaim or ExternalSecret is rendered, so there is no written Secret to order a workload after." });
    }
    let uses = 0;
    for (const doc of ctx.rendered) {
      const pod = podOf(doc);
      const phases = hookPhases(doc);
      if (!pod || phases.includes("Skip") || (phases.length > 0 && phases.every((p) => AFTER_EVERY_WAVE.includes(p)))) continue;
      const preSync = phases.includes("PreSync");
      for (const { name, fieldPath } of secretsOf(pod)) {
        const owner = writers.get(name);
        if (!owner) continue;
        uses++;
        if (!preSync && waveOf(doc) > waveOf(owner)) continue;
        const evidence: GateEvidence = { source: "rendered", docIndex: doc.docIndex, kind: doc.kind, name: doc.name, fieldPath, value: name };
        const found = preSync
          ? `${label(doc)} is a PreSync hook and uses Secret "${name}" of ${label(owner)} (wave ${waveOf(owner)}).`
          : `${label(doc)} (wave ${waveOf(doc)}) uses Secret "${name}" of ${label(owner)} (wave ${waveOf(owner)}).`;
        const reason = preSync
          ? `${label(doc)} runs before every sync wave, so the Secret "${name}" of ${label(owner)} does not exist yet; take the hook off PreSync or stop it using that Secret.`
          : `${label(doc)} stands in the same or an earlier sync wave than ${label(owner)}, so its pod starts before ${writer(owner)} has written "${name}"; ` +
            `put ${label(owner)} in a wave below ${waveOf(doc)} (${WAVE_ANNOTATION}).`;
        return fail({ id: ID, title: TITLE, severity: SEVERITY, expected: EXPECTED, found, reason, evidence: [evidence] });
      }
    }
    return pass({
      id: ID, title: TITLE, severity: SEVERITY, expected: EXPECTED,
      found: `${writers.size} written Secret(s); ${uses} use(s) by workloads, each in a later wave than the object that writes it.`,
    });
  },
};
