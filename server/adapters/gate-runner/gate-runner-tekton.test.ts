import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import { TektonGateRunner, type GateRunCluster, type ReportConfigMap, type TaskRunOutcome, type TektonGateRunnerConfig } from "./gate-runner-tekton.ts";
import type { GateJobRequest } from "./port.ts";
import { reportHashPayload, type GateReport } from "../../../shared/gates.ts";
import { clusterMapPath } from "../../../shared/cluster-values.ts";

const SHA = "a".repeat(40);

// The cluster values chain the Manager reads off the install branch and hands to the sandbox.
const CHAIN = [
  { path: "clusters/platform/values-common.yaml", content: "global:\n  timezone: Europe/Amsterdam\n" },
  { path: "clusters/platform/values-prod.yaml", content: "global:\n  env: prod\n" },
  { path: clusterMapPath("m1.example"), content: "global:\n  endpoints:\n    vault:\n      url: https://vault.m1.example:8200\n" },
];

function report(verdict: "pass" | "fail" = "pass"): GateReport {
  const body = {
    contractVersion: "1.4" as const, runnerVersion: "t", repoURL: "https://github.com/x/y.git", requestedRef: "main",
    resolvedSha: SHA, startedAt: 1, finishedAt: 2, manifest: null,
    dependencies: [], gates: [],
    sandbox: { mustFailTargets: ["c:8080"], mustFailTargetsConfirmedListening: true, mustFailDenied: true, managerAddrDenied: true, mustPassReached: true },
    verdict,
  };
  // The hash the runner's assembleReport authors — poll verifies it on receipt, so the fixture
  // publishes a report whose hash actually verifies.
  return { ...body, reportHash: createHash("sha256").update(reportHashPayload(body)).digest("hex") };
}

function req(over: Partial<GateJobRequest> = {}): GateJobRequest {
  return {
    targetName: "y", stage: "prod", chartPath: "deploy/chart", repoURL: "https://github.com/x/y.git",
    requestedRef: "main", resolvedSha: SHA, clusterValueFiles: CHAIN,
    mustFailTargetsConfirmedListening: true, ...over,
  };
}

/** The incomplete notice the pipeline's publish-report finally task writes under incomplete.json when
 *  the gate task produced no report file. */
function notice(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    incompleteVersion: "1",
    runId: "gr-incomplete",
    reason: "the gate task produced no report file",
    generatedAt: "2026-08-26T09:00:00Z",
    ...over,
  });
}

interface Script {
  outcome: { succeeded: boolean } | null;
  cm: ReportConfigMap;
  /** How the TaskRuns ended, or the error the API answers the list with (an absent RBAC grant). */
  taskRuns: TaskRunOutcome[] | Error;
}

interface Rec { pipelineRuns: unknown[]; secrets: Array<{ name: string; data: Record<string, string> }>; deleted: string[] }
class FakeCluster implements GateRunCluster {
  rec: Rec = { pipelineRuns: [], secrets: [], deleted: [] };
  /** Set by deletePipelineRun. A real reap takes the run's TaskRuns with the PipelineRun, so this
   *  fake refuses to list them afterwards — that is what makes "captured BEFORE the reap" a claim
   *  this suite can actually break rather than an ordering nobody measures. */
  private reaped = false;
  constructor(private script: Script) {}
  createSecret(name: string, data: Record<string, string>): Promise<void> { this.rec.secrets.push({ name, data }); return Promise.resolve(); }
  createPipelineRun(body: unknown): Promise<void> { this.rec.pipelineRuns.push(body); return Promise.resolve(); }
  pipelineRunOutcome(): Promise<{ succeeded: boolean } | null> { return Promise.resolve(this.script.outcome); }
  readReportConfigMap(): Promise<ReportConfigMap> { return Promise.resolve(this.script.cm); }
  listTaskRunOutcomes(): Promise<TaskRunOutcome[]> {
    if (this.reaped) return Promise.reject(new Error("the TaskRuns went with the PipelineRun"));
    return this.script.taskRuns instanceof Error ? Promise.reject(this.script.taskRuns) : Promise.resolve(this.script.taskRuns);
  }
  deletePipelineRun(n: string): Promise<void> { this.reaped = true; this.rec.deleted.push(`pr:${n}`); return Promise.resolve(); }
  deleteConfigMap(n: string): Promise<void> { this.rec.deleted.push(`cm:${n}`); return Promise.resolve(); }
  deleteSecret(n: string): Promise<void> { this.rec.deleted.push(`sec:${n}`); return Promise.resolve(); }
  // The orphan-sweep listing seam: nothing standing in this scripted namespace.
  listPipelineRunNames(): Promise<string[]> { return Promise.resolve([]); }
  listSecretNames(): Promise<string[]> { return Promise.resolve([]); }
  listConfigMapNames(): Promise<string[]> { return Promise.resolve([]); }
}

