// The release-cycle steps (plugins/unit/server/release-cycle.ts) — split out of onboard.run.test.ts, which is at
// the max-lines cap. The steps read only the github/buildPlane/repo/resolver ports + the release
// identity off params, so a minimal cast scaffold exercises them directly (the extracted-step test
// pattern, cf. onboard-webhook.run.test.ts).
//
// What they must get right: the trigger retries EXACTLY the not-yet-indexed 404 (bounded) and
// surfaces a 422/403 with GitHub's own message immediately; the workflow watch correlates by the
// kit's run-name inside the trigger window and ABORTS on ambiguity rather than guessing; the build
// watch reads the minted tag OFF the run and fails on a failed run; watch-deployment reads the tag
// the bump wrote (never computing it) and holds the Application to the bump commit, fail-fast on a
// terminally failed sync operation.
import { describe, it, expect } from "vitest";
import { triggerReleaseStep, watchReleaseBuildStep, type ReleaseCycleRuntime } from "#unit/server/release-cycle.ts";
import { watchDeploymentStep } from "./onboard-watch-deployment.ts";
import type { OnboardPorts, OnboardParams, DeployableOnboardParams } from "./onboard.run.ts";
import { FakeGitHubConsumer } from "../../adapters/github-consumer/testing/fake.ts";
import { FakeBuildPlane } from "../../adapters/build-plane/testing/fake.ts";
import { FakeRepoReader } from "../../adapters/git/testing/fake.ts";
import { FakeMasterArgoReader, FakeClusterReader, FakeMasterProjectWriter, FakeClusterKubeResolver } from "../../adapters/kube/testing/fake.ts";
import type { ArgoAppStatus } from "../../adapters/kube/port.ts";
import type { StepCtx } from "../../executor/types.ts";
import type { CredentialStore } from "../../security/store.ts";

const SHA = "a".repeat(40);
const REPO = "https://github.com/x/acme.git";
const MINTED_TAG = "1.0.0-stable-20260719120000";
const PINS = `builds:\n  - name: acme-api\n    image: acme-api\n    tag: "${MINTED_TAG}-abc1234"\n`;

function portsWith(over: Partial<OnboardPorts> = {}): OnboardPorts {
  return {
    github: new FakeGitHubConsumer(),
    buildPlane: new FakeBuildPlane(),
    repo: new FakeRepoReader({ resolvedSha: SHA, files: { "deploy/chart/values-prod.yaml": PINS } }),
    resolver: new FakeClusterKubeResolver({
      clusterReader: new FakeClusterReader(),
      argoReader: new FakeMasterArgoReader({ status: { syncRevision: SHA, targetRevision: null, sync: "Synced", health: "Healthy" } }),
      projectWriter: new FakeMasterProjectWriter(),
      argoNamespace: "argocd",
    }),
    argoWatchTimeoutMs: 1000,
    deployRefVisibleMs: 100,
    releaseBuildAppearMs: 100,
    releasePollIntervalMs: 1,
    dispatchRetry: { budgetMs: 50, intervalMs: 1 },
    ...over,
  } as unknown as OnboardPorts;
}

const params = (): OnboardParams =>
  ({
    form: "deployable", consumerName: "acme", repoURL: REPO, repoCredentialId: "cred_pat",
    version: "1.0.0", channel: "stable", stage: "prod", clusterId: "cls_1",
    chartPath: "deploy/chart", argoAppName: "acme-prod", builds: ["acme-api"],
  }) as unknown as OnboardParams;

const creds: CredentialStore = { open: () => Promise.resolve(Buffer.from("github_pat_test", "utf8")) } as unknown as CredentialStore;

const ctx = (logs: string[]): StepCtx =>
  ({
    runId: "run_rc", creds, signal: new AbortController().signal,
    log: (_s: string, t: string) => logs.push(t), checkpoint: () => undefined, readCheckpoint: () => undefined, registerCleanup: () => undefined,
  }) as unknown as StepCtx;

