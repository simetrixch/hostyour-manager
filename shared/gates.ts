// The gate-runner report contract. Kept in shared/ so the
// runner (which authors the sandbox gates G1/G2/G3/G6/G7/G8/G22), the Manager (which authors the
// manager-side gates G16/G17/G18/G19/G23 and composes the report), and the web card all
// agree on one shape. zod-backed; the inferred types are the single source of truth.
//
// every gate states, in full sentences, what was EXPECTED, what was FOUND, and — on a
// non-pass — WHY that is a rejection, so a rejection never requires reading gate source code.
import { z } from "zod";
import { ConsumerManifestSchema } from "./consumer.ts";

/** Whether a `fail` blocks. `hard` = the plan is rejected; `soft` = a warning that rides along. */
export type GateSeverity = "hard" | "soft";

/** One concrete observation behind `found` — a place the operator can jump to. */
export const GateEvidenceSchema = z.object({
  source: z.enum(["repo", "rendered", "runner", "manager"]),
  file: z.string().optional(), // path inside the clone, e.g. "deploy/chart/templates/svc.yaml"
  docIndex: z.number().int().optional(), // rendered YAML document index (source == "rendered")
  kind: z.string().optional(), // e.g. "Service"
  name: z.string().optional(), // e.g. "acme-web"
  fieldPath: z.string().optional(), // e.g. "spec.type"
  value: z.string().max(256).optional(), // the observed value; runner-truncated at 256 chars
});
export type GateEvidence = z.infer<typeof GateEvidenceSchema>;

// Caps are part of the triple lock's "report schema-validates" leg: a failing gate
// physically cannot omit its reason, and a hostile chart cannot push a report over the caps
// (the runner truncates at collection time; these are the manager-side belt).
const TEXT_MAX = 2000;

/** One gate's result. The collapsed subset {id,title,severity,status,detail,hint} matches
 *  PreflightCheck, so both render through the same collapsed row; expected/found/reason/
 *  evidence are the superset. The fail-closed refinement: reason is null IFF status is
 *  "pass". Each gate authors its own expected/found/reason in the function that runs the check,
 *  so the text and the predicate cannot drift. */
export const GateResultSchema = z
  .object({
    id: z.string().regex(/^[GT][0-9]{1,2}$/), // consumer "G1"…"G23" / tenant "T1"…"T4" (same shape)
    title: z.string(),
    severity: z.enum(["hard", "soft"]),
    status: z.enum(["pass", "warn", "fail"]),
    // always present, including on pass:
    expected: z.string().max(TEXT_MAX), // the rule as one checkable sentence + its contract anchor
    found: z.string().max(TEXT_MAX), // observed facts only, no judgment
    reason: z.string().max(TEXT_MAX).nullable(), // null iff status == "pass"
    evidence: z.array(GateEvidenceSchema).max(20).optional(),
    // kept from the spec shape (collapsed-row rendering, PreflightCheck parity):
    detail: z.string(),
    hint: z.string().optional(),
  })
  .refine((g) => (g.status === "pass") === (g.reason === null), {
    message: "reason must be null when (and only when) status is pass",
    path: ["reason"],
  });
export type GateResult = z.infer<typeof GateResultSchema>;

/** The sandbox self-probe attestation frozen into the report:
 *  the fence was proven live against confirmed-listening targets before the job ran. */
export const SandboxAttestationSchema = z.object({
  mustFailTargets: z.array(z.string()), // rendered from config, never guessed
  mustFailTargetsConfirmedListening: z.boolean(), // the Manager's attestation, echoed
  mustFailDenied: z.boolean(), // the runner observed its own connects blocked
  managerAddrDenied: z.boolean(), // the second must-fail probe (the Manager's own address)
  mustPassReached: z.boolean(),
});
export type SandboxAttestation = z.infer<typeof SandboxAttestationSchema>;

/** A resolved chart dependency, frozen so revalidate-at-pin can re-assert it. */
export const ResolvedDependencySchema = z.object({
  name: z.string(),
  version: z.string(),
  digest: z.string(),
});
export type ResolvedDependency = z.infer<typeof ResolvedDependencySchema>;

