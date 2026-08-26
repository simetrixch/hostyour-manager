import { describe, it, expect } from "vitest";
import { FakeGateRunner } from "./testing/fake.ts";
import type { GateReport } from "../../../shared/gates.ts";
import type { GateJobRequest } from "./port.ts";
import { clusterMapPath } from "../../../shared/cluster-values.ts";

function report(verdict: "pass" | "fail" = "pass"): GateReport {
  return {
    contractVersion: "1.4",
    runnerVersion: "test",
    repoURL: "https://github.com/x/y.git",
    requestedRef: "main",
    resolvedSha: "0".repeat(40),
    startedAt: 1,
    finishedAt: 2,
    manifest: null,
    dependencies: [],
    gates: [],
    sandbox: { mustFailTargets: [], mustFailTargetsConfirmedListening: true, mustFailDenied: true, managerAddrDenied: true, mustPassReached: true },
    verdict,
    reportHash: "h",
  };
}

function req(): GateJobRequest {
  return {
    targetName: "y",
    stage: "prod",
    chartPath: "deploy/chart",
    repoURL: "https://github.com/x/y.git",
    requestedRef: "main",
    resolvedSha: "0".repeat(40),
    clusterValueFiles: [{ path: clusterMapPath("m1.example"), content: "global:\n  endpoints:\n    vault:\n      url: https://v:8200\n" }],
    mustFailTargetsConfirmedListening: true,
  };
}

describe("FakeGateRunner", () => {
  it("submits a job and returns the scripted report on poll", async () => {
    const r = new FakeGateRunner({ report: report("pass") });
    const { jobId } = await r.submit(req());
    const p = await r.poll(jobId);
    expect(p.phase).toBe("done");
    expect(p.report?.verdict).toBe("pass");
    // The submitted request pins the SHA and carries NO credential for a public repo — the pipeline
    // clones at the pinned SHA; a token reaches the gate pod only for a private repo (repoCredentialId).
    expect(r.submitted).toHaveLength(1);
    expect(r.submitted[0]).not.toHaveProperty("repoCredentialId");
    expect(r.submitted[0]?.resolvedSha).toHaveLength(40);
  });

  it("throws RUNNER_BUSY when the queue-of-1 is busy", async () => {
    const r = new FakeGateRunner({ busy: true });
    await expect(r.submit(req())).rejects.toMatchObject({ code: "RUNNER_BUSY", http: 409 });
  });

  it("throws SANDBOX_DEGRADED when the fence self-probe was not green", async () => {
    const r = new FakeGateRunner({ degraded: true });
    await expect(r.submit(req())).rejects.toMatchObject({ code: "SANDBOX_DEGRADED", http: 503 });
  });

  it("poll of an unknown job is NOT_FOUND", async () => {
    const r = new FakeGateRunner();
    await expect(r.poll("job_nope")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
