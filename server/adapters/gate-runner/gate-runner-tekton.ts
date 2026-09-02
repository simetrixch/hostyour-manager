// The Tekton gate-runner (redesigned) — the Manager's concrete GateRunner. It
// dispatches an in-cluster `gate-run` Tekton PipelineRun in the locked-down, egress-fenced `gate-runner`
// namespace and reads the frozen GateReport back from the ConfigMap the run's publish step writes. This
// REPLACES the host-podman-Quadlet HTTP runner: no host, no loopback, no manual bring-up — the fence is
// a Calico NetworkPolicy and the sandbox is an ephemeral, token-less pod. The pipeline clones the repo
// itself at the pinned SHA (github is the one egress the fence allows); a private repo's read credential
// rides as a short-lived Secret this adapter creates + reaps.
//
// That ConfigMap carries exactly ONE of two keys, and which key it is is the whole discriminator:
// `report.json` is a GateReport, `incomplete.json` says the gate task produced no report file. The
// second is never parsed as the first (shared/gates.ts IncompleteGateRunSchema says why).
//
// POLL IS WHERE THE REPORT CROSSES INTO THE MANAGER, and all three things that must hold about a
// report rather than about the repository are held there, on consecutive lines: it parses against
// GateReportSchema, its body hashes to its own reportHash, and its sandbox attestation is green.
// None of the three refusals is a gate verdict, and each says so in its own words — the reader they
// reach works in the repository under validation, and not one of these is that repository's fault.
import { createHash } from "node:crypto";
import { KubeConfig, CoreV1Api, CustomObjectsApi, ApiException } from "@kubernetes/client-node";
import { GateReportSchema, IncompleteGateRunSchema, reportHashPayload, sandboxFailures, sandboxGreen, SANDBOX_SIDE_GATE_IDS, type GateReport } from "../../../shared/gates.ts";
import type { GateRunner, GateJobRequest, GateJobProgress } from "./port.ts";
import { AppError, errGateIncomplete, errSandboxDegraded } from "../../kernel/errors.ts";

const TEKTON = { group: "tekton.dev", version: "v1", plural: "pipelineruns" } as const;
const TEKTON_TASKRUNS = { group: "tekton.dev", version: "v1", plural: "taskruns" } as const;

/** Tekton stamps both on every TaskRun it creates for a PipelineRun: the first joins a TaskRun back
 *  to its run, the second names the task inside the pipeline ("clone", "gate", "publish-report"). */
const PIPELINE_RUN_LABEL = "tekton.dev/pipelineRun";
const PIPELINE_TASK_LABEL = "tekton.dev/pipelineTask";

/** Stamped on every dispatched PipelineRun (pipelineRunBody) and matched again by the orphan
 *  sweep's list — one definition, so the sweep can never miss what submit stamps. */
const MANAGED_BY_KEY = "app.kubernetes.io/managed-by";
const MANAGED_BY_VALUE = "hostyour-manager";

/** ApiException carries an HTTP `.code`; treat a 404 as "absent" so reaping is idempotent. */
function statusCode(e: unknown): number | undefined {
  if (e instanceof ApiException) return e.code;
  const c = (e as { statusCode?: number; code?: number } | null)?.statusCode ?? (e as { code?: number } | null)?.code;
  return typeof c === "number" ? c : undefined;
}
function isNotFound(e: unknown): boolean {
  return statusCode(e) === 404;
}
function upstream(msg: string): AppError {
  return new AppError("UPSTREAM", `gate-runner (tekton): ${msg}`);
}

/** What the run's report ConfigMap was found to carry. The `publish-report` finally task writes
 *  EXACTLY ONE of two keys and WHICH key it is decides the case — no shared shape, so nothing has to
 *  be parsed before it is known which of the two arrived. The other two states are the ConfigMap not
 *  being there at all and it standing with neither key on it. */
export type ReportConfigMap =
  | { state: "report"; json: string } // data["report.json"] — a real GateReport
  | { state: "incomplete"; json: string } // data["incomplete.json"] — the gate task produced no report file
  | { state: "unrecognized"; keys: string[] } // the ConfigMap stands, carrying neither key
  | { state: "absent" }; // no report ConfigMap at all

