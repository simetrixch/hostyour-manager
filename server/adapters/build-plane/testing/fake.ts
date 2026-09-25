// In-memory BuildPlane fake for the onboarding domain tests — no cluster. The release watch
// (awaitReleaseRun) is scripted per unit: a test seeds the run the EventListener would have
// created, with the full release tag its param carries.
import type { BuildPlane, ReleaseRunQuery, ReleaseRunOutcome } from "../port.ts";

export class FakeBuildPlane implements BuildPlane {
  /** Every release watch, in order — a test asserts the namespace-per-unit query shape. */
  readonly releaseWatches: ReleaseRunQuery[] = [];
  /** The release runs "on the cluster", keyed by unit — what awaitReleaseRun matches against.
   *  Seed via seedReleaseRun; leave empty to model a webhook that never fired (the watch times out). */
  private readonly releaseRuns = new Map<string, ReleaseRunOutcome[]>();

  /** Seed the release PipelineRun the EventListener would have created in `<unit>-build`. */
  seedReleaseRun(unit: string, run: ReleaseRunOutcome): void {
    const list = this.releaseRuns.get(unit) ?? [];
    list.push(run);
    this.releaseRuns.set(unit, list);
  }

  async awaitReleaseRun(query: ReleaseRunQuery): Promise<ReleaseRunOutcome | null> {
    this.releaseWatches.push(query);
    const prefix = `${query.version}-${query.channel}-`;
    const match = (this.releaseRuns.get(query.unit) ?? []).filter((r) => r.releaseTag.startsWith(prefix)).at(-1);
    return match ?? null; // no seeded run models the watch that times out
  }
}
