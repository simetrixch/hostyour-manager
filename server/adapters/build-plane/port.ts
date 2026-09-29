// The Manager's BuildPlane port — a pure WATCH over the build cluster's PipelineRuns. The
// manager never creates a build: every image is produced by its unit's own release pipeline,
// fired by the EventListener when the release script pushes the deploy ref. This port only observes
// that run and reports how it ended.
//
// Kept a PORT (types only) so the domain step depends on the abstraction; the concrete Tekton impl
// lives in build-plane-tekton.ts (CustomObjectsApi against tekton.dev over the pod SA, like the
// gate-runner), the fake in testing/.

/** What identifies a unit's RELEASE run — the run the webhook fires in the unit's OWN build
 *  namespace `<unit>-build`, labeled `image-builder.io/consumer=<unit>` and carrying the pushed
 *  release tag as its `release-tag` param. The manager never knows the full tag (the ts14 is
 *  minted repo-side), so the match is the tag's `<version>-<channel>-` prefix — and since every
 *  onboarding releases a fresh version (hostyour-manager#139), that prefix names one release. No
 *  clock enters the match (hostyour-manager#140). */
export interface ReleaseRunQuery {
  unit: string;
  version: string;
  channel: string;
  /** The stage the run puts the release on, its `stage` param: the same release put on another stage
   *  is a run of its own. Absent matches every stage. */
  stage?: string;
  /** The runs that stood before the release was triggered, by name. A release put on a stage again
   *  fires a run with the same release tag as the one that put it there first, and taking that
   *  finished run for the new one would report a release that never ran. */
  standing?: readonly string[];
}

/** The observed end of a release run: which PipelineRun it was, the FULL release tag its param
 *  carried (the minted truth the manager reads, never computes), whether it succeeded, and the
 *  immutable image tag `<release tag>-<sha7>` its `image-tag` result states — read off the run for
 *  the same reason the release tag is: the sha7 is the commit the release script stamped and tagged,
 *  which the manager never cloned. Absent when the run exposes no such result. */
export interface ReleaseRunOutcome {
  runName: string;
  releaseTag: string;
  succeeded: boolean;
  imageTag?: string;
}

/** A release run that turned Succeeded: its unit, the stage its bump pinned it at, and its tags. */
export interface ReleaseRunSucceeded {
  unit: string;
  stage: string;
  runName: string;
  releaseTag: string;
  imageTag?: string;
}

export interface BuildPlane {
  /** Find the unit's release PipelineRun (ReleaseRunQuery) and await its Succeeded condition. The
   *  namespace is resolved PER UNIT (`<unit>-build`) — the run was created by the EventListener,
   *  never by the manager, so this is a pure watch. Polls until a matching run EXISTS — null when
   *  none has appeared within appearMs (the caller decides that is a failure) — and then until it
   *  settles, however long that takes; null also when the signal aborts. */
  awaitReleaseRun(query: ReleaseRunQuery, opts: { appearMs: number; signal?: AbortSignal }): Promise<ReleaseRunOutcome | null>;
  /** The names of the release runs matching the query that stand now — what a trigger records as
   *  `standing` before it fires a run the watch must tell apart from them. */
  listReleaseRuns(query: ReleaseRunQuery): Promise<string[]>;
  /** Report every release run of `units` that turns Succeeded after this call, once, with the stage
   *  its `stage` param names; a run with no stage (a library's) is not reported. A pure watch, one
   *  per `<unit>-build` namespace: it lists and watches again by itself when the connection drops,
   *  and starts again after an error it reports to `onError`. Answers the function that stops it. */
  watchReleaseRuns(units: readonly string[], onSucceeded: (run: ReleaseRunSucceeded) => void, onError: (unit: string, err: unknown) => void): () => void;
}