/** One TaskRun's ending, read off its Succeeded condition. `succeeded` is null while the condition
 *  still reads Unknown — a task that never settled, which is a different fact from one that failed. */
export interface TaskRunOutcome {
  pipelineTaskName: string;
  succeeded: boolean | null;
  reason: string; // Tekton's condition reason, e.g. "Failed", "TaskRunImagePullFailed"
  message: string; // Tekton's condition message, e.g. `"step-gate" exited with code 137`
}

/** What poll captured about a run's TaskRuns before the reap took them. `read: false` is NOT "nothing
 *  failed": it says the statuses could not be read at all, and an operator has to be told which of
 *  the two they are looking at. */
export type TaskRunEvidence = { read: true; taskRuns: TaskRunOutcome[] } | { read: false; why: string };

/** The narrow cluster seam the runner needs — a fake in tests, KubeGateRunCluster in production. Every
 *  op targets the ONE gate-run namespace on the control cluster. */
export interface GateRunCluster {
  createSecret(name: string, data: Record<string, string>): Promise<void>;
  createPipelineRun(body: unknown): Promise<void>;
  /** null while the PipelineRun is still running; {succeeded} once its Succeeded condition settles. */
  pipelineRunOutcome(name: string): Promise<{ succeeded: boolean } | null>;
  /** What the report ConfigMap carries, by key — the ConfigMap's absence included. */
  readReportConfigMap(cmName: string): Promise<ReportConfigMap>;
  /** How each of a PipelineRun's TaskRuns ended. This is the ONLY place the cause of a gate task
   *  that died before writing a report exists, and deleting the PipelineRun deletes its TaskRuns
   *  with it, so poll reads this BEFORE the reap. */
  listTaskRunOutcomes(pipelineRunName: string): Promise<TaskRunOutcome[]>;
  deletePipelineRun(name: string): Promise<void>;
  deleteConfigMap(name: string): Promise<void>;
  deleteSecret(name: string): Promise<void>;
  /** The names of every Manager-dispatched PipelineRun standing in the namespace (the impl
   *  filters by the managed-by label pipelineRunBody stamps). Orphan-sweep input. */
  listPipelineRunNames(): Promise<string[]>;
  /** Every Secret name in the namespace — the sweep keeps only the gate-cred-* it owns. */
  listSecretNames(): Promise<string[]>;
  /** Every ConfigMap name in the namespace — the sweep keeps only the gate-report-* it owns. */
  listConfigMapNames(): Promise<string[]>;
}

export interface TektonGateRunnerConfig {
  /** OPTIONAL kubeconfig-file override (dev/test). Absent ⇒ the pod ServiceAccount's in-cluster
   *  credentials (the production mode) — the gate-run ns lives on the master with the Manager. */
  kubeconfigPath?: string;
  namespace: string; // "gate-runner"
  pipelineName: string; // "gate-run"
  serviceAccount: string; // the pipeline SA ("pipeline-sa"), no cluster writes
  /** The SA the `publish-report` finally task runs under — the ONLY pod in the sandbox holding an
   *  API token (gate-report-writer, apps/gate-runner rbac.yaml). Bound per-task via the PipelineRun's
   *  taskRunSpecs; a Pipeline cannot pin a per-task SA. Without this override publish-report inherits
   *  the token-less pipeline-sa, so its kubectl finds no in-cluster credential and falls back to
   *  http://localhost:8080 — the report ConfigMap is never written and the Manager sees
   *  "no report ConfigMap". */
  reportWriterServiceAccount: string; // "gate-report-writer"
  /** fsGroup stamped on every gate-run pod. The clone step (alpine/git) writes the shared workspace
   *  as root; this mount-time group makes it group-writable so the non-root gate step (runAsUser ==
   *  this value) can create the report file the pipeline hands back. Matches the gate-runner chart's
   *  gate.runAsUser. */
  podFsGroup: number; // 1000
  workspaceStorage: string; // the clone workspace PVC size, e.g. "1Gi"
  runnerVersion: string;
  kubeVersion: string; // e.g. "1.30.0" — the kubeconform target
  jobBudgetMs: number;
  /** The egress-fence self-probe targets the CLI proves from inside (fail-closed). */
  fence: { mustFailTargets: string[]; managerAddr: string; mustPassTarget: string };
  /** Opens a sealed private-repo read credential (git-over-HTTPS token) by id. */
  openCredential: (id: string) => Promise<Buffer>;
}

