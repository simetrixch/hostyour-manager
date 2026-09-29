// The Tekton BuildPlane — the Manager's concrete BuildPlane, the structural sibling of the
// Tekton gate-runner (gate-runner-tekton.ts): a narrow cluster seam (BuildPlaneCluster — a fake in
// tests, KubeBuildPlaneCluster in production) under a small adapter that owns the watch policy.
// Read-only against tekton.dev over the pod SA: it lists and reads PipelineRuns in a unit's own
// `<unit>-build` namespace, and creates nothing.
import { KubeConfig, CustomObjectsApi, Watch, type KubernetesObject } from "@kubernetes/client-node";
import type { BuildPlane, ReleaseRunQuery, ReleaseRunOutcome, ReleaseRunSucceeded } from "./port.ts";
import { AppError, errUpstream } from "../../kernel/errors.ts";

const TEKTON = { group: "tekton.dev", version: "v1", plural: "pipelineruns" } as const;
const DEFAULT_POLL_MS = 10_000; // a release run takes minutes — a 10s tick is plenty and easy on the API server
/** How long a release watch that failed waits before it lists and watches again. */
const WATCH_RETRY_MS = 30_000;

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

/** One PipelineRun as a watch sees it: its params and, once it settled, how and when. */
export interface WatchedPipelineRun {
  name: string;
  params: Record<string, string>;
  /** null while the run runs; its Succeeded condition once it settled. */
  succeeded: boolean | null;
  /** status.completionTime, once the run settled. */
  completionTime?: string;
  imageTag?: string;
}

/** The narrow cluster seam the build plane needs — a fake in tests, KubeBuildPlaneCluster in
 *  production. Every call names the unit's OWN `<unit>-build` namespace; there is no default. */
export interface BuildPlaneCluster {
  listPipelineRuns(labelSelector: string, namespace: string): Promise<ListedPipelineRun[]>;
  /** null while the PipelineRun is still running; {succeeded, imageTag} once its Succeeded condition
   *  settles — imageTag is the run's `image-tag` result, absent when the run states none. */
  pipelineRunOutcome(name: string, namespace: string): Promise<PipelineRunOutcome | null>;
  /** Hand every PipelineRun under the selector in `namespace` to `onRun` as it is listed, added or
   *  changed, until the answered function is called; an error goes to `onError`. */
  watchPipelineRuns(namespace: string, labelSelector: string, onRun: (run: WatchedPipelineRun) => void, onError: (err: unknown) => void): () => void;
}

type RawPipelineRun = KubernetesObject & {
  spec?: { params?: Array<{ name?: string; value?: unknown }> };
  status?: { conditions?: Array<{ type?: string; status?: string }>; completionTime?: string; results?: Array<{ name?: string; value?: unknown }> };
};

/** What one pass of a watch loop needs: a list of what stands, and a watch from the version that
 *  list saw, which settles when the server ends it or it fails. */
export interface WatchSource<T> {
  list(): Promise<{ items: T[]; resourceVersion: string | undefined }>;
  watch(resourceVersion: string | undefined, onObject: (obj: T) => void): { done: Promise<void>; abort: () => void };
}

/** List, then watch from what the list saw, and again when the watch ends: the API server ends every
 *  watch after a while, and a list replays each object that stands, which the caller has to take
 *  more than once. EVERY failure is caught here, reported and waited out, a throwing `onObject`
 *  included: a rejection nobody awaits ends the process. Answers the function that stops the loop. */
export function watchLoop<T>(source: WatchSource<T>, onObject: (obj: T) => void, onError: (err: unknown) => void, retryMs = WATCH_RETRY_MS): () => void {
  let stopped = false;
  let abort: (() => void) | undefined;
  let wake: (() => void) | undefined;
  const see = (obj: T): void => {
    try {
      onObject(obj);
    } catch (err) {
      onError(err);
    }
  };
  const loop = async (): Promise<void> => {
    while (!stopped) {
      try {
        const listed = await source.list();
        for (const item of listed.items) see(item);
        if (stopped) return;
        const watching = source.watch(listed.resourceVersion, see);
        abort = watching.abort;
        await watching.done;
      } catch (err) {
        if (stopped) return;
        onError(err);
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, retryMs);
          t.unref?.();
          wake = () => {
            clearTimeout(t);
            resolve();
          };
        });
      }
    }
  };
  void loop();
  return () => {
    stopped = true;
    abort?.();
    wake?.();
  };
}

