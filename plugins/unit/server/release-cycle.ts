// The release-cycle steps of a unit's build: trigger the injected release workflow ONCE, then watch
// the release run it fires on the build plane. What a deployable unit's deployment then does is the
// deploying family's own watch.
//
// The manager has no task in the release cycle — it only triggers and reads. Everything the
// cycle produces is read back, never computed: the release tag comes off the PipelineRun's own
// release-tag param, and the image tag a deployment carries comes off the values file the bump task
// committed to the delivery branch. Triggering through the INJECTED workflow is simultaneously the
// proof of the injection: a broken kit produces no run, and the build watch fails visibly.
//
// NOTHING HERE IS FOUND BY TIME. GitHub's own run list is not read: a dispatch answers 204 with no
// run id, and picking "the run created after the dispatch" compares GitHub's clock with the
// Manager's — a Manager 30 s fast after a restore never saw the run it fired (hostyour-manager#140).
// What identifies the release is the release itself: the PipelineRun the webhook fires carries
// unit + version + channel in its params, and the bump writes the minted tag into the delivery
// branch. Appearing is bounded (a webhook delivers in seconds; a run that never appears is a
// finding); finishing is not — a build or a deployment takes what it takes, and the operator's
// cancel is the only limit.
import type { Step, StepCtx } from "#core/server/executor/types.ts";
import type { BuildPlane, ReleaseRunOutcome, ReleaseRunQuery } from "#core/server/adapters/build-plane/port.ts";
import type { BuildPorts, BuildParams } from "./build-chain.ts";
import { WorkflowNotFoundError, type GitHubConsumer } from "./adapters/github-consumer/port.ts";
import { parseGitHubOwnerRepo } from "./github-repo-url.ts";
import { errValidation } from "#core/server/kernel/errors.ts";

/** The workflow file the release kit injects — the one trigger-release dispatches. */
export const RELEASE_WORKFLOW_FILE = "release.yml";

/** In-run memory the release-cycle steps share within ONE execute() pass (the seed-secrets/activate
 *  precedent): `releaseTag` is the FULL minted tag read off the build run's param, `imageTag` the
 *  immutable `<release tag>-<sha7>` read off the run's `image-tag` result — what the run pushed
 *  every build under. Lost on a crash-resume — the watch then re-reads both. */
export interface ReleaseCycleRuntime {
  releaseTag?: string | undefined;
  imageTag?: string | undefined;
}

/** What putting a release on a stage reads of its run's params — every form of the release cycle
 *  carries these, a first release's params and a standing unit's alike. */
export type ReleaseOnStage = Pick<BuildParams, "consumerName" | "repoURL" | "repoCredentialId" | "version" | "channel" | "stage">;

/** A bounded pause the run's cancel cuts short — the tick between two polls of a watch. */
export const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done(): void {
      clearTimeout(t);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });

/** trigger-release: dispatch the injected release workflow with {version, channel, stage} — the ONE
 *  external start of the release cycle, and the test of the injection that preceded it. */
export function triggerReleaseStep(ports: BuildPorts, p: BuildParams): Step {
  return {
    name: "trigger-release",
    title: "Trigger the injected release workflow",
    run: async (ctx) => {
      if (!ports.github) {
        throw errValidation(`onboard "${p.consumerName}" requires the GitHub client to trigger the release workflow but none is wired on this manager — the release cycle cannot start`);
      }
      const where = await dispatchReleaseWorkflow(ctx, ports.github, ports, p, "consumer-onboard:trigger-release", {});
      ctx.checkpoint({ workflow: RELEASE_WORKFLOW_FILE, version: p.version, channel: p.channel, stage: p.stage });
      ctx.log("meta", `release workflow dispatched on ${where} — ${RELEASE_WORKFLOW_FILE} with version=${p.version} channel=${p.channel} stage=${p.stage}; the cycle now runs outside the manager`);
    },
  };
}

