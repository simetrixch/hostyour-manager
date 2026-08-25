// gate-runner/src/report.ts
// Assemble the frozen GateReport (shared/gates.ts) the runner returns and the Manager
// freezes into plan_json. The `verdict` is the runner's leg of the triple lock — every HARD gate
// passed AND the sandbox self-probe attested green; the Manager separately re-checks the
// schema-validates + sandbox legs. `reportHash` is sha256 over the canonical JSON of the report
// with the reportHash field removed — serialized by the shared reportHashPayload, the same
// function the Manager's adapter recomputes the hash with on receipt, so author and verifier
// cannot drift. The final GateReportSchema.parse is a fail-closed belt: the runner never emits a
// report that would fail the Manager's own schema check.
import { createHash } from "node:crypto";
import {
  GateReportSchema,
  hardGatesPass,
  reportHashPayload,
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
  manifest: ConsumerManifest | null; // null <=> G1 failed
  dependencies: ResolvedDependency[];
  gates: GateResult[];
  sandbox: SandboxAttestation;
}

/** Every leg of the sandbox self-probe green — what the runner requires before it trusts its own
 *  fence (a job that reached "done" already passed this, but the verdict re-asserts it). */
export function sandboxGreen(s: SandboxAttestation): boolean {
  return (
    s.mustFailTargetsConfirmedListening && s.mustFailDenied && s.managerAddrDenied && s.mustPassReached
  );
}

/** Build the report, compute its hash over the canonical body, and validate the whole against the
 *  shared schema (fail-closed). Throws if the assembled report is somehow schema-invalid — a runner
 *  bug that must never reach the Manager as a silent partial answer. */
export function assembleReport(input: ReportInput): GateReport {
  const verdict: "pass" | "fail" =
    hardGatesPass(input.gates) && sandboxGreen(input.sandbox) ? "pass" : "fail";
  const body = {
    contractVersion: "1.4" as const,
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