const credSecretName = (runId: string): string => `gate-cred-${runId}`;
const reportCmName = (runId: string): string => `gate-report-${runId}`;

/** The production cluster seam over @kubernetes/client-node, bound to the gate-run namespace. */
export class KubeGateRunCluster implements GateRunCluster {
  private readonly core: CoreV1Api;
  private readonly custom: CustomObjectsApi;
  constructor(
    private readonly namespace: string,
    kubeconfigPath?: string,
  ) {
    const kc = new KubeConfig();
    // EXPLICIT dispatch (mirrors kube.ts buildKubeConfig, never loadFromDefault): a set path is the
    // dev/test file override; absent ⇒ the pod ServiceAccount's in-cluster credentials — the
    // production mode since the Vault-mounted kubeconfig file was retired.
    if (kubeconfigPath !== undefined) kc.loadFromFile(kubeconfigPath);
    else kc.loadFromCluster();
    this.core = kc.makeApiClient(CoreV1Api);
    this.custom = kc.makeApiClient(CustomObjectsApi);
  }

  async createSecret(name: string, data: Record<string, string>): Promise<void> {
    await this.core.createNamespacedSecret({
      namespace: this.namespace,
      body: { metadata: { name, namespace: this.namespace }, type: "Opaque", stringData: data },
    });
  }

  async createPipelineRun(body: unknown): Promise<void> {
    await this.custom.createNamespacedCustomObject({ ...TEKTON, namespace: this.namespace, body: body as object });
  }

  async pipelineRunOutcome(name: string): Promise<{ succeeded: boolean } | null> {
    const raw = (await this.custom.getNamespacedCustomObject({ ...TEKTON, namespace: this.namespace, name })) as {
      status?: { conditions?: Array<{ type?: string; status?: string }> };
    };
    const cond = (raw.status?.conditions ?? []).find((c) => c.type === "Succeeded");
    if (!cond || cond.status === undefined || cond.status === "Unknown") return null; // still running
    return { succeeded: cond.status === "True" };
  }

  async readReportConfigMap(cmName: string): Promise<ReportConfigMap> {
    let data: Record<string, string>;
    try {
      const cm = (await this.core.readNamespacedConfigMap({ name: cmName, namespace: this.namespace })) as {
        data?: Record<string, string>;
      };
      data = cm.data ?? {};
    } catch (e) {
      if (isNotFound(e)) return { state: "absent" };
      throw e;
    }
    const report = data["report.json"];
    if (report !== undefined) return { state: "report", json: report };
    const incomplete = data["incomplete.json"];
    if (incomplete !== undefined) return { state: "incomplete", json: incomplete };
    return { state: "unrecognized", keys: Object.keys(data) };
  }

  async listTaskRunOutcomes(pipelineRunName: string): Promise<TaskRunOutcome[]> {
    const raw = (await this.custom.listNamespacedCustomObject({
      ...TEKTON_TASKRUNS,
      namespace: this.namespace,
      labelSelector: `${PIPELINE_RUN_LABEL}=${pipelineRunName}`,
    })) as {
      items?: Array<{
        metadata?: { name?: string; labels?: Record<string, string> };
        status?: { conditions?: Array<{ type?: string; status?: string; reason?: string; message?: string }> };
      }>;
    };
    return (raw.items ?? []).map((tr) => {
      const cond = (tr.status?.conditions ?? []).find((c) => c.type === "Succeeded");
      return {
        pipelineTaskName: tr.metadata?.labels?.[PIPELINE_TASK_LABEL] ?? tr.metadata?.name ?? "(unnamed TaskRun)",
        succeeded: cond?.status === "True" ? true : cond?.status === "False" ? false : null,
        reason: cond?.reason ?? "",
        message: cond?.message ?? "",
      };
    });
  }

