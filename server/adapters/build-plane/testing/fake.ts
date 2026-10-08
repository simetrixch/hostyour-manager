// In-memory BuildPlane fake for the onboarding domain tests — no cluster. The release watch
// (awaitReleaseRun) is scripted per unit: a test seeds the run the EventListener would have
// created, with the full release tag its param carries.
import type { BuildPlane, ReleaseRunQuery, ReleaseRunOutcome, ReleaseRunSucceeded } from "../port.ts";

export class FakeBuildPlane implements BuildPlane {
  /** Every release watch, in order — a test asserts the namespace-per-unit query shape. */
  readonly releaseWatches: ReleaseRunQuery[] = [];
  /** The release runs "on the cluster", keyed by unit — what awaitReleaseRun matches against.
   *  Seed via seedReleaseRun; leave empty to model a webhook that never fired (the watch times out). */
  private readonly releaseRuns = new Map<string, (ReleaseRunOutcome & { stage?: string })[]>();

  /** Seed the release PipelineRun the EventListener would have created in `<unit>-build`, put on
   *  `run.stage` where one is named. */
  seedReleaseRun(unit: string, run: ReleaseRunOutcome & { stage?: string }): void {
    const list = this.releaseRuns.get(unit) ?? [];
    list.push(run);
    this.releaseRuns.set(unit, list);
  }

  /** The lines the release queue hands every release watch, as the Tekton plane notes a wait. */
  readonly queueNotes: string[] = [];

  async awaitReleaseRun(query: ReleaseRunQuery, opts?: { onQueueNote?: (line: string) => void }): Promise<ReleaseRunOutcome | null> {
    this.releaseWatches.push(query);
    for (const line of this.queueNotes) opts?.onQueueNote?.(line);
    const match = this.matching(query).filter((r) => !query.standing?.includes(r.runName)).at(-1);
    if (!match) return null; // no seeded run models the watch that times out
    const { stage: _stage, ...outcome } = match;
    return outcome;
  }

  async listReleaseRuns(query: ReleaseRunQuery): Promise<string[]> {
    return this.matching(query).map((r) => r.runName);
  }

  /** The watches standing now, with the units each one names. */
  readonly releaseRunWatches = new Set<{ units: readonly string[]; onSucceeded: (run: ReleaseRunSucceeded) => void }>();

  watchReleaseRuns(units: readonly string[], onSucceeded: (run: ReleaseRunSucceeded) => void): () => void {
    const watch = { units, onSucceeded };
    this.releaseRunWatches.add(watch);
    return () => this.releaseRunWatches.delete(watch);
  }

  /** A release run of `run.unit` turning Succeeded, delivered to every standing watch that names the unit. */
  emitReleaseRunSucceeded(run: ReleaseRunSucceeded): void {
    for (const w of this.releaseRunWatches) if (w.units.includes(run.unit)) w.onSucceeded(run);
  }

  private matching(query: ReleaseRunQuery): (ReleaseRunOutcome & { stage?: string })[] {
    const prefix = `${query.version}-${query.channel}-`;
    return (this.releaseRuns.get(query.unit) ?? []).filter((r) => r.releaseTag.startsWith(prefix) && (query.stage === undefined || r.stage === undefined || r.stage === query.stage));
  }
}
