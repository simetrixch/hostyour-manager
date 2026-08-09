// gate-runner/src/gates/g22.ts
// G22 "database sync ordering" (HARD). Enforces the per-consumer-PostgreSQL contract rule
//: a consumer's own resources must NOT claim a
// sync wave below -10, and no PreSync hook may depend on the database.
//
// WHY this rule exists — the ordering, in plain words:
//  - When a consumer claims `postgresql`, the platform renders the per-consumer database as a fourth
//    source of the consumer's Application, at sync waves -21 (its credential objects) and -20 (the
//    PVC/Deployment/Service/NetworkPolicy), so the database is Healthy before anything the consumer
//    declares. To keep those platform waves strictly below every consumer wave, the consumer contract
//    reserves waves below -10 for the platform: a consumer resource at -11 or lower would interleave
//    with (or run before) the platform's own database objects, breaking the ordering the design rests
//    on. -10 is the floor and is inclusive — the design leaves ten waves of platform headroom below it.
//  - ArgoCD runs PreSync hooks before ALL sync-phase waves, whatever their wave number. So a PreSync
//    hook is NOT covered by the wave floor: a PreSync hook that reads the database credential Secret
//    (`postgresql-credentials`) would run before the database pod at wave -20 even exists, and fail.
//    "No PreSync hook may depend on the database" is therefore a SEPARATE clause of the same rule.
//
// This gate sees ONLY the consumer's own rendered chart (ctx.rendered = `helm template` of the
// consumer chart at chartPath) — the platform's -20/-21 objects are rendered by the appset, not here,
// so policing sync-wave < -10 never false-positives on the platform's own negative waves. For every
// consumer that declares no such wave and no such hook (every consumer today) this gate is a NO-OP.
// Pure + synchronous over the read-only GateContext; ctx.rendered[i].raw is UNTRUSTED, so every nested
// read is typeof/Array.isArray-guarded and a malformed shape can never crash the gate.
import type { CheckGate, GateContext, RenderedDoc } from "./gate.ts";
import type { GateEvidence, GateResult } from "../../../shared/gates.ts";
import { fail, pass } from "./result.ts";

const ID = "G22";
const TITLE = "database sync ordering";
const SEVERITY = "hard" as const;

/** The floor is INCLUSIVE: -10 is allowed, -11 and lower are not. */
const WAVE_FLOOR = -10;
const WAVE_ANNOTATION = "argocd.argoproj.io/sync-wave";
const HOOK_ANNOTATION = "argocd.argoproj.io/hook";
/** The platform-rendered database credential Secret. A PreSync hook
 *  that references it by name is depending on the database — the violation this gate's second clause
 *  catches. (The image-guard's own PreSync hook, which never touches this Secret, is unaffected.) */
const DB_SECRET = "postgresql-credentials";

const EXPECTED =
  `no consumer resource claims a sync wave below ${WAVE_FLOOR} (waves below it are reserved for the ` +
  `platform's per-consumer PostgreSQL objects at -20/-21), and no PreSync hook references the database ` +
  `Secret "${DB_SECRET}" (a PreSync hook runs before the database pod exists)`;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** metadata.annotations as a record, or null when absent/malformed. */
function annotationsOf(doc: RenderedDoc): Record<string, unknown> | null {
  const meta = asRecord(doc.raw.metadata);
  return meta ? asRecord(meta.annotations) : null;
}

/** Parse a sync-wave annotation to an integer, or null when it is not an integer literal. k8s
 *  annotation values are strings ("-3"), but a careless chart can emit an unquoted number that YAML
 *  parses as a number, so both are accepted. A non-integer / non-numeric value is not a floor
 *  violation (null) — this gate rejects only waves that DO parse and sit below the floor. */
function parseWave(value: unknown): number | null {
  if (typeof value === "number") return Number.isInteger(value) ? value : null;
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return parseInt(value.trim(), 10);
  return null;
}

/** The hook phases named by an `argocd.argoproj.io/hook` annotation (comma-separated, e.g.
 *  "PreSync,PostSync"). Empty for a non-string value. */
function hookPhases(value: unknown): string[] {
  return typeof value === "string" ? value.split(",").map((s) => s.trim()) : [];
}