  async deletePipelineRun(name: string): Promise<void> {
    await this.custom.deleteNamespacedCustomObject({ ...TEKTON, namespace: this.namespace, name }).catch((e) => {
      if (!isNotFound(e)) throw e;
    });
  }
  async deleteConfigMap(name: string): Promise<void> {
    await this.core.deleteNamespacedConfigMap({ name, namespace: this.namespace }).catch((e) => {
      if (!isNotFound(e)) throw e;
    });
  }
  async deleteSecret(name: string): Promise<void> {
    await this.core.deleteNamespacedSecret({ name, namespace: this.namespace }).catch((e) => {
      if (!isNotFound(e)) throw e;
    });
  }

  async listPipelineRunNames(): Promise<string[]> {
    const raw = (await this.custom.listNamespacedCustomObject({
      ...TEKTON,
      namespace: this.namespace,
      labelSelector: `${MANAGED_BY_KEY}=${MANAGED_BY_VALUE}`,
    })) as { items?: Array<{ metadata?: { name?: string } }> };
    return (raw.items ?? []).map((i) => i.metadata?.name).filter((n): n is string => typeof n === "string");
  }

  async listSecretNames(): Promise<string[]> {
    const list = await this.core.listNamespacedSecret({ namespace: this.namespace });
    return list.items.map((i) => i.metadata?.name).filter((n): n is string => typeof n === "string");
  }

  async listConfigMapNames(): Promise<string[]> {
    const list = await this.core.listNamespacedConfigMap({ namespace: this.namespace });
    return list.items.map((i) => i.metadata?.name).filter((n): n is string => typeof n === "string");
  }
}

/** The GateRunner over a Tekton gate-run pipeline. `submit` dispatches a PipelineRun (+ the private-repo
 *  credential Secret when needed) and returns the run name as the jobId; `poll` reads the PipelineRun's
 *  outcome and, once settled, the published report ConfigMap, then reaps the run's objects. */
export class TektonGateRunner implements GateRunner {
  constructor(
    private readonly cfg: TektonGateRunnerConfig,
    private readonly cluster: GateRunCluster = new KubeGateRunCluster(cfg.namespace, cfg.kubeconfigPath),
    private readonly newRunId: () => string = () => `gate-run-${randomSuffix()}`,
  ) {}

  async submit(req: GateJobRequest): Promise<{ jobId: string }> {
    const runId = this.newRunId();
    // ALWAYS create the per-run credential Secret with the GITCREDENTIALS key the git-clone Task envFroms:
    // empty for a PUBLIC repo (anonymous clone), a real credential-store line for a PRIVATE one. A uniform
    // secret name means the gate-run pipeline never needs a Tekton conditional.
    let gitCredentials = "";
    if (req.repoCredentialId) {
      const token = await this.cfg.openCredential(req.repoCredentialId);
      try {
        gitCredentials = gitCredentialsLine(req.repoURL, token.toString("utf8"));
      } finally {
        token.fill(0);
      }
    }
    try {
      await this.cluster.createSecret(credSecretName(runId), { GITCREDENTIALS: gitCredentials });
    } catch (e) {
      throw upstream(`could not create the gate-run credential Secret: ${e instanceof Error ? e.message : String(e)}`);
    }
    try {
      await this.cluster.createPipelineRun(this.pipelineRunBody(runId, req));
    } catch (e) {
      await this.cluster.deleteSecret(credSecretName(runId)).catch(() => undefined);
      throw upstream(`could not create the gate-run PipelineRun: ${e instanceof Error ? e.message : String(e)}`);
    }
    return { jobId: runId };
  }