/** The injected release workflow dispatched on the repository's default branch, with the run's
 *  {version, channel, stage} and `inputs` beside them. A 404 is retried inside a bounded budget: the
 *  workflow was committed moments ago and GitHub indexes it with a small lag. A 422 (the workflow
 *  refuses the inputs — an old kit, or no dispatch trigger) and a 403 surface GitHub's own message
 *  IMMEDIATELY: waiting cannot heal either. Answers `<owner>/<repo>` for the log. */
async function dispatchReleaseWorkflow(ctx: StepCtx, github: GitHubConsumer, ports: BuildPorts, p: ReleaseOnStage, purpose: string, inputs: Record<string, string>): Promise<string> {
  const { owner, repo } = parseGitHubOwnerRepo(p.repoURL);
  const retry = ports.dispatchRetry ?? { budgetMs: 60_000, intervalMs: 5_000 };
  const pat = await ctx.creds.open(p.repoCredentialId, { purpose, runId: ctx.runId });
  try {
    const token = pat.toString("utf8");
    const ref = await github.getDefaultBranch({ owner, repo, token, signal: ctx.signal });
    const deadline = Date.now() + retry.budgetMs;
    for (;;) {
      try {
        await github.dispatchWorkflow({
          owner, repo, token,
          workflowFile: RELEASE_WORKFLOW_FILE,
          ref,
          inputs: { version: p.version, channel: p.channel, stage: p.stage, ...inputs },
          signal: ctx.signal,
        });
        return `${owner}/${repo}`;
      } catch (err) {
        // Only the not-yet-indexed 404 is retried — the kit landed seconds ago. Everything else
        // (422: the workflow refuses the inputs; 403: forbidden) carries GitHub's own message and
        // is surfaced immediately: no amount of waiting changes what the workflow file says.
        if (!(err instanceof WorkflowNotFoundError) || Date.now() >= deadline || ctx.signal.aborted) throw err;
        ctx.log("meta", `${err.message} — retrying the dispatch (the workflow was committed moments ago; GitHub indexes it with a small lag)`);
        await sleep(retry.intervalMs, ctx.signal);
      }
    }
  } finally {
    pat.fill(0);
  }
}

/** watch-release-build: await the release PipelineRun the pushed deploy ref fired — in the unit's
 *  OWN build namespace `<name>-build`, matched by the ownership label + the release-tag param's
 *  `<version>-<channel>-` prefix. The FULL tag (with its repo-minted ts14) is read OFF the run and
 *  kept in-run for the log — the manager never composes it. */
export function watchReleaseBuildStep(ports: BuildPorts, p: BuildParams, runtime: ReleaseCycleRuntime): Step {
  return {
    name: "watch-release-build",
    title: "Watch the release build on the build plane",
    run: async (ctx) => {
      if (!ports.buildPlane) {
        throw errValidation(`onboard "${p.consumerName}" requires the build-plane client to watch the release run but none is wired on this manager`);
      }
      const outcome = await settledReleaseRun(ctx, ports.buildPlane, ports, p, { unit: p.consumerName, version: p.version, channel: p.channel });
      runtime.releaseTag = outcome.releaseTag;
      runtime.imageTag = outcome.imageTag;
      ctx.checkpoint({ pipelineRun: outcome.runName, releaseTag: outcome.releaseTag, ...(outcome.imageTag ? { imageTag: outcome.imageTag } : {}) });
      ctx.log("meta", `release PipelineRun ${p.consumerName}-build/${outcome.runName} Succeeded — release ${outcome.releaseTag} is built, pushed and bumped for ${p.stage}${outcome.imageTag ? ` as image tag ${outcome.imageTag}` : ""}`);
    },
  };
}

/** put-release: put a release that stands on origin on the unit's stage again (#299) — the kit's
 *  `--existing` mode through the injected workflow, then the run it fires awaited to its end. ONE
 *  step, because the watch has to tell the run it fires from the run that put the same release on
 *  the same stage before: both carry the same release tag, and taking the finished one would report a
 *  release that never ran. The runs standing before the dispatch are this step's checkpoint, so a
 *  resume waits for the same run and dispatches no second one. */
