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

  // THE FAKE'S OWN BEHAVIOUR, and the title says so because no production runner has it. The port
  // allows RUNNER_BUSY and the Tekton adapter never throws it — it submits a PipelineRun and lets the
  // cluster schedule it, so there is no queue there to be full. Scripting it here is what lets the
  // domain be driven through that branch. A title naming a "queue-of-1" is the same false sentence
  // #63 took out of port.ts, and a test title is worse than a comment: it is what somebody greps for.
  it("the scripted runner throws RUNNER_BUSY when a test flips it busy", async () => {
    const r = new FakeGateRunner({ busy: true });
    await expect(r.submit(req())).rejects.toMatchObject({ code: "RUNNER_BUSY", http: 409 });
  });

  // The fake refuses a not-green attestation where the real adapter does — at the report's receipt,
  // in poll. submit() never sees an attestation: the self-probe runs INSIDE the sandbox, so its
  // result exists only once the run has produced a report.
  it("poll throws SANDBOX_DEGRADED when the report's fence self-probe was not green", async () => {
    const degraded = report("fail");
    degraded.sandbox = { ...degraded.sandbox, mustFailDenied: false };
    const r = new FakeGateRunner({ report: degraded });
    const { jobId } = await r.submit(req());
    await expect(r.poll(jobId)).rejects.toMatchObject({ code: "SANDBOX_DEGRADED", http: 503 });
  });

  // The innocent case beside it: the same report with the attestation left green polls through, so a
  // refusal above means the predicate refused rather than that poll refuses everything.
  it("poll returns a report whose fence self-probe was green", async () => {
    const r = new FakeGateRunner({ report: report("fail") });
    const { jobId } = await r.submit(req());
    await expect(r.poll(jobId)).resolves.toMatchObject({ phase: "done" });
  });

  it("poll of an unknown job is NOT_FOUND", async () => {
    const r = new FakeGateRunner();
    await expect(r.poll("job_nope")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
