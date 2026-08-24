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
 *  minted repo-side), so the match is the tag's `<version>-<channel>-` prefix; `sinceIso` bounds
 *  the search to runs the CURRENT trigger fired, so an old run of the same release is never
 *  adopted as this onboarding's proof. */
export interface ReleaseRunQuery {
  unit: string;
  version: string;
  channel: string;
  /** Only runs created at/after this instant. Absent (a crash-resumed step lost its trigger time)
   *  ⇒ the newest matching run is taken. */
  sinceIso?: string;
}

/** The observed end of a release run: which PipelineRun it was, the FULL release tag its param
 *  carried (the minted truth the manager reads, never computes), and whether it succeeded. */
export interface ReleaseRunOutcome {
  runName: string;
  releaseTag: string;
  succeeded: boolean;
}

export interface BuildPlane {
  /** Find the unit's release PipelineRun (ReleaseRunQuery) and await its Succeeded condition. The
   *  namespace is resolved PER UNIT (`<unit>-build`) — the run was created by the EventListener,
   *  never by the manager, so this is a pure watch. Polls until a matching run EXISTS and then
   *  until it settles; null when timeoutMs elapses or the signal aborts first (the caller decides
   *  that is a failure). */
  awaitReleaseRun(query: ReleaseRunQuery, opts: { timeoutMs: number; signal?: AbortSignal }): Promise<ReleaseRunOutcome | null>;
}
