import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import { TektonGateRunner, type GateRunCluster, type PipelineRunOwner, type ReportConfigMap, type TaskRunOutcome, type TektonGateRunnerConfig } from "./gate-runner-tekton.ts";
import type { GateJobRequest } from "./port.ts";
import { reportHashPayload, SANDBOX_FENCE_GATE_ID, type GateReport } from "../../../shared/gates.ts";
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
    contractVersion: "1.5" as const, runnerVersion: "t", repoURL: "https://github.com/x/y.git", requestedRef: "main",
    resolvedSha: SHA, startedAt: 1, finishedAt: 2, manifest: null,
    dependencies: [], gates: [],
    sandbox: { mustFailTargets: ["c:8080"], mustFailTargetsDeclaredListening: true, mustFailDenied: true, managerAddrDenied: true, mustPassReached: true },
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
    mustFailTargetsDeclaredListening: true, ...over,
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

interface Rec {
  pipelineRuns: unknown[];
  secrets: Array<{ name: string; data: Record<string, string>; owner: PipelineRunOwner }>;
  deleted: string[];
  /** Every create and delete in the order it was asked for. submit's order and reap's order are both
   *  load-bearing - the orphan sweep reads a single PipelineRun list and relies on nothing being
   *  able to stand without a run beside it - so the order is recorded rather than inferred. */
  order: string[];
}
class FakeCluster implements GateRunCluster {
  rec: Rec = { pipelineRuns: [], secrets: [], deleted: [], order: [] };
  /** Set by deletePipelineRun. A real reap takes the run's TaskRuns with the PipelineRun, so this
   *  fake refuses to list them afterwards — that is what makes "captured BEFORE the reap" a claim
   *  this suite can actually break rather than an ordering nobody measures. */
  private reaped = false;
  constructor(private script: Script) {}
  createSecret(name: string, data: Record<string, string>, owner: PipelineRunOwner): Promise<void> {
    this.rec.secrets.push({ name, data, owner });
    this.rec.order.push(`+sec:${name}`);
    return Promise.resolve();
  }
  createPipelineRun(body: unknown): Promise<PipelineRunOwner> {
    this.rec.pipelineRuns.push(body);
    const name = (body as { metadata?: { name?: string } }).metadata?.name ?? "unnamed";
    this.rec.order.push(`+pr:${name}`);
    return Promise.resolve({ name, uid: `uid-${name}` });
  }
  pipelineRunOutcome(): Promise<{ succeeded: boolean } | null> { return Promise.resolve(this.script.outcome); }
  readReportConfigMap(): Promise<ReportConfigMap> { return Promise.resolve(this.script.cm); }
  listTaskRunOutcomes(): Promise<TaskRunOutcome[]> {
    if (this.reaped) return Promise.reject(new Error("the TaskRuns went with the PipelineRun"));
    return this.script.taskRuns instanceof Error ? Promise.reject(this.script.taskRuns) : Promise.resolve(this.script.taskRuns);
  }
  deletePipelineRun(n: string): Promise<void> { this.reaped = true; this.rec.deleted.push(`pr:${n}`); this.rec.order.push(`-pr:${n}`); return Promise.resolve(); }
  deleteConfigMap(n: string): Promise<void> { this.rec.deleted.push(`cm:${n}`); this.rec.order.push(`-cm:${n}`); return Promise.resolve(); }
  deleteSecret(n: string): Promise<void> { this.rec.deleted.push(`sec:${n}`); this.rec.order.push(`-sec:${n}`); return Promise.resolve(); }
  /** The orphan sweep's ONE listing seam. Whatever stands here is what the sweep can see: there is
   *  no Secret or ConfigMap listing to fall back on, by design. */
  runNames: string[] = [];
  listPipelineRunNames(): Promise<string[]> { return Promise.resolve(this.runNames); }
}

