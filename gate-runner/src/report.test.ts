// gate-runner/src/report.test.ts — the report assembly (verdict legs + authored hash + schema belt).
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { assembleReport, sandboxGreen, type ReportInput } from "./report.ts";
import { GateReportSchema, reportHashPayload, type GateResult, type SandboxAttestation } from "../../shared/gates.ts";

const SHA = "a".repeat(40);

function gate(status: "pass" | "fail", severity: "hard" | "soft" = "hard"): GateResult {
  return {
    id: "G1",
    title: "structure",
    severity,
    status,
    expected: "the manifest is present and valid",
    found: status === "pass" ? "present and valid" : "absent",
    reason: status === "pass" ? null : "deploy/platform.yaml is missing",
    detail: "d",
  };
}

const greenSandbox: SandboxAttestation = {
  mustFailTargets: ["https://10.1.1.1:443/"],
  mustFailTargetsConfirmedListening: true,
  mustFailDenied: true,
  controllerAddrDenied: true,
  mustPassReached: true,
};

function input(over: Partial<ReportInput> = {}): ReportInput {
  return {
    runnerVersion: "test",
    repoURL: "https://github.com/x/acme.git",
    requestedRef: "main",
    resolvedSha: SHA,
    startedAt: 1,
    finishedAt: 2,
    manifest: null,
    dependencies: [],
    gates: [gate("pass")],
    sandbox: greenSandbox,
    ...over,
  };
}

describe("assembleReport", () => {
  it("passes when every hard gate passes and the sandbox is green, with a schema-valid 64-hex hash", () => {
    const r = assembleReport(input());
    expect(r.verdict).toBe("pass");
    expect(r.reportHash).toMatch(/^[0-9a-f]{64}$/);
    expect(() => GateReportSchema.parse(r)).not.toThrow();
  });

  it("fails the verdict when any hard gate fails", () => {
    expect(assembleReport(input({ gates: [gate("pass"), gate("fail")] })).verdict).toBe("fail");
  });

  it("fails the verdict when the sandbox is not green even if the gates pass", () => {
    const degraded: SandboxAttestation = { ...greenSandbox, mustFailDenied: false };
    expect(assembleReport(input({ sandbox: degraded })).verdict).toBe("fail");
    expect(sandboxGreen(degraded)).toBe(false);
  });

  it("a soft-gate fail does not fail the verdict", () => {
    expect(assembleReport(input({ gates: [gate("pass"), gate("fail", "soft")] })).verdict).toBe("pass");
  });

  it("authors the hash over the shared canonical payload — the verifier's recomputation matches", () => {
    // The receipt check in the Controller's gate-runner adapter recomputes exactly this digest; a
    // report whose authored hash did not verify against its own body would be refused there.
    const r = assembleReport(input());
    const { reportHash, ...body } = r;
    expect(createHash("sha256").update(reportHashPayload(body)).digest("hex")).toBe(reportHash);
  });
});
