// gate-runner/src/cli.ts
// The one-shot CLI entrypoint — how the gate-runner IMAGE runs as an in-cluster Tekton task (the
// replacement for the host-podman-Quadlet HTTP server). The `clone` task has already put the repo at
// the pinned SHA into the source workspace; this reads its inputs from env, PROVES the egress fence
// from inside (fence.ts self-probe, fail-closed — the fence is a Calico NetworkPolicy rather than
// host nftables now), runs the gates over the cloned tree, and writes the frozen GateReport to a file
// the pipeline's publish step turns into the ConfigMap the Manager reads. Exit 0 iff a report was
// written (a gate FAIL is a report verdict, not a crash); exit non-zero only on an internal error
// that produced NO report, which the pipeline's `finally` publish step then surfaces as a synthetic
// fail so the Manager never hangs.
//
// A FENCE THAT DID NOT HOLD STILL WRITES A REPORT, and it must: the attestation IS the measurement,
// and a run that exited instead would take the only evidence of a broken fence with it. What the
// report carries then is the refusal row (gates/sandbox-fence.gate.ts) and no check gate at all. The
// Manager refuses that report at receipt with SANDBOX_DEGRADED, on the same predicate this file
// reads (shared/gates.ts sandboxGreen).
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { GateReport, SandboxAttestation } from "../../shared/gates.ts";
import { sandboxGreen } from "../../shared/gates.ts";
import { STAGE, type Stage } from "../../shared/enums.ts";
import { ClusterValueFilesSchema } from "../../shared/cluster-values.ts";
import { runGates, type GateJobMeta, type PipelineConfig } from "./pipeline.ts";
import { readWorkspace } from "./workspace.ts";
import { selfProbe, type ConnectFn, type FenceConfig } from "./fence.ts";
import { assembleReport } from "./report.ts";
import { sandboxFenceRefusal } from "./gates/sandbox-fence.gate.ts";
import { SANDBOX_GATE_IDS } from "./gate-list.ts";

/** Everything the one-shot run needs, parsed + validated from the task env. */
export interface CliInputs {
  meta: GateJobMeta;
  sourceDir: string;
  pipeline: PipelineConfig;
  fence: FenceConfig;
  jobBudgetMs: number;
}

function req(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name];
  if (typeof v !== "string" || v.trim() === "") throw new Error(`gate-runner CLI: required env ${name} is not set`);
  return v;
}
function intEnv(env: NodeJS.ProcessEnv, name: string, def: number): number {
  const v = env[name];
  if (typeof v !== "string" || v.trim() === "") return def;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : def;
}
function csv(v: string | undefined): string[] {
  return typeof v === "string" ? v.split(",").map((s) => s.trim()).filter((s) => s.length > 0) : [];
}

/** CHART_PATH, or null for a unit that ships no chart. It is deliberately NOT read with req(): a
 *  build-only unit has no chart directory, the Tekton param carrying it is a declared string with no
 *  default so the run cannot leave it out, and the empty string is therefore the wire form of the
 *  absence. Reading that as an unset required input refused every build-only unit — the platform's
 *  own manager and the tenant fan-out repo among them — before a single gate ran.
 *  A null here is not taken on trust: G1 holds it against the manifest's own `chart:` block and
 *  refuses the two disagreeing, so a chart path lost in the wiring is still named as such. */
