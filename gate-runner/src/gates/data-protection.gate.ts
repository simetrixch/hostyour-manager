// gate-runner/src/gates/data-protection.gate.ts
// G6 "data protection" (hard). Every STANDALONE PersistentVolumeClaim that helm renders must be
// fenced against Argo prune/delete, or a resync could wipe a consumer's data. A PVC is fenced when
// its metadata.annotations["argocd.argoproj.io/sync-options"] carries BOTH "Prune=false" and
// "Delete=false". A StatefulSet's spec.volumeClaimTemplates are NOT standalone PVCs —
// Argo does not own those objects, so they are exempt (we only note their presence). Zero PVCs
// passes. `raw` is untrusted parsed YAML, so every nested read is typeof/Array.isArray-guarded.
import type { CheckGate, GateContext, RenderedDoc } from "./gate.ts";
import type { GateEvidence, GateResult } from "../../../shared/gates.ts";
import { fail, pass } from "./result.ts";

const ANNOTATION_KEY = "argocd.argoproj.io/sync-options";
const REQUIRED = ["Prune=false", "Delete=false"] as const;
const EVIDENCE_VALUE_MAX = 256;

/** A plain object or null — used to walk untrusted `raw` without ever assuming shape. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** The verbatim sync-options string, or null if metadata/annotations/key is absent or not a string. */
function syncOptions(doc: RenderedDoc): string | null {
  const meta = asRecord(doc.raw.metadata);
  const annotations = meta ? asRecord(meta.annotations) : null;
  const raw = annotations ? annotations[ANNOTATION_KEY] : undefined;
  return typeof raw === "string" ? raw : null;
}

interface PvcOffense {
  doc: RenderedDoc;
  problem: string; // observed-fact phrasing, e.g. `has no argocd.argoproj.io/sync-options annotation`
  value: string | null; // the annotation value if present (for evidence), else null
}

/** Evaluate one standalone PVC; returns null when it is properly fenced, else the offense. */
function evaluatePvc(doc: RenderedDoc): PvcOffense | null {
  const value = syncOptions(doc);
  if (value === null) {
    return { doc, problem: `has no ${ANNOTATION_KEY} annotation`, value: null };
  }
  const missing = REQUIRED.filter((token) => !value.includes(token));
  if (missing.length > 0) {
    return { doc, problem: `has ${ANNOTATION_KEY}="${value}" but is missing ${missing.join(" and ")}`, value };
  }
  return null;
}

/** True when a StatefulSet declares a non-empty spec.volumeClaimTemplates array (Argo-exempt). */
function hasVolumeClaimTemplates(doc: RenderedDoc): boolean {
  const spec = asRecord(doc.raw.spec);
  const templates = spec ? spec.volumeClaimTemplates : undefined;
  return Array.isArray(templates) && templates.length > 0;
}

function label(doc: RenderedDoc): string {
  return `PersistentVolumeClaim "${doc.name}"`;
}

/** Trailing clause describing Argo-exempt StatefulSet volume templates, or "" when there are none. */
function stsNote(templated: readonly RenderedDoc[]): string {
  if (templated.length === 0) return "";
  const names = templated.map((d) => `"${d.name}"`).join(", ");
  return ` ${templated.length} StatefulSet volumeClaimTemplates(s) (${names}) are Argo-unmanaged and exempt from the guard.`;
}

export const dataProtectionGate: CheckGate = {
  id: "G6",
  title: "data protection",
  severity: "hard",
  check(ctx: GateContext): GateResult {
    const expected =
      "every rendered PVC carries argocd.argoproj.io/sync-options with Prune=false,Delete=false.";

    const pvcs = ctx.rendered.filter((d) => d.kind === "PersistentVolumeClaim");
    const templated = ctx.rendered.filter((d) => d.kind === "StatefulSet" && hasVolumeClaimTemplates(d));
    const note = stsNote(templated);

    if (pvcs.length === 0) {
      return pass({
        id: this.id,
        title: this.title,
        severity: this.severity,
        expected,
        found: `No standalone PersistentVolumeClaim documents were rendered, so there is nothing to fence.${note}`,
      });
    }

    const offenses = pvcs.map(evaluatePvc).filter((o): o is PvcOffense => o !== null);

    if (offenses.length === 0) {
      return pass({
        id: this.id,
        title: this.title,
        severity: this.severity,
        expected,
        found:
          `All ${pvcs.length} rendered PersistentVolumeClaim(s) carry ${ANNOTATION_KEY} with ` +
          `Prune=false and Delete=false.${note}`,
      });
    }

    const summaries = offenses.map((o) => `${label(o.doc)} ${o.problem}`).join("; ");
    const evidence: GateEvidence[] = offenses.slice(0, 20).map((o) => ({
      source: "rendered",
      docIndex: o.doc.docIndex,
      kind: "PersistentVolumeClaim",
      name: o.doc.name,
      fieldPath: `metadata.annotations.${ANNOTATION_KEY}`,
      ...(o.value !== null ? { value: o.value.slice(0, EVIDENCE_VALUE_MAX) } : {}),
    }));

    return fail({
      id: this.id,
      title: this.title,
      severity: this.severity,
      expected,
      found: `${offenses.length} of ${pvcs.length} rendered PersistentVolumeClaim(s) lack the required guard: ${summaries}.${note}`,
      reason:
        `${summaries}; without both Prune=false and Delete=false in ${ANNOTATION_KEY}, Argo would ` +
        `prune/delete the claim (and its data) on the next sync.`,
      evidence,
    });
  },
};