  async poll(jobId: string): Promise<GateJobProgress> {
    const outcome = await this.cluster.pipelineRunOutcome(jobId).catch((e) => {
      throw upstream(`could not read the gate-run PipelineRun status: ${e instanceof Error ? e.message : String(e)}`);
    });
    if (outcome === null) return { phase: "gating", gatesSoFar: [] };

    // Settled (succeeded or failed): the report is the source of truth, not the exit status — a gate
    // FAIL is a completed run whose report carries verdict "fail".
    //
    // The TaskRun statuses are captured FIRST, before the reap. Measured on a real installation: a
    // reap one line before the parse means a gate task that died takes its own TaskRun status with
    // it and the operator is left with schema violations about a report that was never written. The
    // TaskRuns are the only place the cause of a dead gate task exists, and they fall with the
    // PipelineRun the reap deletes.
    const evidence = await this.captureTaskRuns(jobId);
    const cm = await this.cluster.readReportConfigMap(reportCmName(jobId));
    await this.reap(jobId);

    if (cm.state === "absent") {
      throw this.gateIncomplete(
        `the gate-run settled (succeeded=${outcome.succeeded}) but published no report ConfigMap ${reportCmName(jobId)} at all — the publish-report task runs as a \`finally\` task, so it should have written one even after the gate task died`,
        null,
        evidence,
      );
    }
    if (cm.state === "unrecognized") {
      throw this.gateIncomplete(
        `the report ConfigMap ${reportCmName(jobId)} carries neither report.json nor incomplete.json — it carries: ${cm.keys.length > 0 ? cm.keys.join(", ") : "(no data keys at all)"}. The gate-runner that wrote it and this Manager disagree about the report contract`,
        null,
        evidence,
      );
    }
    if (cm.state === "incomplete") {
      // NOT parsed as a report: this key is the runner saying it produced none, so reading it against
      // GateReportSchema would answer a dead gate task with a list of missing report fields.
      const notice = readIncompleteNotice(cm.json);
      throw this.gateIncomplete(
        `the report ConfigMap ${reportCmName(jobId)} carries incomplete.json instead of report.json: the gate task produced no report file${notice.note !== null ? ` (${notice.note})` : ""}`,
        notice.reason,
        evidence,
      );
    }
    let report: GateReport;
    let published: Record<string, unknown>;
    try {
      published = JSON.parse(cm.json) as Record<string, unknown>;
      report = GateReportSchema.parse(published);
    } catch (e) {
      throw upstream(`the published gate report is malformed: ${e instanceof Error ? e.message : String(e)}`);
    }
    // The reportHash belt: recompute sha256 over the canonical published body (reportHash removed —
    // the same reportHashPayload the runner authored the hash with) and hold it against the field.
    // The hash is UNKEYED, so this is integrity, not authentication: it refuses a report corrupted in
    // the ConfigMap hop or rewritten without recomputing the hash, while a writer holding the
    // gate-report-writer credential could forge body and hash together — that credential is what the
    // sandbox's token-less pipeline-sa split protects.
    const { reportHash: _, ...body } = published;
    const computed = createHash("sha256").update(reportHashPayload(body)).digest("hex");
    if (computed !== report.reportHash) {
      throw upstream(
        `the published gate report's reportHash does not verify (report carries ${report.reportHash}, its body hashes to ${computed}) — the report was corrupted or rewritten after the runner authored it`,
      );
    }
    // The SANDBOX leg, and it is enforced here for the same reason the two above are: this line is
    // where the report crosses out of the sandbox and into the Manager. Measured on a real
    // installation: a report whose attestation said the node's own API server and the Manager were
    // both reachable from inside the gate pod was accepted, composed with the manager-side gates and
    // rejected for an unrelated reason — nothing anywhere refused because of those two booleans, so
    // the attestation was a field and not a fence.
    if (!sandboxGreen(report.sandbox)) throw this.sandboxDegraded(report);
    return { phase: "done", gatesSoFar: report.gates, report };
  }

  async cancel(jobId: string): Promise<void> {
    await this.reap(jobId);
  }

