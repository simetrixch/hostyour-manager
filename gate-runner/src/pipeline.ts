// gate-runner/src/pipeline.ts
// The gate pipeline: run the gates in report order over the materialized files and assemble
// the frozen GateReport. Producer phases G1 (structure) and G3 (render) gate the phases
// that depend on them — if G1 fails, the chart is not rendered (nothing valid to render); if G3
// fails, the rendered-doc gates do not run (nothing valid to inspect). Every gate result is streamed
// via onGate as it settles. The verdict is fail whenever any hard gate that
// RAN failed (or the sandbox is not green), so short-circuited gates still fail closed.
import type { GateContext } from "./gates/gate.ts";
import type { GateResult, SandboxAttestation, GateReport } from "../../shared/gates.ts";
import type { ConsumerManifest } from "../../shared/consumer.ts";
import type { Stage } from "../../shared/enums.ts";
import type { ClusterValueFile } from "../../shared/cluster-values.ts";
import { checkStructure } from "./gates/structure.gate.ts";
import { runRender, noChartToRender } from "./gates/render-pinned-deps.gate.ts";
import { PRE_RENDER_GATES, POST_RENDER_GATES } from "./gate-list.ts";
import { assembleReport } from "./report.ts";

export interface PipelineConfig {
  runnerVersion: string;
  kubeVersion: string;
  depBuildMs: number;
  renderMs: number;
}

/** Now() as a seam so a harness can pin timestamps; the runner uses the real clock. */
export type Clock = () => number;

/** The report-shaping metadata a gate run needs — everything EXCEPT the file source. The one-shot
 *  Tekton CLI fills it from its env + the cloned repo, then feeds the gates over `files`. */
export interface GateJobMeta {
  targetName: string;
  stage: Stage;
  /** The chart directory inside the repo, or NULL for a build-only unit — one that ships no chart at
   *  all, so nothing of it renders. Null is a form the run knows, not a missing input: G1 holds it
   *  against the manifest's own `chart:` block and refuses the two disagreeing. */
  chartPath: string | null;
  /** The target cluster's values chain, VERBATIM and in layering order (shared/cluster-values.ts). */
  clusterValueFiles: readonly ClusterValueFile[];
  repoURL: string;
  requestedRef: string;
  resolvedSha: string;
}

/** Run the gates in report order over an already-materialized `files` map and assemble the
 *  frozen GateReport. This is the SOURCE-agnostic core: the Tekton CLI builds `files` from the cloned
 *  workspace (workspace.ts), then calls this. `workspace` is the on-disk chart location the render
 *  (G3) runs helm in — the cloned repo dir. */
export async function runGates(
  files: ReadonlyMap<string, string>,
  meta: GateJobMeta,
  sandbox: SandboxAttestation,
  workspace: string,
  onGate: (g: GateResult) => void,
  cfg: PipelineConfig,
  signal: AbortSignal,
  now: Clock = Date.now,
): Promise<GateReport> {
  const startedAt = now();
  const gates: GateResult[] = [];
  const emit = (g: GateResult): void => {
    gates.push(g);
    onGate(g);
  };

  let manifest: ConsumerManifest | null = null;
  let rendered: GateContext["rendered"] = [];
  let dependencies: GateReport["dependencies"] = [];

  const baseCtx: GateContext = {
    targetName: meta.targetName,
    stage: meta.stage,
    chartPath: meta.chartPath,
    clusterValueFiles: meta.clusterValueFiles,
    files,
    manifest: null,
    rendered: [],
    dependencies: [],
  };

  // G1 structure — produces the manifest.
  const structure = checkStructure({ files, chartPath: meta.chartPath, targetName: meta.targetName, stage: meta.stage });
  emit(structure.result);
  manifest = structure.manifest;

  // G2 determinism — over ctx.files, independent of the render.
  const filesCtx: GateContext = { ...baseCtx, manifest };
  for (const gate of PRE_RENDER_GATES) emit(gate.check(filesCtx));

  // G3 render — only when the structure is valid (an invalid chart cannot render meaningfully).
  if (structure.result.status === "pass" && manifest !== null) {
    if (meta.chartPath === null) {
      // A BUILD-ONLY unit ships no chart, so there is nothing to render and the rendered-doc gates
      // have no subject. They do NOT run and they do NOT report a pass: a green row from a gate that
      // inspected zero documents is a verdict nothing could have made go red, and it reads exactly
      // like a gate that looked and found the repo clean. G3 states the absence and names them.
      emit(noChartToRender(POST_RENDER_GATES.map((g) => g.id)));
    } else {
      const render = await runRender({
        workspace,
        chartPath: meta.chartPath,
        targetName: meta.targetName,
        envs: manifest.envs,
        clusterValueFiles: meta.clusterValueFiles,
        files,
        kubeVersion: cfg.kubeVersion,
        depBuildMs: cfg.depBuildMs,
        renderMs: cfg.renderMs,
        signal,
      });
      emit(render.result);
      rendered = render.rendered;
      dependencies = render.dependencies;

      // The rendered-doc gates — only when the render itself passed.
      if (render.result.status === "pass") {
        const renderedCtx: GateContext = { ...baseCtx, manifest, rendered, dependencies };
        for (const gate of POST_RENDER_GATES) emit(gate.check(renderedCtx));
      }
    }
  }

  return assembleReport({
    runnerVersion: cfg.runnerVersion,
    repoURL: meta.repoURL,
    requestedRef: meta.requestedRef,
    resolvedSha: meta.resolvedSha,
    startedAt,
    finishedAt: now(),
    manifest,
    dependencies: [...dependencies],
    gates,
    sandbox,
  });
}

