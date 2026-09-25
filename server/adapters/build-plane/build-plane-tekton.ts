// The Tekton BuildPlane — the Manager's concrete BuildPlane, the structural sibling of the
// Tekton gate-runner (gate-runner-tekton.ts): a narrow cluster seam (BuildPlaneCluster — a fake in
// tests, KubeBuildPlaneCluster in production) under a small adapter that owns the watch policy.
// Read-only against tekton.dev over the pod SA: it lists and reads PipelineRuns in a unit's own
// `<unit>-build` namespace, and creates nothing.
import { KubeConfig, CustomObjectsApi } from "@kubernetes/client-node";
import type { BuildPlane, ReleaseRunQuery, ReleaseRunOutcome } from "./port.ts";
import { AppError, errUpstream } from "../../kernel/errors.ts";

const TEKTON = { group: "tekton.dev", version: "v1", plural: "pipelineruns" } as const;
const DEFAULT_POLL_MS = 10_000; // a release run takes minutes — a 10s tick is plenty and easy on the API server

function upstream(msg: string): AppError {
  return errUpstream(`build-plane (tekton): ${msg}`);
}

/** Abortable sleep — resolves early (never rejects) on abort; the await loop re-checks the signal
 *  and returns null, per the port contract (same shape as kube.ts's watch sleep). */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const t = setTimeout(done, ms);
    function done(): void {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** One listed PipelineRun, reduced to what the release watch needs. */
export interface ListedPipelineRun {
  name: string;
  creationTimestamp: string;
  /** spec.params reduced to name -> value. The release watch reads `release-tag` off it — the run's
   *  identity travels as a param, never in the generated name. */
  params: Record<string, string>;
}

export interface PipelineRunOutcome {
  succeeded: boolean;
  imageTag?: string;
}

/** The narrow cluster seam the build plane needs — a fake in tests, KubeBuildPlaneCluster in
 *  production. Every call names the unit's OWN `<unit>-build` namespace; there is no default. */
export interface BuildPlaneCluster {
  listPipelineRuns(labelSelector: string, namespace: string): Promise<ListedPipelineRun[]>;
  /** null while the PipelineRun is still running; {succeeded, imageTag} once its Succeeded condition
   *  settles — imageTag is the run's `image-tag` result, absent when the run states none. */
  pipelineRunOutcome(name: string, namespace: string): Promise<PipelineRunOutcome | null>;
}

/** The production cluster seam over @kubernetes/client-node. */
export class KubeBuildPlaneCluster implements BuildPlaneCluster {
  private readonly custom: CustomObjectsApi;
  constructor(kubeconfigPath?: string) {
    const kc = new KubeConfig();
    // EXPLICIT dispatch (mirrors kube.ts buildKubeConfig, never loadFromDefault): a set path is the
    // dev/test file override; absent ⇒ the pod ServiceAccount's in-cluster credentials — the
    // production mode (the build cluster IS the Manager's own cluster).
    if (kubeconfigPath !== undefined) kc.loadFromFile(kubeconfigPath);
    else kc.loadFromCluster();
    this.custom = kc.makeApiClient(CustomObjectsApi);
  }

  async listPipelineRuns(labelSelector: string, namespace: string): Promise<ListedPipelineRun[]> {
    const raw = (await this.custom.listNamespacedCustomObject({ ...TEKTON, namespace, labelSelector })) as {
      items?: Array<{
        metadata?: { name?: string; creationTimestamp?: string };
        spec?: { params?: Array<{ name?: string; value?: unknown }> };
      }>;
    };
    return (raw.items ?? [])
      .filter((i) => typeof i.metadata?.name === "string" && i.metadata.name.length > 0)
      .map((i) => ({
        name: i.metadata?.name ?? "",
        creationTimestamp: i.metadata?.creationTimestamp ?? "",
        params: Object.fromEntries(
          (i.spec?.params ?? [])
            .filter((p): p is { name: string; value: unknown } => typeof p.name === "string")
            .map((p) => [p.name, typeof p.value === "string" ? p.value : String(p.value ?? "")]),
        ),
      }));
  }

  async pipelineRunOutcome(name: string, namespace: string): Promise<PipelineRunOutcome | null> {
    const raw = (await this.custom.getNamespacedCustomObject({ ...TEKTON, namespace, name })) as {
      status?: { conditions?: Array<{ type?: string; status?: string }>; results?: Array<{ name?: string; value?: unknown }> };
    };
    const cond = (raw.status?.conditions ?? []).find((c) => c.type === "Succeeded");
    if (!cond || cond.status === undefined || cond.status === "Unknown") return null; // still running
    // The pipeline's own `image-tag` result: `<release tag>-<sha7>`, the tag every build of the run
    // was pushed and pinned under (consumer-build pipeline-release.yaml, results).
    const imageTag = (raw.status?.results ?? []).find((r) => r.name === "image-tag")?.value;
    return { succeeded: cond.status === "True", ...(typeof imageTag === "string" && imageTag.length > 0 ? { imageTag } : {}) };
  }
}

export interface TektonBuildPlaneConfig {
  /** OPTIONAL kubeconfig-file override (dev/test). Absent ⇒ the pod ServiceAccount's in-cluster
   *  credentials (the production mode) — the build plane is the Manager's own cluster. */
  kubeconfigPath?: string;
  /** Succeeded-condition poll tick; overridable for tests. */
  pollMs?: number;
}

export class TektonBuildPlane implements BuildPlane {
  private readonly pollMs: number;

  constructor(
    cfg: TektonBuildPlaneConfig,
    private readonly cluster: BuildPlaneCluster = new KubeBuildPlaneCluster(cfg.kubeconfigPath),
  ) {
    this.pollMs = cfg.pollMs ?? DEFAULT_POLL_MS;
  }

  async awaitReleaseRun(query: ReleaseRunQuery, opts: { appearMs: number; signal?: AbortSignal }): Promise<ReleaseRunOutcome | null> {
    // The run lives in the UNIT's own build namespace and was created by the EventListener when the
    // release script pushed the deploy ref — this is a pure watch, nothing is created. The match:
    // the ownership label and the release-tag param's `<version>-<channel>-` prefix (the ts14 half
    // of the tag is minted repo-side and the manager never computes it). The deadline bounds the
    // APPEARANCE only: once the run exists, it is followed to its end without a clock.
    const ns = `${query.unit}-build`;
    const selector = `image-builder.io/consumer=${query.unit}`;
    const prefix = `${query.version}-${query.channel}-`;
    const appearBy = Date.now() + opts.appearMs;
    for (;;) {
      let runs: ListedPipelineRun[];
      try {
        runs = await this.cluster.listPipelineRuns(selector, ns);
      } catch (e) {
        throw upstream(`could not list PipelineRuns in ${ns} for the ${prefix}* release: ${e instanceof Error ? e.message : String(e)}`);
      }
      const match = runs
        .filter((r) => (r.params["release-tag"] ?? "").startsWith(prefix))
        .sort((a, b) => a.creationTimestamp.localeCompare(b.creationTimestamp))
        .at(-1);
      if (match) {
        let outcome: PipelineRunOutcome | null;
        try {
          outcome = await this.cluster.pipelineRunOutcome(match.name, ns);
        } catch (e) {
          throw upstream(`could not read PipelineRun ${ns}/${match.name}: ${e instanceof Error ? e.message : String(e)}`);
        }
        if (outcome !== null) return { runName: match.name, releaseTag: match.params["release-tag"] ?? "", ...outcome };
      } else if (Date.now() >= appearBy) {
        return null; // nothing appeared — the caller decides
      }
      if (opts.signal?.aborted) return null;
      await sleep(this.pollMs, opts.signal);
      if (opts.signal?.aborted) return null;
    }
  }

}