  /** Orphan sweep, run once at boot (wire-units). A manager restart loses every in-flight
   *  validation's jobId — it lives only in the validating call's scope, and resumeOnBoot fails the
   *  interrupted `planning` runs — so any gate object still standing in the namespace belongs to no
   *  live validation. Every jobId any surviving object names gets its whole triple reaped: above
   *  all the PAT-bearing gate-cred-* Secret, which no TTL and no pruner would ever remove. */
  async reapOrphans(): Promise<{ reaped: number }> {
    const [pipelineRuns, secrets, configMaps] = await Promise.all([
      this.cluster.listPipelineRunNames(),
      this.cluster.listSecretNames(),
      this.cluster.listConfigMapNames(),
    ]);
    const credPrefix = credSecretName("");
    const reportPrefix = reportCmName("");
    const ids = new Set<string>(pipelineRuns); // the PipelineRun's name IS the jobId
    for (const n of secrets) if (n.startsWith(credPrefix)) ids.add(n.slice(credPrefix.length));
    for (const n of configMaps) if (n.startsWith(reportPrefix)) ids.add(n.slice(reportPrefix.length));
    await Promise.all([...ids].map((id) => this.reap(id)));
    return { reaped: ids.size };
  }

  /** Read how the run's TaskRuns ended, ahead of the reap. A read that FAILS is recorded as such and
   *  never as an empty list: an empty list reads as "no task failed", and this call can fail for a
   *  reason that has nothing to do with the run — the Manager's Role in the gate-run namespace has to
   *  grant `list` on tekton.dev/taskruns, and without that grant the API server answers 403. */
  private async captureTaskRuns(jobId: string): Promise<TaskRunEvidence> {
    try {
      return { read: true, taskRuns: await this.cluster.listTaskRunOutcomes(jobId) };
    } catch (e) {
      return { read: false, why: e instanceof Error ? e.message : String(e) };
    }
  }

  /** The named failure for every case where the gate-run produced no report. It opens by saying that
   *  NOTHING was judged, because the reader it is written for is an agent working in the consumer's or
   *  tenant's own repository: a failed gate G7 is that repository's bug and this is not, and the two
   *  must never read alike. One fact per LINE — the run log writes one events row per line
   *  (server/executor/context.ts emit), so a joined blob would arrive as a single unreadable row. */
  private gateIncomplete(cause: string, reason: string | null, evidence: TaskRunEvidence): AppError {
    const lines = [
      "the gate-run did not run to completion — NO gate report exists, so nothing was judged about the repository under validation. This is a failure of the gate-run itself, not a finding about that repository.",
      cause,
      ...(reason !== null ? [`the gate-run's own reason: ${reason}`] : []),
      ...taskRunLines(evidence),
    ];
    return errGateIncomplete(`gate-runner (tekton): ${lines.join("\n")}`);
  }

  /** The named refusal for a report whose sandbox self-probe did not come back green. It is held
   *  APART from every gate verdict, and the wording carries that apart-ness, because the fence
   *  protects the CLUSTER from the repository and not the other way round: a fence that did not hold
   *  says nothing whatsoever about the repository under validation, and the reader this reaches works
   *  in that repository. It is also held apart from GATE_INCOMPLETE, which says the gate task
   *  produced no report — here a report exists and it is exactly what proves the refusal.
   *
   *  One fact per LINE: the run log writes one events row per line (server/executor/context.ts emit),
   *  so a joined blob arrives as a single unreadable row. */
  private sandboxDegraded(report: GateReport): AppError {
    const lines = [
      "the gate-run's own egress self-probe says the sandbox fence did NOT hold, so this run is refused. Nothing was judged about the repository under validation, and nothing in that repository can change this outcome.",
      "the sandbox is what keeps untrusted repository content away from the cluster it is being onboarded to; a run inside a fence that is not provably holding is not a validation, whatever its gates report.",
      ...sandboxFailures(report.sandbox),
      `must-fail targets probed: ${report.sandbox.mustFailTargets.length > 0 ? report.sandbox.mustFailTargets.join(", ") : "(none configured)"}`,
      // WHICH GATES THEREFORE DID NOT RUN, in the runner's own words rather than in a second set.
      // The refusal ends the run before anything writes runs.plan_json, so the G25 row the runner
      // authored reaches no reader unless this message carries it — and a count of gates that did
      // not run says nothing about which parts of the repository went uninspected. `sandboxRows`
      // reads the report in hand: the ConfigMap it came out of is already reaped by here, and the
      // parsed report is the only copy left.
      ...this.sandboxRows(report),
      `the runner that measured this: ${report.runnerVersion}`,
      "this is fixed in the platform's own gate-runner namespace — its egress NetworkPolicy — and the onboarding is re-run afterwards.",
    ];
    return errSandboxDegraded(`gate-runner (tekton): ${lines.join("\n")}`);
  }

