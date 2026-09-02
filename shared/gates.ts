// The gate-runner report contract. Kept in shared/ so the
// runner (which authors the sandbox gates G1/G2/G3/G6/G7/G8/G22 and, when its own fence did not
// hold, the refusal row G25), the Manager (which authors the manager-side gates
// G16/G17/G18/G19/G23/G24, the refusal row G26, and composes the report), and the web card all
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
    id: z.string().regex(/^[GT][0-9]{1,2}$/), // consumer "G1"…"G26" / tenant "T1"…"T4" (same shape)
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

/** The sandbox self-probe attestation frozen into the report: what the runner MEASURED about its own
 *  egress fence from inside, before the job ran — plus the one leg nobody measured.
 *
 *  THREE OF THE FOUR LEGS ARE PROBES the runner made itself. The fourth,
 *  `mustFailTargetsDeclaredListening`, is the Manager's WORD and no probe stands behind it: the
 *  wiring states it as a constant. Spelling it `…ConfirmedListening` would claim a
 *  measurement, and the difference is the whole of what a denied connect is worth — a target nothing
 *  proved was listening is a target the sandbox may simply have been unable to reach, and a fence
 *  that was never tested then reports as held. Measured on an installation whose `lan_host` answer
 *  carried ANOTHER machine's address: the must-fail target was that other machine's API
 *  server, the Manager could reach it over the public internet perfectly well and would have
 *  declared it listening, while the sandbox's own vantage is a different one entirely.
 *
 *  WHICH VANTAGE SHOULD MEASURE IT is open and belongs to whoever owns the fence contract. What is
 *  settled is that the record may not present the declaration as a confirmation — see
 *  `sandboxProvenance`, which is what a run log says about it on a GREEN run. */