/** The three TaskRuns a gate-run has, ended the way a real installation measured them: the gate step was OOM-killed
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
    // A uniform per-run Secret is always created; for a public repo GITCREDENTIALS is empty (anon
    // clone). It is a child of the run either way — a public run's Secret is as much a leftover as
    // a private one's if nothing collects it.
    expect(c.rec.secrets).toEqual([
      { name: "gate-cred-gate-run-fixed", data: { GITCREDENTIALS: "" }, owner: { name: "gate-run-fixed", uid: "uid-gate-run-fixed" } },
    ]);
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

  it("submit: still declares chart-path for a BUILD-ONLY unit, carrying the empty string for the absence", async () => {
    const c = new FakeCluster({ outcome: null, cm: { state: "absent" }, taskRuns: [] });
    const { chartPath: _none, ...buildOnly } = req();
    await new TektonGateRunner(cfg(), c, () => "gate-run-fixed").submit(buildOnly);
    const params = ((c.rec.pipelineRuns[0] as { spec: { params: { name: string; value: string }[] } }).spec).params;
    // The Tekton param is a declared string with no default, so a PipelineRun that leaves it out is
    // rejected by the API before any task starts. The param must be there and it must be empty — the
    // CLI reads an empty chart-path back as "this unit ships no chart", never as a missing input.
    const chartPath = params.find((p) => p.name === "chart-path");
    expect(chartPath).toBeDefined();
    expect(chartPath!.value).toBe("");
    // The innocent case beside it, so an empty value cannot mean the param was never filled at all.
    const c2 = new FakeCluster({ outcome: null, cm: { state: "absent" }, taskRuns: [] });
    await new TektonGateRunner(cfg(), c2, () => "gate-run-fixed").submit(req());
    const withChart = ((c2.rec.pipelineRuns[0] as { spec: { params: { name: string; value: string }[] } }).spec).params;
    expect(withChart.find((p) => p.name === "chart-path")!.value).toBe("deploy/chart");
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
    // Measured on a real installation: the gate task died, publish-report wrote a synthetic object,
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

  it("reapOrphans: reaps the whole triple of every surviving PipelineRun, off the run listing alone", async () => {
    // The sweep's ONLY input is the PipelineRun listing. It is enough because nothing else can
    // stand without a run: submit creates the run first, and reap deletes it last. What it must do
    // for each surviving run is delete all three objects of it — above all the PAT-bearing
    // credential Secret, which no TTL and no pruner would ever remove.
    const c = new FakeCluster({ outcome: null, cm: { state: "absent" }, taskRuns: [] });
    c.runNames = ["gate-run-aa", "gate-run-bb"];
    const { reaped } = await new TektonGateRunner(cfg(), c).reapOrphans();
    expect(reaped).toBe(2);
    for (const id of c.runNames) {
      expect(c.rec.deleted).toEqual(expect.arrayContaining([`pr:${id}`, `cm:gate-report-${id}`, `sec:gate-cred-${id}`]));
    }
  });

  it("submit: the PipelineRun is created BEFORE its credential Secret, and the Secret is its child", async () => {
    // This ordering is what lets the sweep read one listing instead of enumerating Secrets — and
    // enumerating Secrets means reading their values, a PAT among them. A Secret created first
    // would, until the run existed, name nothing and be named by nothing.
    const c = new FakeCluster({ outcome: null, cm: { state: "absent" }, taskRuns: [] });
    const { jobId } = await new TektonGateRunner(cfg(), c, () => "gr-order").submit(req({ repoCredentialId: "cred-1" }));
    expect(c.rec.order).toEqual([`+pr:${jobId}`, `+sec:gate-cred-${jobId}`]);
    expect(c.rec.secrets[0]?.owner).toEqual({ name: jobId, uid: `uid-${jobId}` });
  });

  it("submit: a credential Secret that cannot be created takes the PipelineRun back down with it", async () => {
    // The run is dispatched first, so the compensation runs the other way round than the order
    // suggests: what is already standing when the second call fails is the run.
    class NoSecret extends FakeCluster {
      override createSecret(): Promise<void> { return Promise.reject(new Error("secrets is forbidden")); }
    }
    const c = new NoSecret({ outcome: null, cm: { state: "absent" }, taskRuns: [] });
    const rejected = new TektonGateRunner(cfg(), c, () => "gr-comp").submit(req());
    await expect(rejected).rejects.toThrow(/could not create the gate-run credential Secret/);
    expect(c.rec.deleted).toContain("pr:gr-comp");
  });

  it("reap: the PipelineRun is deleted AFTER its Secret and its report ConfigMap", async () => {
    // The run is the handle the sweep has on a triple. A reap that died halfway must leave the run
    // standing, so the next boot finds the triple whole; deleting the run first would leave either
    // of the other two behind with nothing naming them.
    const c = new FakeCluster({ outcome: { succeeded: true }, cm: { state: "report", json: JSON.stringify(report("pass")) }, taskRuns: OOM_TASKRUNS });
    await new TektonGateRunner(cfg(), c, () => "gr-reap").poll("gr-reap");
    expect(c.rec.order.at(-1)).toBe("-pr:gr-reap");
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

  // THE SANDBOX LEG, enforced on the same line as the schema and the hash. Measured on a real
  // installation: a report attesting that the node's own API server and the Manager were both reachable
  // from inside the gate pod was accepted and composed into a verdict — the attestation was a field
  // and not a fence. Each leg is planted on its own, so a refusal cannot rest on one of them alone.
  const LEGS = ["mustFailTargetsDeclaredListening", "mustFailDenied", "managerAddrDenied", "mustPassReached"] as const;
  for (const leg of LEGS) {
    it(`poll: a report whose sandbox attestation says ${leg} did not hold is refused, and the refusal is not a gate verdict`, async () => {
      const green = report("pass");
      const body = { ...green, sandbox: { ...green.sandbox, [leg]: false } };
      const { reportHash: _drop, ...rest } = body;
      const degraded = { ...rest, reportHash: createHash("sha256").update(reportHashPayload(rest)).digest("hex") };
      const c = new FakeCluster({ outcome: { succeeded: true }, cm: { state: "report", json: JSON.stringify(degraded) }, taskRuns: OOM_TASKRUNS });
      const rejected = new TektonGateRunner(cfg(), c, () => "gr6").poll("gr6");
      // SANDBOX_DEGRADED, never GATE_INCOMPLETE and never a verdict: the fence protects the cluster
      // FROM the repository, so its failure is the platform's and the operator must not be sent to
      // the repository under validation to fix it.
      await expect(rejected).rejects.toMatchObject({ code: "SANDBOX_DEGRADED", http: 503 });
    });
  }

  // WHAT THE OPERATOR IS LEFT HOLDING. The refusal ends the run before anything writes
  // runs.plan_json and the report ConfigMap is already reaped, so the G25 row the runner authored —
  // the one row that names which sandbox gates therefore did not run — reaches a person only if this
  // message carries it. A check asserting the throw alone passes with that row dropped, which is how
  // it went missing.
  it("poll: the refusal carries the runner's own fence row, naming the gates that did not run", async () => {
    const green = report("pass");
    const refused = {
      ...green,
      verdict: "fail" as const,
      manifest: null,
      gates: [
        {
          id: SANDBOX_FENCE_GATE_ID,
          title: "sandbox fence",
          severity: "hard" as const,
          status: "fail" as const,
          expected: "the fence holds before any gate reads the repository",
          found: "The sandbox fence did not hold: the Manager's own address was reachable. G1, G2, G3 did not run — no gate has read this repository.",
          reason: "a fault in the platform's own validation sandbox",
          evidence: [],
          detail: "the sandbox fence did not hold — no gate ran",
        },
      ],
      sandbox: { ...green.sandbox, managerAddrDenied: false },
    };
    const { reportHash: _drop, ...rest } = refused;
    const body = { ...rest, reportHash: createHash("sha256").update(reportHashPayload(rest)).digest("hex") };
    const c = new FakeCluster({ outcome: { succeeded: true }, cm: { state: "report", json: JSON.stringify(body) }, taskRuns: OOM_TASKRUNS });

    const rejected = new TektonGateRunner(cfg(), c, () => "gr8").poll("gr8");

    await expect(rejected).rejects.toMatchObject({ code: "SANDBOX_DEGRADED" });
    const message = await rejected.catch((e: { message: string }) => e.message);
    expect(message).toContain("G1, G2, G3 did not run");
    expect(message).toContain("G25 sandbox fence");
  });

  it("poll: a refusal on a report carrying no fence row says the row is missing, rather than nothing", async () => {
    // A runner older than the row that says which gates were skipped writes gates: [] — the shape a
    // refused run leaves. The refusal must state that the report does not say, instead of falling silent
    // and reading as a refusal with nothing behind it.
    const green = report("pass");
    const silent = { ...green, verdict: "fail" as const, manifest: null, gates: [], sandbox: { ...green.sandbox, mustFailDenied: false } };
    const { reportHash: _drop, ...rest } = silent;
    const body = { ...rest, reportHash: createHash("sha256").update(reportHashPayload(rest)).digest("hex") };
    const c = new FakeCluster({ outcome: { succeeded: true }, cm: { state: "report", json: JSON.stringify(body) }, taskRuns: OOM_TASKRUNS });

    const message = await new TektonGateRunner(cfg(), c, () => "gr9").poll("gr9").catch((e: { message: string }) => e.message);

    expect(message).toContain("no sandbox-side row of its own");
    expect(message).toContain("no gates at all");
  });

  it("poll: INNOCENT CASE — the same report with every leg of the attestation green is accepted", async () => {
    const c = new FakeCluster({ outcome: { succeeded: true }, cm: { state: "report", json: JSON.stringify(report("pass")) }, taskRuns: OOM_TASKRUNS });
    const p = await new TektonGateRunner(cfg(), c, () => "gr7").poll("gr7");
    expect(p.phase).toBe("done");
    expect(p.report?.verdict).toBe("pass");
  });
});