  /** The rows the runner wrote about its own fence, as lines a person reads.
   *
   *  A fence-refused report carries exactly one gate — G25, whose `found` names every sandbox gate
   *  that did not run. A report carrying none of them says so rather than falling silent, because a
   *  refusal that listed nothing would read as a refusal with nothing behind it. */
  private sandboxRows(report: GateReport): string[] {
    const rows = report.gates.filter((g) => SANDBOX_SIDE_GATE_IDS.includes(g.id));
    if (rows.length === 0) {
      return [
        `the report carries no sandbox-side row of its own (it carries ${report.gates.length > 0 ? report.gates.map((g) => g.id).join(", ") : "no gates at all"}), so which sandbox gates did not run is not stated in it — the runner that wrote it is older than the row that says so.`,
      ];
    }
    return rows.map((g) => `${g.id} ${g.title}: ${g.found}`);
  }

  /** Best-effort delete of a run's objects (PipelineRun + report ConfigMap + credential Secret). */
  private async reap(jobId: string): Promise<void> {
    await Promise.allSettled([
      this.cluster.deletePipelineRun(jobId),
      this.cluster.deleteConfigMap(reportCmName(jobId)),
      this.cluster.deleteSecret(credSecretName(jobId)),
    ]);
  }

  private pipelineRunBody(runId: string, req: GateJobRequest): unknown {
    const p = (name: string, value: string): { name: string; value: string } => ({ name, value });
    return {
      apiVersion: "tekton.dev/v1",
      kind: "PipelineRun",
      metadata: {
        name: runId,
        namespace: this.cfg.namespace,
        labels: { [MANAGED_BY_KEY]: MANAGED_BY_VALUE, "hostyour.cloud/gate-target": req.targetName },
      },
      spec: {
        pipelineRef: { name: this.cfg.pipelineName },
        taskRunTemplate: { serviceAccountName: this.cfg.serviceAccount },
        // The clone + gate pods run under the token-less pipeline-sa (default above). publish-report is
        // the ONE task that needs an API token — to write the report ConfigMap back — so it is pinned to
        // gate-report-writer here. A per-task SA can only be set on the PipelineRun (a Pipeline cannot);
        // without this override publish-report's kubectl has no in-cluster credential and hits
        // http://localhost:8080, so no report is ever published.
        taskRunSpecs: [{ pipelineTaskName: "publish-report", serviceAccountName: this.cfg.reportWriterServiceAccount }],
        // The clone step writes the shared workspace as root; this mount-time fsGroup makes it
        // group-writable so the non-root gate step (runAsUser == podFsGroup) can create the report file.
        podTemplate: { securityContext: { fsGroup: this.cfg.podFsGroup } },
        workspaces: [
          {
            name: "source",
            volumeClaimTemplate: {
              spec: { accessModes: ["ReadWriteOnce"], resources: { requests: { storage: this.cfg.workspaceStorage } } },
            },
          },
        ],
        params: [
          p("git-url", req.repoURL),
          p("git-revision", req.resolvedSha),
          p("requested-ref", req.requestedRef),
          // A build-only unit carries no chartPath at all. The Tekton param is a declared string with
          // no default, so the run cannot simply leave it out — the empty string is the wire form of
          // "this unit ships no chart", and the CLI reads it back as an absence rather than as an
          // unset input. Nothing else in this body may use "" to mean anything.
          p("chart-path", req.chartPath ?? ""),
          p("stage", req.stage),
          p("target-name", req.targetName),
          p("cluster-value-files", JSON.stringify(req.clusterValueFiles)),
          p("run-id", runId),
          p("repo-credential-secret", credSecretName(runId)),
          p("must-fail-targets", this.cfg.fence.mustFailTargets.join(",")),
          p("manager-addr", this.cfg.fence.managerAddr),
          p("must-pass-target", this.cfg.fence.mustPassTarget),
          // The PARAMETER keeps its name: the Pipeline that declares it stands in the platform
          // repository and is not this repository's to rename. What it carries is a declaration.
          p("confirmed-listening", req.mustFailTargetsDeclaredListening ? "true" : "false"),
          p("runner-version", this.cfg.runnerVersion),
          p("kube-version", this.cfg.kubeVersion),
          p("job-budget-ms", String(this.cfg.jobBudgetMs)),
        ],
      },
    };
  }
}