/** True when the rendered doc references the platform database credential Secret by name anywhere in
 *  its body — a secretKeyRef, a volume, an env var, etc. JSON.stringify over the already-parsed,
 *  bounded doc is the simplest total scan; a hostile shape that cannot serialize is treated as "no
 *  reference" (fail-safe for this conjunctive clause, which also requires a PreSync hook). */
function referencesDatabase(raw: Record<string, unknown>): boolean {
  try {
    return JSON.stringify(raw).includes(DB_SECRET);
  } catch {
    return false;
  }
}

interface Violation {
  found: string;
  reason: string;
  evidence: GateEvidence;
}

function evidenceFor(doc: RenderedDoc, fieldPath: string, value: unknown): GateEvidence {
  const v = typeof value === "string" ? value : JSON.stringify(value);
  return { source: "rendered", docIndex: doc.docIndex, kind: doc.kind, name: doc.name, fieldPath, value: (v ?? String(value)).slice(0, 256) };
}

function evaluateDoc(doc: RenderedDoc): Violation | null {
  const annotations = annotationsOf(doc);
  if (!annotations) return null;
  const workload = `${doc.kind}/${doc.name || `#${doc.docIndex}`}`;

  // Clause 1 — the wave floor.
  const wave = parseWave(annotations[WAVE_ANNOTATION]);
  if (wave !== null && wave < WAVE_FLOOR) {
    const fp = `metadata.annotations["${WAVE_ANNOTATION}"]`;
    return {
      found: `${workload} claims sync wave ${wave} (${fp}=${JSON.stringify(annotations[WAVE_ANNOTATION])}), below the -10 floor.`,
      reason:
        `${workload} sets ${WAVE_ANNOTATION} to ${wave}; a consumer resource may not claim a wave below ` +
        `${WAVE_FLOOR}, which is reserved for the platform's per-consumer PostgreSQL objects (waves -20/-21) — ` +
        `a lower consumer wave would interleave with, or run before, the database it depends on.`,
      evidence: evidenceFor(doc, fp, annotations[WAVE_ANNOTATION]),
    };
  }

  // Clause 2 — a PreSync hook that depends on the database.
  if (hookPhases(annotations[HOOK_ANNOTATION]).includes("PreSync") && referencesDatabase(doc.raw)) {
    const fp = `metadata.annotations["${HOOK_ANNOTATION}"]`;
    return {
      found: `${workload} is a PreSync hook (${fp}=${JSON.stringify(annotations[HOOK_ANNOTATION])}) that references the database Secret "${DB_SECRET}".`,
      reason:
        `${workload} is an ${HOOK_ANNOTATION}: PreSync hook that references the database Secret "${DB_SECRET}"; ` +
        `ArgoCD runs PreSync hooks before all sync-phase waves, so this hook would run before the database pod ` +
        `(wave -20) exists and fail — a PreSync hook may not depend on the database.`,
      evidence: evidenceFor(doc, fp, annotations[HOOK_ANNOTATION]),
    };
  }

  return null;
}

export const g22: CheckGate = {
  id: ID,
  title: TITLE,
  severity: SEVERITY,
  check(ctx: GateContext): GateResult {
    let evaluated = 0;
    for (const doc of ctx.rendered) {
      const annotations = annotationsOf(doc);
      if (annotations && (WAVE_ANNOTATION in annotations || HOOK_ANNOTATION in annotations)) evaluated++;
      const v = evaluateDoc(doc);
      if (v) {
        return fail({ id: ID, title: TITLE, severity: SEVERITY, expected: EXPECTED, found: v.found, reason: v.reason, evidence: [v.evidence] });
      }
    }
    const found =
      evaluated === 0
        ? "no rendered document carries a sync-wave or hook annotation, so there is nothing that could violate the database ordering rule."
        : `all ${evaluated} rendered document(s) carrying a sync-wave or hook annotation stay at or above wave ${WAVE_FLOOR} ` +
          `and declare no PreSync hook that depends on the database Secret "${DB_SECRET}".`;
    return pass({ id: ID, title: TITLE, severity: SEVERITY, expected: EXPECTED, found });
  },
};