describe("trigger-release", () => {
  it("dispatches release.yml on the repo's default branch with {version, channel, stage}", async () => {
    const github = new FakeGitHubConsumer();
    github.defaultBranch = "master";
    await triggerReleaseStep(portsWith({ github }), params()).run(ctx([]));
    expect(github.dispatches).toEqual([
      expect.objectContaining({ owner: "x", repo: "acme", workflowFile: "release.yml", ref: "master", inputs: { version: "1.0.0", channel: "stable", stage: "prod" } }),
    ]);
  });

  it("retries the not-yet-indexed 404 inside the budget, then succeeds", async () => {
    const github = new FakeGitHubConsumer();
    github.dispatchNotFoundTimes = 2; // the kit landed moments ago; GitHub indexes with a lag
    const logs: string[] = [];
    await triggerReleaseStep(portsWith({ github }), params()).run(ctx(logs));
    expect(github.dispatches).toHaveLength(1);
    expect(logs.filter((l) => l.includes("retrying the dispatch"))).toHaveLength(2);
  });

  it("surfaces a 422 IMMEDIATELY with GitHub's own message — an old kit's workflow will not heal by waiting", async () => {
    const github = new FakeGitHubConsumer();
    github.dispatchRefusal = { status: 422, message: "Unexpected inputs provided: [\"stage\"]" };
    await expect(triggerReleaseStep(portsWith({ github }), params()).run(ctx([]))).rejects.toThrow(/422: Unexpected inputs provided/);
    expect(github.dispatches).toHaveLength(0); // never recorded as fired, never retried
  });

  it("surfaces a 403 immediately with GitHub's own message", async () => {
    const github = new FakeGitHubConsumer();
    github.dispatchRefusal = { status: 403, message: "Resource not accessible by personal access token" };
    await expect(triggerReleaseStep(portsWith({ github }), params()).run(ctx([]))).rejects.toThrow(/403: Resource not accessible/);
  });
});

describe("watch-release-build", () => {
  it("awaits the unit's release run, reads the FULL minted tag off it, and keeps it in-run for the record", async () => {
    const buildPlane = new FakeBuildPlane();
    buildPlane.seedReleaseRun("acme", { runName: "acme-release-9", releaseTag: MINTED_TAG, succeeded: true });
    const runtime: ReleaseCycleRuntime = {};
    const logs: string[] = [];
    await watchReleaseBuildStep(portsWith({ buildPlane }), params(), runtime).run(ctx(logs));
    expect(buildPlane.releaseWatches).toEqual([expect.objectContaining({ unit: "acme", version: "1.0.0", channel: "stable" })]);
    expect(runtime.releaseTag).toBe(MINTED_TAG); // read off the run's param — never composed
    expect(logs.some((l) => l.includes("acme-build/acme-release-9 Succeeded"))).toBe(true);
  });

  it("fails naming the run when the release PipelineRun FAILED", async () => {
    const buildPlane = new FakeBuildPlane();
    buildPlane.seedReleaseRun("acme", { runName: "acme-release-9", releaseTag: MINTED_TAG, succeeded: false });
    await expect(watchReleaseBuildStep(portsWith({ buildPlane }), params(), {}).run(ctx([]))).rejects.toThrow(/acme-build\/acme-release-9.*FAILED/);
  });

  it("fails when no matching run APPEARS inside the budget (the webhook fired nothing)", async () => {
    await expect(watchReleaseBuildStep(portsWith(), params(), {}).run(ctx([]))).rejects.toThrow(/no release PipelineRun for 1\.0\.0-stable-\* appeared/);
  });
});