export const SandboxAttestationSchema = z.object({
  mustFailTargets: z.array(z.string()), // rendered from config, never guessed
  mustFailTargetsDeclaredListening: z.boolean(), // the Manager's WORD — nothing measured it
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
  // release-images.yml) and one bump writes both pins — but a pin rolled back by hand can pair a new
  // Manager with an old runner, and this line is what turns that into a named refusal at the first
  // gate-run instead of a field silently read as undefined. Bump it whenever a field is added,
  // removed or renamed here.
  contractVersion: z.literal("1.5"),
  runnerVersion: z.string(),
  repoURL: z.string(),
  requestedRef: z.string(),
  resolvedSha: z.string().regex(/^[0-9a-f]{40}$/),
  startedAt: z.number(),
  finishedAt: z.number(),
  // Non-null IFF the structure gate ran AND passed. Null therefore covers TWO states, and reading it
  // as one of them is how a report from a run that never started was read as a repository whose
  // manifest declares nothing: the structure gate ran and failed (its own row in `gates` says why),
  // or NO gate ran at all (then `gates` carries the runner's refusal row and no check gate).
  // Whichever it is, `gates` is where the answer stands — never this field alone.
  manifest: ConsumerManifestSchema.nullable(),
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

/** What an onboard run carries INSTEAD of a report when NO gate ran at all — the one onboarding the
 *  product owner has exempted, the platform's own unit at the first installation in the master role.
 *
 *  IT IS NOT A REPORT AND MUST NEVER BE READ AS ONE, for the same reason IncompleteGateRun is not:
 *  a GateReport carries a sandbox attestation and a reportHash, and filling those in here would
 *  attest to a fence nothing observed and hash a report that does not exist. A pass that no check
 *  could have produced is the shape LAW 0 forbids outright, so the exempted run says NOT GATED
 *  rather than saying pass.
 *
 *  `admittedBy` carries EVERY condition that had to hold, in words, and not a boolean. This is the
 *  one branch in the system that skips the gate: whoever reads the run afterwards must be able to
 *  see exactly what admitted it without going to the source, and a list that ever grows shorter is
 *  visible in the record itself.
 *
 *  `ungatedVersion` is a plain string and NOT a literal, for IncompleteGateRun's reason: a record
 *  this Manager does not know must still deliver what it says. */
export const UngatedOnboardSchema = z.object({
  ungatedVersion: z.string(),
  unit: z.string(),
  cluster: z.string(),
  resolvedSha: z.string().regex(/^[0-9a-f]{40}$/),
  /** The build names read straight from the manifest, since no sandbox read them here. */
  builds: z.array(z.string()),
  /** Every condition that admitted this onboarding past the gate, one sentence each. */
  admittedBy: z.array(z.string()).min(1),
  generatedAt: z.string(), // RFC3339 UTC
});
export type UngatedOnboard = z.infer<typeof UngatedOnboardSchema>;

/** The verdict's hard-gate leg: it passes only if
 *  every HARD gate passed. Callers still enforce the other two legs (schema-validates + the
 *  sandbox attestation) before treating a report as a pass. */
export function hardGatesPass(gates: GateResult[]): boolean {
  return gates.every((g) => g.severity !== "hard" || g.status === "pass");
}

/** The gate whose subject is the PLATFORM's own sandbox rather than the repository under validation.
 *
 *  IT LIVES HERE BECAUSE BOTH SIDES NAME IT. The runner writes this row instead of its gates when
 *  its egress self-probe was not green; the Manager's refusal reads it back out of the report so the
 *  operator is told WHICH sandbox gates therefore did not run. Two constants would put that pairing
 *  one edit away from coming apart, with nothing reporting it until a run inside a broken fence —
 *  which is the one moment nobody is in a position to notice a missing line. */
export const SANDBOX_FENCE_GATE_ID = "G25";

/** Every gate id a report can carry that is about the sandbox and not about the repository.
 *
 *  One entry today. It is a LIST because the reader on the Manager's side filters by membership, and
 *  a second platform-side row added later has to reach that reader without anybody remembering to
 *  widen a comparison. */
export const SANDBOX_SIDE_GATE_IDS: readonly string[] = [SANDBOX_FENCE_GATE_ID];

/** The verdict's SANDBOX leg: every probe of the fence self-attestation answered the way a holding
 *  fence answers. It lives HERE, beside hardGatesPass, because two separate images read it — the
 *  runner before it renders untrusted content, and the Manager when the report arrives — and a
 *  second copy would let "the fence held" come to mean two different things on the two sides. */
export function sandboxGreen(s: SandboxAttestation): boolean {
  return (
    s.mustFailTargetsDeclaredListening && s.mustFailDenied && s.managerAddrDenied && s.mustPassReached
  );
}

/** WHAT THE FENCE PROOF RESTS ON, as one line a run log carries on a GREEN run.
 *
 *  `sandboxFailures` is the red path and says nothing when everything holds — so a run that passed
 *  left no record at all of the fact that one of the four legs is nobody's measurement. This is that
 *  record: it names the three the runner probed from inside the sandbox and the one the Manager
 *  merely declared, so whoever reads the receipt can see which part rests on somebody's word.
 *
 *  It is written for the case where everything held. A leg that did NOT hold is stated by
 *  `sandboxFailures`, in that leg's own sentence, and is not repeated here. */
export function sandboxProvenance(s: SandboxAttestation): string {
  const probed = "measured by the runner from inside the sandbox: the must-fail targets denied, the Manager's own address denied, the one allowed egress reached";
  const declared = s.mustFailTargets.length > 0 ? s.mustFailTargets.join(", ") : "(none configured)";
  return (
    `the sandbox fence — three legs ${probed}; ONE leg measured by nobody: that ${declared} ` +
    "was listening is the Manager's declaration, so a denied connect to it proves the fence held " +
    "against a target no probe put there"
  );
}

/** Which legs of the attestation did NOT hold, one full sentence each, in the order sandboxGreen
 *  reads them. Empty exactly when sandboxGreen is true. Both refusals print this list — the runner's
 *  own gate row and the Manager's refusal at receipt — so the same booleans cannot be described two
 *  different ways.
 *
 *  mustFailDenied is an AGGREGATE over the target list: a false says not every target was denied and
 *  cannot say WHICH one answered, so the sentence names the list that was probed and claims nothing
 *  more than the boolean carries. */
export function sandboxFailures(s: SandboxAttestation): string[] {
  const out: string[] = [];
  if (!s.mustFailTargetsDeclaredListening) {
    out.push(
      "the Manager did not declare that the must-fail probe targets were listening, so a blocked connect here would prove nothing about the fence",
    );
  }
  if (!s.mustFailDenied) {
    out.push(
      s.mustFailTargets.length > 0
        ? `not every must-fail target was denied — the sandbox reached at least one of the targets it probed (${s.mustFailTargets.join(", ")})`
        : "no must-fail target was configured at all, so nothing was proven blocked",
    );
  }
  if (!s.managerAddrDenied) {
    out.push("the Manager's own address was not denied — the sandbox can reach the Manager");
  }
  if (!s.mustPassReached) {
    out.push(
      "the must-pass target was not reached, so this probe cannot tell a fence that blocks from a probe that cannot connect at all",
    );
  }
  return out;
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