/** The full validation report, frozen into runs.plan_json and streamed gate-by-gate. */
export const GateReportSchema = z.object({
  // A LITERAL, so a report written against any other version of this shape is REFUSED rather than
  // read half-right: the runner writes it and the Manager parses it, and the two are separate
  // images. They cannot normally drift — one release tag builds both (.github/workflows/
  // seed-images.yml) and one bump writes both pins — but a pin rolled back by hand can pair a new
  // Manager with an old runner, and this line is what turns that into a named refusal at the first
  // gate-run instead of a field silently read as undefined. Bump it whenever a field is added,
  // removed or renamed here.
  contractVersion: z.literal("1.4"),
  runnerVersion: z.string(),
  repoURL: z.string(),
  requestedRef: z.string(),
  resolvedSha: z.string().regex(/^[0-9a-f]{40}$/),
  startedAt: z.number(),
  finishedAt: z.number(),
  manifest: ConsumerManifestSchema.nullable(), // null <=> G1 failed
  dependencies: z.array(ResolvedDependencySchema),
  gates: z.array(GateResultSchema),
  sandbox: SandboxAttestationSchema,
  verdict: z.enum(["pass", "fail"]),
  reportHash: z.string(), // sha256 over the canonical JSON minus this field
});
export type GateReport = z.infer<typeof GateReportSchema>;

/** What the report ConfigMap carries INSTEAD of a report when the gate task produced no report file
 *  (an internal error, an OOM kill, an image that never pulled). The pipeline's `publish-report`
 *  finally task writes it under the key `incomplete.json`; a real report rides `report.json`, and
 *  the ConfigMap carries EXACTLY ONE of the two.
 *
 *  It is NOT a variant of a report and must never be read as one. A GateReport carries a sandbox
 *  attestation and a reportHash; a publish step that filled those in would be attesting to a fence
 *  it never observed and hashing a report that does not exist.
 *
 *  It carries NO contractVersion, and the separate KEY is what makes that safe. GateReportSchema's
 *  contractVersion is a literal so a report written against another version is refused rather than
 *  read half-right, and that guard must not be weakened; this object sidesteps it instead, because
 *  the Manager asks for `report.json` and that key's absence is not a malformed report — it is not a
 *  report at all.
 *
 *  `incompleteVersion` is a plain string and NOT a literal. A version this Manager does not know
 *  must still deliver its `reason`: refusing the one message that explains why the gate produced
 *  nothing would put the operator back in front of a failure that says nothing, which is the whole
 *  defect this object exists to end. */
export const IncompleteGateRunSchema = z.object({
  incompleteVersion: z.string(),
  runId: z.string(),
  reason: z.string(), // one plain sentence saying the gate task produced no report file
  generatedAt: z.string(), // RFC3339 UTC
});
export type IncompleteGateRun = z.infer<typeof IncompleteGateRunSchema>;

/** The verdict's hard-gate leg: it passes only if
 *  every HARD gate passed. Callers still enforce the other two legs (schema-validates + the
 *  sandbox attestation) before treating a report as a pass. */
export function hardGatesPass(gates: GateResult[]): boolean {
  return gates.every((g) => g.severity !== "hard" || g.status === "pass");
}

/** Recursively key-sorted structure — a stable serialization so the same report always serializes
 *  the same regardless of property insertion order. Arrays keep their order: the gate sequence is
 *  part of the report, so re-sorting it would change what the digest attests. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort()) out[key] = canonicalize(src[key]);
    return out;
  }
  return value;
}

/** The exact string the reportHash digests: the canonical JSON of a report body — the report WITHOUT
 *  its reportHash field. Lives beside the schema so the author (the runner's assembleReport, the
 *  tenant composeTenantReport) and the verifier (the Manager's gate-runner adapter, on receipt)
 *  serialize identically and cannot drift. The sha256 itself stays out of shared/ — this module is
 *  isomorphic (the web bundle imports it), so no node:crypto; each side digests this string. */
export function reportHashPayload(body: unknown): string {
  return JSON.stringify(canonicalize(body));
}