function chartPathEnv(env: NodeJS.ProcessEnv): string | null {
  const v = env.CHART_PATH;
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

/** Parse + validate the task env into CliInputs. Throws (=> non-zero exit, no report) on a bad shape:
 *  a malformed CLUSTER_VALUE_FILES or an unknown STAGE is an internal wiring error, not a gate result. */
export function parseEnv(env: NodeJS.ProcessEnv): CliInputs {
  const stage = req(env, "STAGE") as Stage;
  if (!(STAGE as readonly string[]).includes(stage)) throw new Error(`gate-runner CLI: STAGE "${stage}" is not one of ${STAGE.join("|")}`);
  const clusterValueFiles = ClusterValueFilesSchema.parse(JSON.parse(req(env, "CLUSTER_VALUE_FILES")));
  return {
    meta: {
      targetName: req(env, "TARGET_NAME"),
      stage,
      chartPath: chartPathEnv(env),
      clusterValueFiles,
      repoURL: req(env, "REPO_URL"),
      requestedRef: req(env, "REQUESTED_REF"),
      resolvedSha: req(env, "RESOLVED_SHA"),
    },
    sourceDir: req(env, "SOURCE_DIR"),
    pipeline: {
      runnerVersion: req(env, "RUNNER_VERSION"),
      kubeVersion: req(env, "KUBE_VERSION"),
      depBuildMs: intEnv(env, "DEP_BUILD_MS", 60_000),
      renderMs: intEnv(env, "RENDER_MS", 120_000),
    },
    fence: {
      mustFailTargets: csv(env.MUST_FAIL_TARGETS),
      managerAddr: req(env, "MANAGER_ADDR"),
      mustPassTarget: req(env, "MUST_PASS_TARGET"),
      // The Manager's declaration that the must-fail targets are listening; fail-closed default
      // false, so an unset flag never masquerades as a stated precondition. The ENV VAR keeps its
      // name: it is the Tekton pipeline's parameter (clusters/inventories/gate-runner/templates/
      // task-gate.yaml), which lives in the platform repository and is not this repository's to rename.
      declaredListening: env.CONFIRMED_LISTENING === "true",
      timeoutMs: intEnv(env, "FENCE_TIMEOUT_MS", 3000),
    },
    jobBudgetMs: intEnv(env, "JOB_BUDGET_MS", 8 * 60_000),
  };
}

/** Prove the fence, then run the gates over the cloned workspace, returning the frozen report. If the
 *  fence self-probe is not green OR the Manager declared no listening must-fail target, it REFUSES to
 *  read untrusted code and returns a report whose ONE gate row (G25) says the fence did not hold and
 *  names every sandbox gate that therefore did not run — the Manager's own sandbox re-check
 *  (sandboxGreen, at the gate-runner adapter's receipt) then refuses the run. `connect`/`now` are
 *  injectable for tests. */
export async function runGateCli(inputs: CliInputs, connect?: ConnectFn, now: () => number = Date.now): Promise<GateReport> {
  // Probe with the Manager's REAL declaration: sandboxGreen requires it AND the three egress probes,
  // so a missing declaration OR a fence that is not holding both fail closed below, and the refusing
  // report carries the truthful (not-green) sandbox the Manager re-checks. The declaration is the one
  // leg of the four that no probe stands behind — see shared/gates.ts sandboxProvenance.
  const sandbox: SandboxAttestation = await selfProbe(inputs.fence, connect);
  // The report a refused run returns. It carries G25 and NOTHING else: a report whose `gates` were
  // empty said only "no gate failed", which read exactly like a repository nobody could fault, and
  // the Manager's own gates then composed a rejection naming the repository's files.
  const fenceRefused = (): GateReport =>
    assembleReport({
      runnerVersion: inputs.pipeline.runnerVersion,
      repoURL: inputs.meta.repoURL,
      requestedRef: inputs.meta.requestedRef,
      resolvedSha: inputs.meta.resolvedSha,
      startedAt: now(),
      finishedAt: now(),
      manifest: null,
      dependencies: [],
      gates: [sandboxFenceRefusal(sandbox, SANDBOX_GATE_IDS)],
      sandbox,
    });

  // Fail closed BEFORE any untrusted chart render: a fence that is not provably green (which includes
  // the confirmed-listening precondition) means we do not run the gates at all.
  if (!sandboxGreen(sandbox)) return fenceRefused();

  const abort = new AbortController();
  const budget = setTimeout(() => abort.abort(), inputs.jobBudgetMs);
  try {
    const files = await readWorkspace(inputs.sourceDir, abort.signal);
    return await runGates(files, inputs.meta, sandbox, inputs.sourceDir, () => undefined, inputs.pipeline, abort.signal, now);
  } finally {
    clearTimeout(budget);
  }
}

/** Thin process wrapper: parse env, run, write REPORT_OUT, exit 0. Any throw (bad wiring, an
 *  unreadable workspace) exits 1 with NO report — the pipeline's publish step then writes a synthetic
 *  fail so the Manager's plan is rejected rather than hung. */
export async function main(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const reportOut = req(env, "REPORT_OUT");
  const inputs = parseEnv(env);
  const report = await runGateCli(inputs);
  await writeFile(reportOut, JSON.stringify(report), "utf8");
  process.stdout.write(`gate-runner: wrote report (verdict ${report.verdict}) to ${reportOut}\n`);
}

// Run only when invoked AS the entrypoint (not when a test imports parseEnv/runGateCli/main): compare
// this module's own path to the invoked script path.
const entry = process.argv[1];
if (entry && fileURLToPath(import.meta.url) === entry) {
  main().catch((e) => {
    process.stderr.write(`gate-runner CLI failed: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  });
}
