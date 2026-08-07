// The Tekton gate-runner (redesigned) — the Controller's concrete GateRunner. It
// dispatches an in-cluster `gate-run` Tekton PipelineRun in the locked-down, egress-fenced `gate-runner`
// namespace and reads the frozen GateReport back from the ConfigMap the run's publish step writes. This
// REPLACES the host-podman-Quadlet HTTP runner: no host, no loopback, no manual bring-up — the fence is
// a Calico NetworkPolicy and the sandbox is an ephemeral, token-less pod. The pipeline clones the repo
// itself at the pinned SHA (github is the one egress the fence allows); a private repo's read credential
// rides as a short-lived Secret this adapter creates + reaps.
import { createHash } from "node:crypto";
import { KubeConfig, CoreV1Api, CustomObjectsApi, ApiException } from "@kubernetes/client-node";
import { GateReportSchema, reportHashPayload, type GateReport } from "../../../shared/gates.ts";
import type { GateRunner, GateJobRequest, GateJobProgress } from "./port.ts";
import { AppError } from "../../kernel/errors.ts";

const TEKTON = { group: "tekton.dev", version: "v1", plural: "pipelineruns" } as const;

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

/** The narrow cluster seam the runner needs — a fake in tests, KubeGateRunCluster in production. Every
 *  op targets the ONE gate-run namespace on the control cluster. */
export interface GateRunCluster {
  createSecret(name: string, data: Record<string, string>): Promise<void>;
  createPipelineRun(body: unknown): Promise<void>;
  /** null while the PipelineRun is still running; {succeeded} once its Succeeded condition settles. */
  pipelineRunOutcome(name: string): Promise<{ succeeded: boolean } | null>;
  /** The report ConfigMap's `report.json` value, or null if the ConfigMap is absent. */
  readReport(cmName: string): Promise<string | null>;
  deletePipelineRun(name: string): Promise<void>;
  deleteConfigMap(name: string): Promise<void>;
  deleteSecret(name: string): Promise<void>;
  /** The names of every Controller-dispatched PipelineRun standing in the namespace (the impl
   *  filters by the managed-by label pipelineRunBody stamps). Orphan-sweep input. */
  listPipelineRunNames(): Promise<string[]>;
  /** Every Secret name in the namespace — the sweep keeps only the gate-cred-* it owns. */
  listSecretNames(): Promise<string[]>;
  /** Every ConfigMap name in the namespace — the sweep keeps only the gate-report-* it owns. */
  listConfigMapNames(): Promise<string[]>;
}

export interface TektonGateRunnerConfig {
  /** OPTIONAL kubeconfig-file override (dev/test). Absent ⇒ the pod ServiceAccount's in-cluster
   *  credentials (the production mode) — the gate-run ns lives on the master with the Controller. */
  kubeconfigPath?: string;
  namespace: string; // "gate-runner"
  pipelineName: string; // "gate-run"
  serviceAccount: string; // the pipeline SA ("pipeline-sa"), no cluster writes
  /** The SA the `publish-report` finally task runs under — the ONLY pod in the sandbox holding an
   *  API token (gate-report-writer, apps/gate-runner rbac.yaml). Bound per-task via the PipelineRun's
   *  taskRunSpecs; a Pipeline cannot pin a per-task SA. Without this override publish-report inherits
   *  the token-less pipeline-sa, so its kubectl finds no in-cluster credential and falls back to
   *  http://localhost:8080 — the report ConfigMap is never written and the Controller sees
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
  fence: { mustFailTargets: string[]; controllerAddr: string; mustPassTarget: string };
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

  async readReport(cmName: string): Promise<string | null> {
    try {
      const cm = (await this.core.readNamespacedConfigMap({ name: cmName, namespace: this.namespace })) as {
        data?: Record<string, string>;
      };
      return cm.data?.["report.json"] ?? null;
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
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
    // FAIL is a completed run whose report carries verdict "fail". The publish step runs `finally`, so
    // a report is always present; its ABSENCE is an internal failure the plan must reject, not hang on.
    const raw = await this.cluster.readReport(reportCmName(jobId));
    await this.reap(jobId);
    if (raw === null) {
      throw upstream(`the gate-run completed (succeeded=${outcome.succeeded}) but published no report ConfigMap`);
    }
    let report: GateReport;
    let published: Record<string, unknown>;
    try {
      published = JSON.parse(raw) as Record<string, unknown>;
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
    return { phase: "done", gatesSoFar: report.gates, report };
  }

  async cancel(jobId: string): Promise<void> {
    await this.reap(jobId);
  }

  /** Orphan sweep, run once at boot (wire-onboarding). A controller restart loses every in-flight
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
          p("chart-path", req.chartPath),
          p("stage", req.stage),
          p("target-name", req.targetName),
          p("cluster-value-files", JSON.stringify(req.clusterValueFiles)),
          p("run-id", runId),
          p("repo-credential-secret", credSecretName(runId)),
          p("must-fail-targets", this.cfg.fence.mustFailTargets.join(",")),
          p("controller-addr", this.cfg.fence.controllerAddr),
          p("must-pass-target", this.cfg.fence.mustPassTarget),
          p("confirmed-listening", req.mustFailTargetsConfirmedListening ? "true" : "false"),
          p("runner-version", this.cfg.runnerVersion),
          p("kube-version", this.cfg.kubeVersion),
          p("job-budget-ms", String(this.cfg.jobBudgetMs)),
        ],
      },
    };
  }
}

/** A short, DB-safe, collision-resistant run suffix. crypto.randomUUID is available in the Controller
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