/** The three TaskRuns a gate-run has, ended the way apps3 measured them: the gate step was OOM-killed
 *  before it could write a report, and the finally task still published. */
const OOM_TASKRUNS: TaskRunOutcome[] = [
  { pipelineTaskName: "clone", succeeded: true, reason: "Succeeded", message: "All Steps have completed executing" },
  { pipelineTaskName: "gate", succeeded: false, reason: "Failed", message: `"step-gate" exited with code 137 (OOMKilled)` },
  { pipelineTaskName: "publish-report", succeeded: true, reason: "Succeeded", message: "All Steps have completed executing" },
];

function cfg(openCredential: (id: string) => Promise<Buffer> = () => Promise.resolve(Buffer.from("tok"))): TektonGateRunnerConfig {
  // No kubeconfigPath: it is only the dev/test file OVERRIDE — absent means in-cluster (the pod
  // SA), and these tests inject a FakeCluster anyway, so the config must typecheck without it.
  return {
    namespace: "gate-runner", pipelineName: "gate-run", serviceAccount: "pipeline-sa",
    reportWriterServiceAccount: "gate-report-writer", podFsGroup: 1000,
    workspaceStorage: "1Gi", runnerVersion: "0.1.0", kubeVersion: "1.30.0", jobBudgetMs: 480000,
    fence: { mustFailTargets: ["10.1.1.1:443"], managerAddr: "10.152.183.5:8080", mustPassTarget: "github.com:443" },
    openCredential,
  };
}

