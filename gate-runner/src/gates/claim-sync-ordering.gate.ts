// gate-runner/src/gates/claim-sync-ordering.gate.ts
// G30 "claim sync ordering" (HARD). A workload that uses the Secret of a ServiceClaim stands in a LATER
// sync wave than the claim, and no PreSync hook uses such a Secret.
//
// WHY: the service-provisioner writes a claim's Secret, then marks the claim Ready (hostyour-cloud
// clusters/inventories/service-provisioner/templates/configmap.yaml, reconcile), and Argo CD holds the
// next sync wave until every claim of the current one is Ready (clusters/bootstrap/argocd/values.tpl,
// the ServiceClaim health check). That orders nothing inside ONE wave: a Deployment beside its pull
// claim starts its pod before the pull Secret exists, the first pull fails, and the pod waits on the
// kubelet's back-off. It healed in 16 s on a node that already held the image; on one that does not,
// it can outlast the run that watches the first sync. A PreSync hook runs before every wave, so no
// wave puts a claim ahead of it.
//
// Pure and synchronous over the read-only GateContext. ctx.rendered[i].raw is UNTRUSTED, so every
// nested read is guarded and a malformed shape reads as "no reference", never a crash.
import type { CheckGate, GateContext, RenderedDoc } from "./gate.ts";
import type { GateEvidence, GateResult } from "../../../shared/gates.ts";
import { fail, pass } from "./result.ts";

const ID = "G30";
const TITLE = "claim sync ordering";
const SEVERITY = "hard" as const;

const WAVE_ANNOTATION = "argocd.argoproj.io/sync-wave";
const HOOK_ANNOTATION = "argocd.argoproj.io/hook";

const EXPECTED =
  "every workload that uses the Secret of a ServiceClaim stands in a later sync wave than that claim, " +
  "and no PreSync hook uses such a Secret (Argo CD holds a wave until its claims are Ready, and runs PreSync before every wave)";

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const list = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.map(record).filter((r): r is Record<string, unknown> => r !== null) : [];
const text = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

function annotationsOf(doc: RenderedDoc): Record<string, unknown> {
  return record(record(doc.raw.metadata)?.annotations) ?? {};
}

/** A wave annotation as Argo CD reads it: an integer, 0 when absent or not an integer. */
function waveOf(doc: RenderedDoc): number {
  const value = annotationsOf(doc)[WAVE_ANNOTATION];
  const parsed = typeof value === "number" ? value : typeof value === "string" && /^-?\d+$/.test(value.trim()) ? Number(value.trim()) : 0;
  return Number.isInteger(parsed) ? parsed : 0;
}

function isPreSync(doc: RenderedDoc): boolean {
  const value = annotationsOf(doc)[HOOK_ANNOTATION];
  return typeof value === "string" && value.split(",").map((s) => s.trim()).includes("PreSync");
}

/** The Secret a claim's provisioner writes: `spec.secretName`, else `<claim>-<service>` as the provisioner names it. */
function claimSecret(doc: RenderedDoc): string | null {
  const spec = record(doc.raw.spec);
  const service = text(spec?.service);
  return text(spec?.secretName) ?? (service && doc.name ? `${doc.name}-${service}` : null);
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

export const claimSyncOrderingGate: CheckGate = {
  id: ID,
  title: TITLE,
  severity: SEVERITY,
  check(ctx: GateContext): GateResult {
    const claims = new Map<string, RenderedDoc>();
    for (const doc of ctx.rendered) {
      const secret = doc.kind === "ServiceClaim" ? claimSecret(doc) : null;
      if (secret) claims.set(secret, doc);
    }
    if (claims.size === 0) {
      return pass({ id: ID, title: TITLE, severity: SEVERITY, expected: EXPECTED, found: "no ServiceClaim is rendered, so there is no claim Secret to order a workload after." });
    }
    let uses = 0;
    for (const doc of ctx.rendered) {
      const pod = podOf(doc);
      if (!pod) continue;
      for (const { name, fieldPath } of secretsOf(pod)) {
        const owner = claims.get(name);
        if (!owner) continue;
        uses++;
        const preSync = isPreSync(doc);
        if (!preSync && waveOf(doc) > waveOf(owner)) continue;
        const evidence: GateEvidence = { source: "rendered", docIndex: doc.docIndex, kind: doc.kind, name: doc.name, fieldPath, value: name };
        const found = preSync
          ? `${label(doc)} is a PreSync hook and uses Secret "${name}" of ${label(owner)} (wave ${waveOf(owner)}).`
          : `${label(doc)} (wave ${waveOf(doc)}) uses Secret "${name}" of ${label(owner)} (wave ${waveOf(owner)}).`;
        const reason = preSync
          ? `${label(doc)} runs before every sync wave, so the Secret "${name}" of ${label(owner)} does not exist yet; take the hook off PreSync or stop it using that Secret.`
          : `${label(doc)} stands in the same or an earlier sync wave than ${label(owner)}, so its pod starts before the provisioner has written "${name}"; ` +
            `put ${label(owner)} in a wave below ${waveOf(doc)} (${WAVE_ANNOTATION}).`;
        return fail({ id: ID, title: TITLE, severity: SEVERITY, expected: EXPECTED, found, reason, evidence: [evidence] });
      }
    }
    return pass({
      id: ID, title: TITLE, severity: SEVERITY, expected: EXPECTED,
      found: `${claims.size} ServiceClaim Secret(s); ${uses} use(s) by workloads, each in a later wave than its claim.`,
    });
  },
};
