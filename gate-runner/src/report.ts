// gate-runner/src/report.ts
// Assemble the frozen GateReport (shared/gates.ts) the runner returns and the Manager
// freezes into plan_json. The `verdict` is the runner's leg of the triple lock — every HARD gate
// passed AND the sandbox self-probe attested green. The Manager re-checks the other two legs where
// the report crosses into it — the schema and the reportHash in the gate-runner adapter's poll, and
// the sandbox attestation on the same line, through the shared sandboxGreen this file's verdict uses,
// so neither side can come to mean something different by a fence that held.
// `reportHash` is sha256 over the canonical JSON of the report
// with the reportHash field removed — serialized by the shared reportHashPayload, the same
// function the Manager's adapter recomputes the hash with on receipt, so author and verifier
// cannot drift. The final GateReportSchema.parse is a fail-closed belt: the runner never emits a
// report that would fail the Manager's own schema check.
import { createHash } from "node:crypto";
import {
  GateReportSchema,
  hardGatesPass,
  reportHashPayload,
  sandboxGreen,
  type GateReport,
  type GateResult,
  type SandboxAttestation,
  type ResolvedDependency,
} from "../../shared/gates.ts";
import type { ConsumerManifest } from "../../shared/consumer.ts";

export interface ReportInput {
  runnerVersion: string;
  repoURL: string;
  requestedRef: string;
  resolvedSha: string;
  startedAt: number;
  finishedAt: number;
  /** What the sandbox parsed out of the repository's manifest, or null where nothing parsed it.
   *
   *  NULL IS NO LONGER ONE EVENT. It was "G1 failed" and that sentence is what the report schema
   *  used to carry too, one file away in shared/gates.ts, until 7ede920 corrected it there: the
   *  fence-refusal path fills this field with null WITHOUT G1 having run at all, and the two are
   *  told apart by the rows in `gates` — a G1 row that failed is the repository's answer, a G25 row
   *  is the platform's. A reader that took null for "G1 failed" would go looking in a repository
   *  nothing opened. */
  manifest: ConsumerManifest | null;
  dependencies: ResolvedDependency[];
  gates: GateResult[];
  sandbox: SandboxAttestation;
}

/** Build the report, compute its hash over the canonical body, and validate the whole against the
 *  shared schema (fail-closed). Throws if the assembled report is somehow schema-invalid — a runner
 *  bug that must never reach the Manager as a silent partial answer. */
export function assembleReport(input: ReportInput): GateReport {
  const verdict: "pass" | "fail" =
    hardGatesPass(input.gates) && sandboxGreen(input.sandbox) ? "pass" : "fail";
  const body = {
    contractVersion: "1.5" as const,
    runnerVersion: input.runnerVersion,
    repoURL: input.repoURL,
    requestedRef: input.requestedRef,
    resolvedSha: input.resolvedSha,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    manifest: input.manifest,
    dependencies: input.dependencies,
    gates: input.gates,
    sandbox: input.sandbox,
    verdict,
  };
  const reportHash = createHash("sha256").update(reportHashPayload(body)).digest("hex");
  return GateReportSchema.parse({ ...body, reportHash });
}
