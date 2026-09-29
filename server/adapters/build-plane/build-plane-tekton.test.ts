import { describe, it, expect } from "vitest";
import { TektonBuildPlane, type BuildPlaneCluster, type ListedPipelineRun, type PipelineRunOutcome, type TektonBuildPlaneConfig, type WatchedPipelineRun } from "./build-plane-tekton.ts";
import type { ReleaseRunSucceeded } from "./port.ts";

// The Tekton BuildPlane over a scripted cluster seam — no cluster, no network (the same test
// shape as gate-runner-tekton.test.ts). The load-bearing assertions: the release watch finds the
// unit's run in the unit's OWN namespace by the ownership label and the release-tag prefix, and it
// reads the full tag off the run rather than composing one.

interface Rec {
  listSelectors: string[];
  listNamespaces: Array<string | undefined>;
}

class FakeCluster implements BuildPlaneCluster {
  rec: Rec = { listSelectors: [], listNamespaces: [] };
  private outcomes: Array<PipelineRunOutcome | null>;
  constructor(private script: { runs?: ListedPipelineRun[]; outcomes?: Array<PipelineRunOutcome | null> } = {}) {
    this.outcomes = [...(script.outcomes ?? [])];
  }
  async listPipelineRuns(labelSelector: string, namespace: string): Promise<ListedPipelineRun[]> {
    this.rec.listSelectors.push(labelSelector);
    this.rec.listNamespaces.push(namespace);
    return this.script.runs ?? [];
  }
  async pipelineRunOutcome(): Promise<PipelineRunOutcome | null> {
    // Consume the scripted outcome sequence; the last entry repeats (models a settled run).
    return this.outcomes.length > 1 ? (this.outcomes.shift() ?? null) : (this.outcomes[0] ?? null);
  }
  /** The standing watches by namespace; `see` hands one a run the way the informer would. */
  readonly watches = new Map<string, { selector: string; onRun: (run: WatchedPipelineRun) => void }>();
  watchPipelineRuns(namespace: string, labelSelector: string, onRun: (run: WatchedPipelineRun) => void): () => void {
    this.watches.set(namespace, { selector: labelSelector, onRun });
    return () => this.watches.delete(namespace);
  }
  see(namespace: string, run: WatchedPipelineRun): void {
    this.watches.get(namespace)?.onRun(run);
  }
}

function cfg(over: Partial<TektonBuildPlaneConfig> = {}): TektonBuildPlaneConfig {
  // No kubeconfigPath: it is only the dev/test file OVERRIDE — absent means in-cluster (the pod
  // SA), and these tests inject a FakeCluster anyway, so the config must typecheck without it.
  return { pollMs: 1, ...over };
}

/** The release most scenarios watch: acme's 1.0.0 on the stable channel. */
const RELEASE_100 = { unit: "acme", version: "1.0.0", channel: "stable" };