describe("TektonGateRunner", () => {
  it("submit: dispatches a PipelineRun for a PUBLIC repo with an EMPTY credential secret", async () => {
    const c = new FakeCluster({ outcome: null, cm: { state: "absent" }, taskRuns: [] });
    const r = new TektonGateRunner(cfg(), c, () => "gate-run-fixed");
    const { jobId } = await r.submit(req());
    expect(jobId).toBe("gate-run-fixed");
    // A uniform per-run Secret is always created; for a public repo GITCREDENTIALS is empty (anon clone).
    expect(c.rec.secrets).toEqual([{ name: "gate-cred-gate-run-fixed", data: { GITCREDENTIALS: "" } }]);
    expect(c.rec.pipelineRuns).toHaveLength(1);
    const body = JSON.stringify(c.rec.pipelineRuns[0]);
    expect(body).toContain(SHA); // git-revision param = the pinned SHA
    expect(body).toContain("gate-run"); // pipelineRef
    expect(body).toContain('"confirmed-listening"');
    // publish-report MUST be pinned to the token-holding gate-report-writer SA (else its kubectl
    // falls back to localhost:8080 and no report ConfigMap is ever written), and every pod needs
    // fsGroup 1000 so the non-root gate step can write the root-cloned workspace.
    const spec = (c.rec.pipelineRuns[0] as { spec: Record<string, unknown> }).spec;
    expect(spec.taskRunSpecs).toEqual([{ pipelineTaskName: "publish-report", serviceAccountName: "gate-report-writer" }]);
    expect(spec.taskRunTemplate).toEqual({ serviceAccountName: "pipeline-sa" });
    expect(spec.podTemplate).toEqual({ securityContext: { fsGroup: 1000 } });
  });

  it("submit: hands the cluster values chain to the pipeline VERBATIM, as the cluster-value-files param", async () => {
    const c = new FakeCluster({ outcome: null, cm: { state: "absent" }, taskRuns: [] });
    await new TektonGateRunner(cfg(), c, () => "gate-run-fixed").submit(req());
    const params = ((c.rec.pipelineRuns[0] as { spec: { params: { name: string; value: string }[] } }).spec).params;
    const chain = params.find((p) => p.name === "cluster-value-files")!;
    // The three files' own bytes, in layering order — the gate renders these, not a summary of them.
    expect(JSON.parse(chain.value)).toEqual(CHAIN);
  });

  it("submit: fills the credential Secret with a git-credentials line for a PRIVATE repo", async () => {
    const opened: string[] = [];
    const c = new FakeCluster({ outcome: null, cm: { state: "absent" }, taskRuns: [] });
    const r = new TektonGateRunner(cfg((id) => { opened.push(id); return Promise.resolve(Buffer.from("pat")); }), c, () => "gr1");
    await r.submit(req({ repoCredentialId: "cred_9" }));
    expect(opened).toEqual(["cred_9"]);
    expect(c.rec.secrets[0]?.name).toBe("gate-cred-gr1");
    // GITCREDENTIALS is a credential-store line the git-clone Task envFroms: x-access-token:<pat>@<host>.
    expect(c.rec.secrets[0]?.data.GITCREDENTIALS).toBe("https://x-access-token:pat@github.com");
  });

  it("poll: RUNNING (no Succeeded condition yet) reports phase gating with no report", async () => {
    const c = new FakeCluster({ outcome: null, cm: { state: "absent" }, taskRuns: [] });
    const r = new TektonGateRunner(cfg(), c, () => "gr2");
    const p = await r.poll("gr2");
    expect(p.phase).toBe("gating");
    expect(p.report).toBeUndefined();
  });

  it("poll: DONE reads the published report, returns it, and reaps the run objects", async () => {
    const c = new FakeCluster({ outcome: { succeeded: true }, cm: { state: "report", json: JSON.stringify(report("pass")) }, taskRuns: OOM_TASKRUNS });
    const r = new TektonGateRunner(cfg(), c, () => "gr3");
    const p = await r.poll("gr3");
    expect(p.phase).toBe("done");
    expect(p.report?.verdict).toBe("pass");
    expect(c.rec.deleted).toEqual(expect.arrayContaining(["pr:gr3", "cm:gate-report-gr3", "sec:gate-cred-gr3"]));
  });

  it("poll: DONE but NO report ConfigMap published names the gate-run as incomplete (never a hang)", async () => {
    const c = new FakeCluster({ outcome: { succeeded: false }, cm: { state: "absent" }, taskRuns: OOM_TASKRUNS });
    const r = new TektonGateRunner(cfg(), c, () => "gr4");
    const rejected = r.poll("gr4");
    // GATE_INCOMPLETE, not UPSTREAM: no report exists, so nothing was judged about the repository —
    // the answer an agent working in the CONSUMER's repo must be able to tell from a failed gate.
    await expect(rejected).rejects.toMatchObject({ code: "GATE_INCOMPLETE" });
    // ...and even here the TaskRun statuses ride along, which is the whole cause of the failure.
    await expect(rejected).rejects.toThrow(/OOMKilled/);
  });

  it("poll: a ConfigMap carrying incomplete.json raises the gate-did-not-complete failure with its reason, NOT a schema complaint", async () => {
    // Measured on apps3 (2026-08-26): the gate task died, publish-report wrote a synthetic object,
    // and the operator got thirteen zod violations about GateReportSchema and never learned the gate
    // had died. The incomplete key is never parsed as a report, so none of that text can appear.
    const c = new FakeCluster({
      outcome: { succeeded: false },
      cm: { state: "incomplete", json: notice({ reason: "gate task produced no report file (killed before it wrote one)" }) },
      taskRuns: OOM_TASKRUNS,
    });
    const rejected = new TektonGateRunner(cfg(), c, () => "gr6").poll("gr6");
    await expect(rejected).rejects.toMatchObject({ code: "GATE_INCOMPLETE" });
    await expect(rejected).rejects.toThrow(/gate task produced no report file \(killed before it wrote one\)/);
    await expect(rejected).rejects.not.toThrow(/contractVersion|reportHash|sandbox/);
    // The reap still runs — the credential Secret must never outlive a run, incomplete or not.
    expect(c.rec.deleted).toEqual(expect.arrayContaining(["pr:gr6", "cm:gate-report-gr6", "sec:gate-cred-gr6"]));
  });

  it("poll: the TaskRun statuses are captured BEFORE the reap destroys them", async () => {
    // The fake refuses to list TaskRuns once deletePipelineRun has run, exactly as the cluster does.
    // Capture after the reap and this goes red on the evidence line, with the reap still recorded.
    const c = new FakeCluster({ outcome: { succeeded: false }, cm: { state: "incomplete", json: notice() }, taskRuns: OOM_TASKRUNS });
    const rejected = new TektonGateRunner(cfg(), c, () => "gr7").poll("gr7");
    await expect(rejected).rejects.toThrow(/gate: FAILED — Failed: "step-gate" exited with code 137 \(OOMKilled\)/);
    await expect(rejected).rejects.not.toThrow(/could NOT be read/);
    expect(c.rec.deleted).toEqual(expect.arrayContaining(["pr:gr7", "cm:gate-report-gr7", "sec:gate-cred-gr7"]));
  });

  it("poll: TaskRun statuses that cannot be read say so, and are never reported as nothing having failed", async () => {
    // The Manager's Role in the gate-run namespace has to grant list on tekton.dev/taskruns. Without
    // it the API answers 403, and an empty evidence list would read as "no task failed".
    const c = new FakeCluster({
      outcome: { succeeded: false },
      cm: { state: "incomplete", json: notice() },
      taskRuns: new Error(`taskruns.tekton.dev is forbidden: User "system:serviceaccount:manager:manager" cannot list resource "taskruns"`),
    });
    const rejected = new TektonGateRunner(cfg(), c, () => "gr8").poll("gr8");
    await expect(rejected).rejects.toMatchObject({ code: "GATE_INCOMPLETE" });
    await expect(rejected).rejects.toThrow(/could NOT be read.*cannot list resource "taskruns"/s);
    await expect(rejected).rejects.not.toThrow(/no task of the pipeline ever started/);
  });

  it("poll: a ConfigMap carrying NEITHER key is its own case and names what it does carry", async () => {
    const c = new FakeCluster({
      outcome: { succeeded: true },
      cm: { state: "unrecognized", keys: ["gate-report.json", "notes.txt"] },
      taskRuns: OOM_TASKRUNS,
    });
    const rejected = new TektonGateRunner(cfg(), c, () => "gr9").poll("gr9");
    await expect(rejected).rejects.toMatchObject({ code: "GATE_INCOMPLETE" });
    await expect(rejected).rejects.toThrow(/neither report.json nor incomplete.json/);
    await expect(rejected).rejects.toThrow(/gate-report.json, notes.txt/);
  });

  it("poll: an incomplete notice that misses the rest of the shape STILL delivers its reason, and says the shape did not hold", async () => {
    // A runner writing a shape this Manager does not know must not cost the operator the one sentence
    // the notice exists to carry.
    const c = new FakeCluster({
      outcome: { succeeded: false },
      cm: { state: "incomplete", json: JSON.stringify({ reason: "the gate image never pulled" }) },
      taskRuns: OOM_TASKRUNS,
    });
    const rejected = new TektonGateRunner(cfg(), c, () => "gr10").poll("gr10");
    await expect(rejected).rejects.toMatchObject({ code: "GATE_INCOMPLETE" });
    await expect(rejected).rejects.toThrow(/the gate image never pulled/);
    await expect(rejected).rejects.toThrow(/does not hold IncompleteGateRunSchema/);
  });

  it("reapOrphans: reaps the whole triple for every jobId ANY surviving object names, and touches nothing foreign", async () => {
    // Three orphans, each witnessed by a DIFFERENT survivor: a PipelineRun alone, a PAT-bearing
    // credential Secret whose PipelineRun is already gone (a crash inside a reap), and a report
    // ConfigMap alone — the sweep must find the jobId behind each and delete all three objects of it.
    class LeftoverCluster extends FakeCluster {
      override listPipelineRunNames(): Promise<string[]> { return Promise.resolve(["gate-run-aa"]); }
      override listSecretNames(): Promise<string[]> { return Promise.resolve(["gate-cred-gate-run-bb", "unrelated-secret"]); }
      override listConfigMapNames(): Promise<string[]> { return Promise.resolve(["gate-report-gate-run-cc", "kube-root-ca.crt"]); }
    }
    const c = new LeftoverCluster({ outcome: null, cm: { state: "absent" }, taskRuns: [] });
    const { reaped } = await new TektonGateRunner(cfg(), c).reapOrphans();
    expect(reaped).toBe(3);
    for (const id of ["gate-run-aa", "gate-run-bb", "gate-run-cc"]) {
      expect(c.rec.deleted).toEqual(expect.arrayContaining([`pr:${id}`, `cm:gate-report-${id}`, `sec:gate-cred-${id}`]));
    }
    expect(c.rec.deleted.join(",")).not.toMatch(/unrelated-secret|kube-root-ca/);
  });

  it("poll: a schema-valid report whose reportHash does not verify against its body is refused", async () => {
    // The receipt belt: the hash is recomputed over the canonical published body. A report rewritten
    // in the ConfigMap without recomputing the hash — an all-pass body pasted over the runner's, a
    // truncated field — must never reach the plan as a verdict.
    const forged = { ...report("pass"), reportHash: "0".repeat(64) };
    const c = new FakeCluster({ outcome: { succeeded: true }, cm: { state: "report", json: JSON.stringify(forged) }, taskRuns: OOM_TASKRUNS });
    const rejected = new TektonGateRunner(cfg(), c, () => "gr5").poll("gr5");
    await expect(rejected).rejects.toMatchObject({ code: "UPSTREAM" });
    await expect(rejected).rejects.toThrow(/reportHash does not verify/);
  });
});
