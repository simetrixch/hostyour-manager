import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import { TektonGateRunner, type GateRunCluster, type TektonGateRunnerConfig } from "./gate-runner-tekton.ts";
import type { GateJobRequest } from "./port.ts";
import { reportHashPayload, type GateReport } from "../../../shared/gates.ts";

const SHA = "a".repeat(40);

// The cluster values chain the Manager reads off the install branch and hands to the sandbox.
const CHAIN = [
  { path: "platform/values-common.yaml", content: "global:\n  timezone: Europe/Amsterdam\n" },
  { path: "platform/values-prod.yaml", content: "global:\n  env: prod\n" },
  { path: "installation/profile.yaml", content: "global:\n  endpoints:\n    vault:\n      url: https://vault.m1.example:8200\n" },
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

interface Rec { pipelineRuns: unknown[]; secrets: Array<{ name: string; data: Record<string, string> }>; deleted: string[] }
class FakeCluster implements GateRunCluster {
  rec: Rec = { pipelineRuns: [], secrets: [], deleted: [] };
  constructor(private script: { outcome: { succeeded: boolean } | null; report: string | null }) {}
  createSecret(name: string, data: Record<string, string>): Promise<void> { this.rec.secrets.push({ name, data }); return Promise.resolve(); }
  createPipelineRun(body: unknown): Promise<void> { this.rec.pipelineRuns.push(body); return Promise.resolve(); }
  pipelineRunOutcome(): Promise<{ succeeded: boolean } | null> { return Promise.resolve(this.script.outcome); }
  readReport(): Promise<string | null> { return Promise.resolve(this.script.report); }
  deletePipelineRun(n: string): Promise<void> { this.rec.deleted.push(`pr:${n}`); return Promise.resolve(); }
  deleteConfigMap(n: string): Promise<void> { this.rec.deleted.push(`cm:${n}`); return Promise.resolve(); }
  deleteSecret(n: string): Promise<void> { this.rec.deleted.push(`sec:${n}`); return Promise.resolve(); }
  // The orphan-sweep listing seam: nothing standing in this scripted namespace.
  listPipelineRunNames(): Promise<string[]> { return Promise.resolve([]); }
  listSecretNames(): Promise<string[]> { return Promise.resolve([]); }
  listConfigMapNames(): Promise<string[]> { return Promise.resolve([]); }
}

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
    const c = new FakeCluster({ outcome: null, report: null });
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
    const c = new FakeCluster({ outcome: null, report: null });
    await new TektonGateRunner(cfg(), c, () => "gate-run-fixed").submit(req());
    const params = ((c.rec.pipelineRuns[0] as { spec: { params: { name: string; value: string }[] } }).spec).params;
    const chain = params.find((p) => p.name === "cluster-value-files")!;
    // The three files' own bytes, in layering order — the gate renders these, not a summary of them.
    expect(JSON.parse(chain.value)).toEqual(CHAIN);
  });

  it("submit: fills the credential Secret with a git-credentials line for a PRIVATE repo", async () => {
    const opened: string[] = [];
    const c = new FakeCluster({ outcome: null, report: null });
    const r = new TektonGateRunner(cfg((id) => { opened.push(id); return Promise.resolve(Buffer.from("pat")); }), c, () => "gr1");
    await r.submit(req({ repoCredentialId: "cred_9" }));
    expect(opened).toEqual(["cred_9"]);
    expect(c.rec.secrets[0]?.name).toBe("gate-cred-gr1");
    // GITCREDENTIALS is a credential-store line the git-clone Task envFroms: x-access-token:<pat>@<host>.
    expect(c.rec.secrets[0]?.data.GITCREDENTIALS).toBe("https://x-access-token:pat@github.com");
  });

  it("poll: RUNNING (no Succeeded condition yet) reports phase gating with no report", async () => {
    const c = new FakeCluster({ outcome: null, report: null });
    const r = new TektonGateRunner(cfg(), c, () => "gr2");
    const p = await r.poll("gr2");
    expect(p.phase).toBe("gating");
    expect(p.report).toBeUndefined();
  });

  it("poll: DONE reads the published report, returns it, and reaps the run objects", async () => {
    const c = new FakeCluster({ outcome: { succeeded: true }, report: JSON.stringify(report("pass")) });
    const r = new TektonGateRunner(cfg(), c, () => "gr3");
    const p = await r.poll("gr3");
    expect(p.phase).toBe("done");
    expect(p.report?.verdict).toBe("pass");
    expect(c.rec.deleted).toEqual(expect.arrayContaining(["pr:gr3", "cm:gate-report-gr3", "sec:gate-cred-gr3"]));
  });

  it("poll: DONE but NO report published is an upstream failure (never a hang)", async () => {
    const c = new FakeCluster({ outcome: { succeeded: false }, report: null });
    const r = new TektonGateRunner(cfg(), c, () => "gr4");
    await expect(r.poll("gr4")).rejects.toMatchObject({ code: "UPSTREAM" });
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
    const c = new LeftoverCluster({ outcome: null, report: null });
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
    const c = new FakeCluster({ outcome: { succeeded: true }, report: JSON.stringify(forged) });
    const rejected = new TektonGateRunner(cfg(), c, () => "gr5").poll("gr5");
    await expect(rejected).rejects.toMatchObject({ code: "UPSTREAM" });
    await expect(rejected).rejects.toThrow(/reportHash does not verify/);
  });
});