function watchedRun(raw: RawPipelineRun): WatchedPipelineRun {
  const cond = (raw.status?.conditions ?? []).find((c) => c.type === "Succeeded");
  const imageTag = (raw.status?.results ?? []).find((r) => r.name === "image-tag")?.value;
  return {
    name: raw.metadata?.name ?? "",
    params: Object.fromEntries((raw.spec?.params ?? []).filter((p): p is { name: string; value: unknown } => typeof p.name === "string").map((p) => [p.name, typeof p.value === "string" ? p.value : String(p.value ?? "")])),
    succeeded: !cond || cond.status === undefined || cond.status === "Unknown" ? null : cond.status === "True",
    ...(raw.status?.completionTime ? { completionTime: raw.status.completionTime } : {}),
    ...(typeof imageTag === "string" && imageTag.length > 0 ? { imageTag } : {}),
  };
}

/** The production cluster seam over @kubernetes/client-node. */
export class KubeBuildPlaneCluster implements BuildPlaneCluster {
  private readonly custom: CustomObjectsApi;
  private readonly kc: KubeConfig;
  constructor(kubeconfigPath?: string) {
    const kc = new KubeConfig();
    this.kc = kc;
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

  watchPipelineRuns(namespace: string, labelSelector: string, onRun: (run: WatchedPipelineRun) => void, onError: (err: unknown) => void): () => void {
    const path = `/apis/${TEKTON.group}/${TEKTON.version}/namespaces/${namespace}/${TEKTON.plural}`;
    const watcher = new Watch(this.kc);
    const source: WatchSource<RawPipelineRun> = {
      list: async () => {
        const raw = (await this.custom.listNamespacedCustomObject({ ...TEKTON, namespace, labelSelector })) as { items?: RawPipelineRun[]; metadata?: { resourceVersion?: string } };
        return { items: raw.items ?? [], resourceVersion: raw.metadata?.resourceVersion };
      },
      watch: (resourceVersion, onObject) => {
        let request: AbortController | undefined;
        let aborted = false;
        const done = new Promise<void>((resolve, reject) => {
          // An ERROR event (a version too old, 410) is followed by the end of the stream, and the
          // loop lists again; nothing but ADDED and MODIFIED carries a run.
          watcher.watch(path, { labelSelector, ...(resourceVersion ? { resourceVersion } : {}) }, (phase: string, obj: RawPipelineRun) => {
            if (phase === "ADDED" || phase === "MODIFIED") onObject(obj);
          }, (err: unknown) => (err ? reject(err) : resolve())).then((r) => {
            request = r;
            if (aborted) r.abort();
          }, reject);
        });
        return { done, abort: () => { aborted = true; request?.abort(); } };
      },
    };
    return watchLoop(source, (raw) => onRun(watchedRun(raw)), onError);
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
    const appearBy = Date.now() + opts.appearMs;
    for (;;) {
      const { ns, runs } = await this.releaseRuns(query);
      const match = runs
        .filter((r) => !query.standing?.includes(r.name))
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

  async listReleaseRuns(query: ReleaseRunQuery): Promise<string[]> {
    return (await this.releaseRuns(query)).runs.map((r) => r.name);
  }

  watchReleaseRuns(units: readonly string[], onSucceeded: (run: ReleaseRunSucceeded) => void, onError: (unit: string, err: unknown) => void): () => void {
    // The first list of every watch replays each run that stands; one that settled before the watch
    // began is not an event, and whoever starts the watch checks once for what it missed. A run is
    // reported once, however often its object changes afterwards.
    const since = Date.now();
    const reported = new Set<string>();
    const stops = units.map((unit) =>
      this.cluster.watchPipelineRuns(`${unit}-build`, `image-builder.io/consumer=${unit}`, (run) => {
        const stage = run.params["stage"] ?? "";
        const key = `${unit}/${run.name}`;
        if (run.succeeded !== true || stage === "" || reported.has(key)) return;
        reported.add(key);
        if (run.completionTime === undefined || Date.parse(run.completionTime) < since) return;
        onSucceeded({ unit, stage, runName: run.name, releaseTag: run.params["release-tag"] ?? "", ...(run.imageTag ? { imageTag: run.imageTag } : {}) });
      }, (err) => onError(unit, err)),
    );
    return () => {
      for (const stop of stops) stop();
    };
  }

  /** The runs of the queried release in its own build namespace: the release tag's
   *  `<version>-<channel>-` prefix, and the stage where the query names one. */
  private async releaseRuns(query: ReleaseRunQuery): Promise<{ ns: string; runs: ListedPipelineRun[] }> {
    const ns = `${query.unit}-build`;
    const selector = `image-builder.io/consumer=${query.unit}`;
    const prefix = `${query.version}-${query.channel}-`;
    let runs: ListedPipelineRun[];
    try {
      runs = await this.cluster.listPipelineRuns(selector, ns);
    } catch (e) {
      throw upstream(`could not list PipelineRuns in ${ns} for the ${prefix}* release: ${e instanceof Error ? e.message : String(e)}`);
    }
    return { ns, runs: runs.filter((r) => (r.params["release-tag"] ?? "").startsWith(prefix) && (query.stage === undefined || r.params["stage"] === query.stage)) };
  }

}
