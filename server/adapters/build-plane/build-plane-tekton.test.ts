import { describe, it, expect } from "vitest";
import { TektonBuildPlane, type BuildPlaneCluster, type ListedPipelineRun, type PipelineRunOutcome, type TektonBuildPlaneConfig } from "./build-plane-tekton.ts";

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
}

function cfg(over: Partial<TektonBuildPlaneConfig> = {}): TektonBuildPlaneConfig {
  // No kubeconfigPath: it is only the dev/test file OVERRIDE — absent means in-cluster (the pod
  // SA), and these tests inject a FakeCluster anyway, so the config must typecheck without it.
  return { pollMs: 1, ...over };
}

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
    const out = await plane.awaitReleaseRun({ unit: "acme", version: "1.0.0", channel: "stable" }, { appearMs: 100 });
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
    await expect(plane.awaitReleaseRun({ unit: "acme", version: "1.0.0", channel: "stable" }, { appearMs: 5 })).resolves.toBeNull();
  });
});