/** The incomplete notice as the failure can use it. `reason` is read LENIENTLY — a notice that misses
 *  the rest of IncompleteGateRunSchema must still deliver its one sentence, because refusing it would
 *  put the operator back in front of a failure that says nothing. `note` is non-null exactly when the
 *  notice did not hold that schema, so a runner writing a shape this Manager does not know is stated
 *  rather than silently tolerated. */
function readIncompleteNotice(json: string): { reason: string | null; note: string | null } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    return { reason: null, note: `its incomplete.json is not JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
  const held = IncompleteGateRunSchema.safeParse(parsed);
  if (held.success) return { reason: held.data.reason, note: null };
  const reason = (parsed as { reason?: unknown } | null)?.reason;
  return {
    reason: typeof reason === "string" && reason.length > 0 ? reason : null,
    note: `its incomplete.json does not hold IncompleteGateRunSchema: ${held.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`,
  };
}

/** What the captured TaskRuns say, one line each. Every branch says something DIFFERENT: statuses
 *  that could not be read, a PipelineRun that produced no TaskRuns, and the outcomes themselves are
 *  three distinct facts, and collapsing any two of them into "nothing to show" would tell the
 *  operator that nothing failed. */
function taskRunLines(evidence: TaskRunEvidence): string[] {
  if (!evidence.read) {
    return [`the gate-run's TaskRun statuses could NOT be read, so why it died is not known here: ${evidence.why}`];
  }
  if (evidence.taskRuns.length === 0) {
    return ["the gate-run's PipelineRun had no TaskRuns at all — no task of the pipeline ever started"];
  }
  return [
    "what the gate-run's TaskRuns ended as:",
    ...evidence.taskRuns.map(
      (t) =>
        `  ${t.pipelineTaskName}: ${t.succeeded === null ? "never settled" : t.succeeded ? "succeeded" : "FAILED"}` +
        ` — ${t.reason || "(no reason)"}: ${t.message || "(no message)"}`,
    ),
  ];
}

/** A short, DB-safe, collision-resistant run suffix. crypto.randomUUID is available in the Manager
 *  runtime (unlike the workflow sandbox), so a trimmed uuid is fine. */
function randomSuffix(): string {
  return globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}

/** A git credential-store line for the git-clone Task's GITCREDENTIALS env. A GitHub PAT authenticates
 *  as username `x-access-token` with the token as the password; git's store matches by URL prefix, so the
 *  host alone suffices. A malformed repoURL falls back to github.com, and the blast radius of a wrong host
 *  is this run alone: the line goes into the per-run Secret created above, which no other caller names —
 *  git-clone takes `credentials-secret` without a default, so the release pipeline reaches its own Secret
 *  and this clone reaches only its own. A wrong line fails THIS clone to a synthetic FAIL report. */
function gitCredentialsLine(repoURL: string, token: string): string {
  let host = "github.com";
  try {
    host = new URL(repoURL).host || host;
  } catch {
    // keep the fallback host
  }
  return `https://x-access-token:${token}@${host}`;
}
