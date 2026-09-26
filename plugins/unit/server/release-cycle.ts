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
import type { Step } from "#core/server/executor/types.ts";
import type { BuildPorts, BuildParams } from "./build-chain.ts";
import { WorkflowNotFoundError } from "./adapters/github-consumer/port.ts";
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
 *  external start of the release cycle, and the test of the injection that preceded it. A 404 is
 *  retried inside a bounded budget: the workflow was committed moments ago and GitHub indexes it with
 *  a small lag. A 422 (the workflow refuses the inputs — an old kit, or no dispatch trigger) and a
 *  403 surface GitHub's own message IMMEDIATELY: waiting cannot heal either. */
export function triggerReleaseStep(ports: BuildPorts, p: BuildParams): Step {
  return {
    name: "trigger-release",
    title: "Trigger the injected release workflow",
    run: async (ctx) => {
      if (!ports.github) {
        throw errValidation(`onboard "${p.consumerName}" requires the GitHub client to trigger the release workflow but none is wired on this manager — the release cycle cannot start`);
      }
      const { owner, repo } = parseGitHubOwnerRepo(p.repoURL);
      const retry = ports.dispatchRetry ?? { budgetMs: 60_000, intervalMs: 5_000 };
      const pat = await ctx.creds.open(p.repoCredentialId, { purpose: "consumer-onboard:trigger-release", runId: ctx.runId });
      try {
        const token = pat.toString("utf8");
        const ref = await ports.github.getDefaultBranch({ owner, repo, token, signal: ctx.signal });
        const deadline = Date.now() + retry.budgetMs;
        for (;;) {
          try {
            await ports.github.dispatchWorkflow({
              owner, repo, token,
              workflowFile: RELEASE_WORKFLOW_FILE,
              ref,
              // `target` only where it is build: a kit older than #289 refuses an input it does not declare.
              inputs: { version: p.version, channel: p.channel, stage: p.stage, ...(p.target === "build" ? { target: "build" } : {}) },
              signal: ctx.signal,
            });
            break;
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
      ctx.checkpoint({ workflow: RELEASE_WORKFLOW_FILE, version: p.version, channel: p.channel, stage: p.stage });
      ctx.log("meta", `release workflow dispatched on ${owner}/${repo} — ${RELEASE_WORKFLOW_FILE} with version=${p.version} channel=${p.channel} stage=${p.stage}; the cycle now runs outside the manager`);
    },
  };
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
      // Appearing is bounded: the release script's push fires the webhook within seconds, so a run
      // that has not appeared in releaseBuildAppearMs is a finding. Finishing is not bounded — the
      // build takes what it takes, and the operator's cancel (ctx.signal) is the only limit.
      const outcome = await ports.buildPlane.awaitReleaseRun(
        { unit: p.consumerName, version: p.version, channel: p.channel },
        { appearMs: ports.releaseBuildAppearMs, signal: ctx.signal },
      );
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
      runtime.releaseTag = outcome.releaseTag;
      runtime.imageTag = outcome.imageTag;
      ctx.checkpoint({ pipelineRun: outcome.runName, releaseTag: outcome.releaseTag, ...(outcome.imageTag ? { imageTag: outcome.imageTag } : {}) });
      ctx.log("meta", `release PipelineRun ${ns}/${outcome.runName} Succeeded — release ${outcome.releaseTag} is built, pushed and ${p.target === "build" ? "left unpinned" : "bumped"} for ${p.stage}${outcome.imageTag ? ` as image tag ${outcome.imageTag}` : ""}`);
    },
  };
}