export function putReleaseStep(ports: BuildPorts, p: ReleaseOnStage, runtime: ReleaseCycleRuntime, purpose = "set-release:put-release"): Step {
  return {
    name: "put-release",
    title: `Put the release ${p.version}-${p.channel} on ${p.stage} again`,
    run: async (ctx) => {
      if (!ports.github || !ports.buildPlane) {
        throw errValidation(`putting ${p.version}-${p.channel} on ${p.stage} again needs the GitHub client and the build-plane client, and this manager wires ${ports.github ? "no build-plane client" : "no GitHub client"}`);
      }
      const release = { unit: p.consumerName, version: p.version, channel: p.channel, stage: p.stage };
      const saved = ctx.readCheckpoint<{ standing: string[]; dispatched: boolean }>();
      const standing = saved?.standing ?? (await ports.buildPlane.listReleaseRuns(release));
      if (!saved?.dispatched) {
        ctx.checkpoint({ standing, dispatched: false });
        const where = await dispatchReleaseWorkflow(ctx, ports.github, ports, p, purpose, { existing: "true" });
        ctx.checkpoint({ standing, dispatched: true });
        ctx.log("meta", `release workflow dispatched on ${where} — ${RELEASE_WORKFLOW_FILE} with version=${p.version} channel=${p.channel} stage=${p.stage} existing=true; ${standing.length} earlier run(s) of this release on ${p.stage} are not taken for the one it fires`);
      }
      const outcome = await settledReleaseRun(ctx, ports.buildPlane, ports, p, { ...release, standing });
      runtime.releaseTag = outcome.releaseTag;
      runtime.imageTag = outcome.imageTag;
      ctx.checkpoint({ standing, dispatched: true, pipelineRun: outcome.runName, releaseTag: outcome.releaseTag });
      ctx.log("meta", `release PipelineRun ${p.consumerName}-build/${outcome.runName} Succeeded — release ${outcome.releaseTag} stands on ${p.stage} again`);
    },
  };
}

/** The release steps of an onboarding: a release that stands put on the stage as it stands, where
 *  another stage of the unit runs one, else the version minted, built and watched. */
export function releaseSteps(ports: BuildPorts, p: BuildParams, runtime: ReleaseCycleRuntime): Step[] {
  return p.existing ? [putReleaseStep(ports, p, runtime, "consumer-onboard:put-release")] : [triggerReleaseStep(ports, p), watchReleaseBuildStep(ports, p, runtime)];
}

/** The release run the query names, awaited to its end. Appearing is bounded: the release script's
 *  push fires the webhook within seconds, so a run that has not appeared in releaseBuildAppearMs is a
 *  finding. Finishing is not bounded — the build takes what it takes, and the operator's cancel
 *  (ctx.signal) is the only limit. A run that never appeared, a cancelled watch and a failed run are
 *  each refused with what to read. */
async function settledReleaseRun(ctx: StepCtx, buildPlane: BuildPlane, ports: BuildPorts, p: ReleaseOnStage, query: ReleaseRunQuery): Promise<ReleaseRunOutcome> {
  const outcome = await buildPlane.awaitReleaseRun(query, { appearMs: ports.releaseBuildAppearMs, signal: ctx.signal });
  const ns = `${p.consumerName}-build`;
  if (outcome === null) {
    throw errValidation(
      ctx.signal.aborted
        ? `the watch on the release PipelineRun for ${p.version}-${p.channel}-* in ${ns} was cancelled`
        : `no release PipelineRun for ${p.version}-${p.channel}-* appeared in ${ns} within ${Math.round(ports.releaseBuildAppearMs / 1000)}s — the deploy ref was pushed but the webhook fired no run; read the EventListener's log on the build plane`,
    );
  }
  if (!outcome.succeeded) {
    throw errValidation(`release PipelineRun ${ns}/${outcome.runName} (${outcome.releaseTag}) FAILED — the release cycle died in the build plane; read that run's log`);
  }
  return outcome;
}