describe("TektonBuildPlane", () => {
  it("awaitReleaseRun matches by the ownership label + the release-tag prefix in the UNIT's own namespace and reads the FULL tag off the run", async () => {
    const c = new FakeCluster({
      runs: [
        // An older run of ANOTHER release — the prefix filter must pass it by.
        { name: "acme-release-old", creationTimestamp: "2026-07-28T09:00:00Z", params: { "release-tag": "0.9.0-beta-20260728090000", stage: "dev" } },
        { name: "acme-release-7", creationTimestamp: "2026-07-28T10:00:10Z", params: { "release-tag": "1.0.0-stable-20260728100000", stage: "prod" } },
      ],
      outcomes: [{ succeeded: true }],
    });
    const plane = new TektonBuildPlane(cfg(), c);
    const out = await plane.awaitReleaseRun(RELEASE_100, { appearMs: 100 });
    expect(out).toEqual({ runName: "acme-release-7", releaseTag: "1.0.0-stable-20260728100000", succeeded: true });
    expect(c.rec.listSelectors.at(-1)).toBe("image-builder.io/consumer=acme");
    expect(c.rec.listNamespaces.at(-1)).toBe("acme-build"); // the per-unit namespace, never image-builder
  });

  it("carries the run's image-tag result — the immutable <release tag>-<sha7> every build was pushed under — when the run states one", async () => {
    const runs = [{ name: "acme-release-8", creationTimestamp: "2026-07-28T11:00:00Z", params: { "release-tag": "1.1.0-stable-20260728110000" } }];
    const stated = new TektonBuildPlane(cfg(), new FakeCluster({ runs, outcomes: [{ succeeded: true, imageTag: "1.1.0-stable-20260728110000-abc1234" }] }));
    expect(await stated.awaitReleaseRun({ unit: "acme", version: "1.1.0", channel: "stable" }, { appearMs: 100 })).toMatchObject({ succeeded: true, imageTag: "1.1.0-stable-20260728110000-abc1234" });
    const unstated = new TektonBuildPlane(cfg(), new FakeCluster({ runs, outcomes: [{ succeeded: true }] }));
    expect(await unstated.awaitReleaseRun({ unit: "acme", version: "1.1.0", channel: "stable" }, { appearMs: 100 })).not.toHaveProperty("imageTag");
  });

  it("awaitReleaseRun returns null when no matching run APPEARS inside the budget (the caller decides)", async () => {
    const c = new FakeCluster({ runs: [] });
    const plane = new TektonBuildPlane(cfg(), c);
    await expect(plane.awaitReleaseRun(RELEASE_100, { appearMs: 5 })).resolves.toBeNull();
  });

  // A RELEASE PUT ON A STAGE AGAIN (#299) fires a run with the release tag of the run that put it there
  // first. The watch is handed the runs that stood before the trigger and the stage, and takes neither
  // the old run nor a run of the same release on another stage.
  const again = (): ListedPipelineRun[] => [
    { name: "acme-release-7", creationTimestamp: "2026-07-28T10:00:10Z", params: { "release-tag": "1.0.0-stable-20260728100000", stage: "prod" } },
    { name: "acme-release-9", creationTimestamp: "2026-07-29T10:00:10Z", params: { "release-tag": "1.0.0-stable-20260728100000", stage: "test" } },
  ];

  it("lists the runs of a release on one stage — what a trigger hands the watch as standing", async () => {
    const plane = new TektonBuildPlane(cfg(), new FakeCluster({ runs: again() }));
    expect(await plane.listReleaseRuns({ ...RELEASE_100, stage: "prod" })).toEqual(["acme-release-7"]);
    expect(await plane.listReleaseRuns(RELEASE_100)).toEqual(["acme-release-7", "acme-release-9"]);
  });

  it("PLANTED DEFECT: takes no run that stood before the trigger, and none of another stage, however finished it is", async () => {
    const plane = new TektonBuildPlane(cfg(), new FakeCluster({ runs: again(), outcomes: [{ succeeded: true }] }));
    await expect(plane.awaitReleaseRun({ ...RELEASE_100, stage: "prod", standing: ["acme-release-7"] }, { appearMs: 5 })).resolves.toBeNull();
  });

  it("THE INNOCENT NEIGHBOUR: takes the run the trigger fired on that stage once it appears", async () => {
    const fired = { name: "acme-release-12", creationTimestamp: "2026-07-30T10:00:10Z", params: { "release-tag": "1.0.0-stable-20260728100000", stage: "prod" } };
    const plane = new TektonBuildPlane(cfg(), new FakeCluster({ runs: [...again(), fired], outcomes: [{ succeeded: true }] }));
    expect(await plane.awaitReleaseRun({ ...RELEASE_100, stage: "prod", standing: ["acme-release-7"] }, { appearMs: 100 }))
      .toEqual({ runName: "acme-release-12", releaseTag: "1.0.0-stable-20260728100000", succeeded: true });
  });

  describe("watchReleaseRuns", () => {
    const later = (): string => new Date(Date.now() + 60_000).toISOString();
    const succeeded = (name: string, params: Record<string, string>, over: Partial<WatchedPipelineRun> = {}): WatchedPipelineRun =>
      ({ name, params, succeeded: true, completionTime: later(), imageTag: `${params["release-tag"]}-abc1234`, ...over });

    it("watches every unit in its own namespace by the ownership label, and reports a run that succeeds with a stage once", () => {
      const c = new FakeCluster();
      const seen: ReleaseRunSucceeded[] = [];
      const stop = new TektonBuildPlane(cfg(), c).watchReleaseRuns(["digita-jobs", "digita-auth"], (r) => seen.push(r), () => undefined);
      expect([...c.watches.entries()].map(([ns, w]) => [ns, w.selector])).toEqual([
        ["digita-jobs-build", "image-builder.io/consumer=digita-jobs"],
        ["digita-auth-build", "image-builder.io/consumer=digita-auth"],
      ]);
      const run = succeeded("digita-jobs-release-1", { "release-tag": "0.3.004-stable-20260929083025", stage: "prod" });
      c.see("digita-jobs-build", run);
      c.see("digita-jobs-build", run); // the same run changing again is no second release
      expect(seen).toEqual([{ unit: "digita-jobs", stage: "prod", runName: "digita-jobs-release-1", releaseTag: "0.3.004-stable-20260929083025", imageTag: "0.3.004-stable-20260929083025-abc1234" }]);
      stop();
      expect(c.watches.size).toBe(0);
    });

    it("PLANTED DEFECT: reports no run still running, failed, without a stage, or settled before the watch began", () => {
      const c = new FakeCluster();
      const seen: ReleaseRunSucceeded[] = [];
      new TektonBuildPlane(cfg(), c).watchReleaseRuns(["digita-jobs"], (r) => seen.push(r), () => undefined);
      const tag = { "release-tag": "0.3.004-stable-20260929083025" };
      c.see("digita-jobs-build", succeeded("running", { ...tag, stage: "prod" }, { succeeded: null }));
      c.see("digita-jobs-build", succeeded("failed", { ...tag, stage: "prod" }, { succeeded: false }));
      c.see("digita-jobs-build", succeeded("no-stage", tag));
      c.see("digita-jobs-build", succeeded("before", { ...tag, stage: "prod" }, { completionTime: "2026-01-01T00:00:00Z" }));
      expect(seen).toEqual([]);
    });
  });
});
