// The Tekton BuildPlane — the Controller's concrete BuildPlane, the structural sibling of the
// Tekton gate-runner (gate-runner-tekton.ts): a narrow cluster seam (BuildPlaneCluster — a fake in
// tests, KubeBuildPlaneCluster in production) under a small adapter that owns the watch policy.
// Read-only against tekton.dev over the pod SA: it lists and reads PipelineRuns in a unit's own
// `<unit>-build` namespace, and creates nothing.
import { KubeConfig, CustomObjectsApi } from "@kubernetes/client-node";
import type { BuildPlane, ReleaseRunQuery, ReleaseRunOutcome } from "./port.ts";
import { AppError } from "../../kernel/errors.ts";

const TEKTON = { group: "tekton.dev", version: "v1", plural: "pipelineruns" } as const;
const DEFAULT_POLL_MS = 10_000; // a release run takes minutes — a 10s tick is plenty and easy on the API server

function upstream(msg: string): AppError {
  return new AppError("UPSTREAM", `build-plane (tekton): ${msg}`);
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

/** The narrow cluster seam the build plane needs — a fake in tests, KubeBuildPlaneCluster in
 *  production. Every call names the unit's OWN `<unit>-build` namespace; there is no default. */
export interface BuildPlaneCluster {
  listPipelineRuns(labelSelector: string, namespace: string): Promise<ListedPipelineRun[]>;
  /** null while the PipelineRun is still running; {succeeded} once its Succeeded condition settles. */
  pipelineRunOutcome(name: string, namespace: string): Promise<{ succeeded: boolean } | null>;
}

/** The production cluster seam over @kubernetes/client-node. */
export class KubeBuildPlaneCluster implements BuildPlaneCluster {
  private readonly custom: CustomObjectsApi;
  constructor(kubeconfigPath?: string) {
    const kc = new KubeConfig();
    // EXPLICIT dispatch (mirrors kube.ts buildKubeConfig, never loadFromDefault): a set path is the
    // dev/test file override; absent ⇒ the pod ServiceAccount's in-cluster credentials — the
    // production mode (the build cluster IS the Controller's own cluster).
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

  async pipelineRunOutcome(name: string, namespace: string): Promise<{ succeeded: boolean } | null> {
    const raw = (await this.custom.getNamespacedCustomObject({ ...TEKTON, namespace, name })) as {
      status?: { conditions?: Array<{ type?: string; status?: string }> };
    };
    const cond = (raw.status?.conditions ?? []).find((c) => c.type === "Succeeded");
    if (!cond || cond.status === undefined || cond.status === "Unknown") return null; // still running
    return { succeeded: cond.status === "True" };
  }
}

export interface TektonBuildPlaneConfig {
  /** OPTIONAL kubeconfig-file override (dev/test). Absent ⇒ the pod ServiceAccount's in-cluster
   *  credentials (the production mode) — the build plane is the Controller's own cluster. */
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

  async awaitReleaseRun(query: ReleaseRunQuery, opts: { timeoutMs: number; signal?: AbortSignal }): Promise<ReleaseRunOutcome | null> {
    // The run lives in the UNIT's own build namespace and was created by the EventListener when the
    // release script pushed the deploy ref — this is a pure watch, nothing is created. The match:
    // the ownership label, the release-tag param's `<version>-<channel>-` prefix (the ts14 half of
    // the tag is minted repo-side and the controller never computes it), and — when the trigger time
    // is known — a creation at/after it, so an OLD run of the same release is never adopted.
    const ns = `${query.unit}-build`;
    const selector = `image-builder.io/consumer=${query.unit}`;
    const prefix = `${query.version}-${query.channel}-`;
    const deadline = Date.now() + opts.timeoutMs;
    for (;;) {
      let runs: ListedPipelineRun[];
      try {
        runs = await this.cluster.listPipelineRuns(selector, ns);
      } catch (e) {
        throw upstream(`could not list PipelineRuns in ${ns} for the ${prefix}* release: ${e instanceof Error ? e.message : String(e)}`);
      }
      const match = runs
        .filter((r) => (r.params["release-tag"] ?? "").startsWith(prefix))
        .filter((r) => query.sinceIso === undefined || r.creationTimestamp >= query.sinceIso)
        .sort((a, b) => a.creationTimestamp.localeCompare(b.creationTimestamp))
        .at(-1);
      if (match) {
        let outcome: { succeeded: boolean } | null;
        try {
          outcome = await this.cluster.pipelineRunOutcome(match.name, ns);
        } catch (e) {
          throw upstream(`could not read PipelineRun ${ns}/${match.name}: ${e instanceof Error ? e.message : String(e)}`);
        }
        if (outcome !== null) return { runName: match.name, releaseTag: match.params["release-tag"] ?? "", succeeded: outcome.succeeded };
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0 || opts.signal?.aborted) return null; // timed out / cancelled — the caller decides
      await sleep(Math.min(this.pollMs, remaining), opts.signal);
      if (opts.signal?.aborted) return null;
    }
  }

}