describe("watch-deployment", () => {
  const deployable = (): DeployableOnboardParams => params() as DeployableOnboardParams;

  it("reads the tag the bump wrote off deploy/<stage> and holds the Application to that branch head", async () => {
    const prt = portsWith();
    const logs: string[] = [];
    await watchDeploymentStep(prt, deployable(), { releaseTag: MINTED_TAG }).run(ctx(logs));
    expect((prt.repo as FakeRepoReader).clones).toEqual([expect.objectContaining({ ref: "deploy/prod" })]);
    expect(logs.some((l) => l.includes(`the bump wrote ${MINTED_TAG}-abc1234`))).toBe(true);
    expect(logs.some((l) => l.includes("Synced + Healthy"))).toBe(true);
  });

  // #246: the plan's version is what the WIZARD read; the cycle mints the next free number when it
  // runs, and a customer may release in between. swissbookai was planned at 0.1.3 and delivered
  // 0.1.6, and this step waited for a pin that could never appear.
  it("holds the branch to the tag the CYCLE minted, whatever version the plan froze", async () => {
    const prt = portsWith({
      repo: new FakeRepoReader({ resolvedSha: SHA, files: { "deploy/chart/values-prod.yaml": `builds:
  - name: acme-api
    image: acme-api
    tag: "9.9.9-stable-20260922141253-ebed5a1"
` } }),
    });
    const logs: string[] = [];
    // The params still say 1.0.0 — only the minted tag decides.
    await watchDeploymentStep(prt, deployable(), { releaseTag: "9.9.9-stable-20260922141253" }).run(ctx(logs));
    expect(logs.some((l) => l.includes("the bump wrote 9.9.9-stable-20260922141253-ebed5a1"))).toBe(true);
  });

  it("refuses to watch at all where no minted tag was recorded — nothing would say which release to wait for", async () => {
    await expect(watchDeploymentStep(portsWith(), deployable(), {}).run(ctx([]))).rejects.toThrow(/recorded no minted tag/);
  });

  // #246: the delivery is what this run owes. A chart whose pods do not come up is the consumer
  // repository's bug, and holding the onboarding red over it says the platform failed when it did not.
  it("ends GREEN on Synced with a health that is not Healthy, and names that health", async () => {
    const argo = new FakeMasterArgoReader({ status: { syncRevision: SHA, targetRevision: null, sync: "Synced", health: "Degraded", message: "CrashLoopBackOff" } });
    const prt = portsWith({
      resolver: new FakeClusterKubeResolver({
        clusterReader: new FakeClusterReader(), argoReader: argo, projectWriter: new FakeMasterProjectWriter(), argoNamespace: "argocd",
      }) as unknown as OnboardPorts["resolver"],
    });
    const logs: string[] = [];
    await watchDeploymentStep(prt, deployable(), { releaseTag: MINTED_TAG }).run(ctx(logs));
    expect(logs.some((l) => l.includes("the delivery is done") && l.includes("Degraded") && l.includes("consumer repository's to fix"))).toBe(true);
  });

  it("fails when the delivery branch never carries the release's pins (the bump commit is not visible)", async () => {
    const prt = portsWith({
      repo: new FakeRepoReader({ resolvedSha: SHA, files: { "deploy/chart/values-prod.yaml": 'builds:\n  - name: acme-api\n    image: acme-api\n    tag: "0.0.0-placeholder"\n' } }),
      deployRefVisibleMs: 30,
    });
    await expect(watchDeploymentStep(prt, deployable(), { releaseTag: MINTED_TAG }).run(ctx([]))).rejects.toThrow(/bump commit is not visible/);
  });

  it("fails on a terminally FAILED sync operation and names the phase (fail-fast, never the whole budget)", async () => {
    const argo = new FakeMasterArgoReader({ status: { syncRevision: "b".repeat(40), targetRevision: null, sync: "OutOfSync", health: "Degraded", opPhase: "Failed", message: "one or more objects failed to apply" } });
    const prt = portsWith({
      resolver: new FakeClusterKubeResolver({
        clusterReader: new FakeClusterReader(), argoReader: argo, projectWriter: new FakeMasterProjectWriter(), argoNamespace: "argocd",
      }) as unknown as OnboardPorts["resolver"],
    });
    await expect(watchDeploymentStep(prt, deployable(), { releaseTag: MINTED_TAG }).run(ctx([]))).rejects.toThrow(/phase=Failed/);
    const ff = argo.lastWatchOpts?.failFast;
    expect(ff).toBeDefined();
    expect(ff!({ syncRevision: null, targetRevision: null, sync: "OutOfSync", health: "Progressing", opPhase: "Running" } as ArgoAppStatus)).toBe(false); // in flight — keep waiting
  });

  it("matches the CONSUMER-CHART source's revision on a multi-source app — another source at the head must not pass", async () => {
    const argo = new FakeMasterArgoReader({
      status: {
        syncRevision: null,
        targetRevision: null,
        syncSources: [
          { repoURL: "https://github.com/x/hostyour-cloud.git", revision: SHA },
          { repoURL: REPO, revision: "b".repeat(40) },
        ],
        sync: "Synced", health: "Healthy",
      },
    });
    const prt = portsWith({
      resolver: new FakeClusterKubeResolver({
        clusterReader: new FakeClusterReader(), argoReader: argo, projectWriter: new FakeMasterProjectWriter(), argoNamespace: "argocd",
      }) as unknown as OnboardPorts["resolver"],
    });
    await expect(watchDeploymentStep(prt, deployable(), { releaseTag: MINTED_TAG }).run(ctx([]))).rejects.toThrow(/was not Synced/);
  });
});
