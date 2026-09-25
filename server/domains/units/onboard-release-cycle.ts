// The onboard release-cycle steps: trigger the injected release workflow ONCE, then watch what
// lands on the PLATFORM — the build-plane release run and (for a deployable unit) the deployment
// the bump produced. Split out of onboard.run.ts like onboard-webhook.ts / onboard-release-kit.ts so
// the run file stays a thin orchestrator.
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
import type { Step } from "../../executor/types.ts";
import type { OnboardPorts, OnboardParams, DeployableOnboardParams } from "./onboard.run.ts";
import { WorkflowNotFoundError } from "../../adapters/github-consumer/port.ts";
import { parseGitHubOwnerRepo } from "./onboard-webhook.ts";
import { parseBuildPins } from "../../../shared/pin.ts";
import { syncedRevisionFor, type ArgoAppStatus } from "../../adapters/kube/port.ts";
import { errValidation } from "../../kernel/errors.ts";

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
export function triggerReleaseStep(ports: OnboardPorts, p: OnboardParams): Step {
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
              inputs: { version: p.version, channel: p.channel, stage: p.stage },
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
export function watchReleaseBuildStep(ports: OnboardPorts, p: OnboardParams, runtime: ReleaseCycleRuntime): Step {
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
      ctx.log("meta", `release PipelineRun ${ns}/${outcome.runName} Succeeded — release ${outcome.releaseTag} is built, pushed and bumped for ${p.stage}${outcome.imageTag ? ` as image tag ${outcome.imageTag}` : ""}`);
    },
  };
}

/** watch-deployment (deployable form only): the first deployment comes OUT of the release cycle —
 *  the bump wrote the minted image tag into the delivery branch's values file, and ArgoCD syncs that
 *  branch. This step reads the tag off `deploy/<stage>:<chartPath>/values-<stage>.yaml` (the file
 *  the bump wrote — read, never computed) and then waits for the generated Application to reach
 *  Synced/Healthy at that branch head. */
export function watchDeploymentStep(ports: OnboardPorts, p: DeployableOnboardParams, runtime: ReleaseCycleRuntime): Step {
  return {
    name: "watch-deployment",
    title: "Wait for the deployment the release cycle produced",
    run: async (ctx) => {
      const branch = `deploy/${p.stage}`;
      const file = `${p.chartPath}/values-${p.stage}.yaml`;
      // WHAT THE CYCLE MINTED, NEVER WHAT THE PLAN GUESSED (#246). The version in the params is what
      // the repository's release tags said when the WIZARD read them; the tag the release script
      // actually minted is the next free number when the CYCLE ran, and between the two the customer
      // may release as often as they like. swissbookai was planned at 0.1.3 and delivered 0.1.6, and
      // this step waited for a "0.1.3-stable-*" pin that could never appear. watch-release reads the
      // minted tag off the build run's own param and records it, so the truth is in hand here.
      // ON A RETRY OR A RESUME THE SIBLING STEP DOES NOT RUN AGAIN — it stands `ok`, so the runtime
      // object this run rebuilt is empty. The tag is therefore written into THIS step's own
      // checkpoint the moment it is known, which is the one record a re-entry can read back.
      const remembered = ctx.readCheckpoint<{ wanted?: string }>()?.wanted;
      const wanted = runtime.releaseTag ?? remembered;
      if (!wanted) throw errValidation("the release cycle recorded no minted tag, so nothing says which release this deployment must carry — watch-release did not run, or its param was empty");
      ctx.checkpoint({ wanted });
      const pollMs = ports.releasePollIntervalMs ?? 2_000;
      // Phase 1 — read the bump's own commit. The branch exists (the pipeline just synced it), but
      // push visibility can lag a moment, so the read is polled inside a small budget.
      const deadline = Date.now() + ports.deployRefVisibleMs;
      let head: string;
      let mintedTag: string;
      for (;;) {
        let readable = false;
        try {
          const cloned = await ports.repo.cloneAtRef({ repoURL: p.repoURL, ref: branch, credentialId: p.repoCredentialId, signal: ctx.signal });
          readable = true;
          try {
            const text = await ports.repo.readFile(cloned.workdir, file);
            const pins = text === null ? [] : parseBuildPins(`${branch}:${file}`, text);
            // Every declared build pinned at the tag THIS run's cycle minted. A build still pinned
            // at an older one means the bump did not finish; a NEWER one means somebody released
            // after us, which the log says below rather than refusing — the branch head is what the
            // Application follows either way.
            const tags = new Set(p.builds.filter((b) => pins.some((x) => x.image === b && (x.tag === wanted || x.tag.startsWith(`${wanted}-`)))).length === p.builds.length
              ? pins.filter((x) => p.builds.includes(x.image)).map((x) => x.tag)
              : []);
            if (tags.size === 1) {
              head = cloned.resolvedSha;
              mintedTag = [...tags][0]!;
              break;
            }
            if (tags.size > 1) {
              throw errValidation(`${branch}:${file} pins the declared builds at DIFFERENT tags (${[...tags].join(", ")}) — one release is one image set, so the bump can never write two; the delivery branch is corrupt`);
            }
          } finally {
            await ports.repo.dispose(cloned.workdir);
          }
        } catch (err) {
          // An unreadable branch (not yet visible) is polled; everything after a successful clone
          // rethrows — a corrupt pin grammar or a mixed-tag file will not heal by waiting.
          if (readable) throw err;
        }
        if (Date.now() >= deadline || ctx.signal.aborted) {
          throw errValidation(`${branch}:${file} does not pin every declared build at ${wanted} within the watch budget — the release run reported Succeeded but its bump commit is not visible; check the delivery branch`);
        }
        await sleep(pollMs, ctx.signal);
      }
      // The image tag is the release tag plus the commit's short sha (`<tag>-<sha7>`), so a pin that
      // extends the minted tag IS ours; anything else is a release that landed after this one.
      const ours = mintedTag === wanted || mintedTag.startsWith(`${wanted}-`);
      ctx.log(
        "meta",
        ours
          ? `the bump wrote ${mintedTag} into ${branch}:${file} (commit ${head.slice(0, 7)}) — waiting for the Application to converge on it`
          : `${branch}:${file} pins ${mintedTag} while this run's cycle minted ${wanted} — a release of this repository landed after ours; the Application is watched at the branch head, which is what it follows`,
      );
      // Phase 2 — THE DELIVERY IS WHAT THIS RUN OWES, AND SYNCED IS THE PROOF OF IT (#246). The
      // generated Application follows the delivery branch as a literal, so Synced with the
      // consumer-chart source at the bump commit says: the registration, the release cycle, the bump
      // and ArgoCD all did their part, and the cluster now runs exactly the images the customer's
      // release produced. Whether those images then come UP is the consumer repository's business —
      // a chart that cannot start, a migration that refuses, an image that crash-loops is a bug its
      // owner fixes, and holding the onboarding run red over it says the platform failed when it did
      // not. The health reached is REPORTED, in the step's log and its checkpoint, so nothing about
      // the state is hidden; it is simply not this run's verdict.
      const delivered = (s: ArgoAppStatus): boolean => s.sync === "Synced" && syncedRevisionFor(s, p.repoURL) === head;
      const serving = (s: ArgoAppStatus): boolean => delivered(s) && s.health === "Healthy";
      // A FAILED/ERRORED sync operation is terminal — nothing left to converge on — so stop the poll
      // the moment one is observed rather than waiting the whole budget out on it.
      const failedOp = (s: ArgoAppStatus): boolean => s.opPhase === "Failed" || s.opPhase === "Error";
      const { argoReader, argoNamespace } = await ports.resolver.resolve(p.clusterId);
      // Unbounded on purpose: a deployment takes what it takes (image pulls, migrations); what ends the
      // wait is Synced+Healthy, a sync operation that FAILED (fail-fast), or the operator's cancel.
      // The wait still aims at Healthy — it is the good outcome and worth waiting for — and only the
      // VERDICT below is Synced.
      const status = await argoReader.watchApplication(argoNamespace, p.argoAppName, serving, { signal: ctx.signal, failFast: failedOp });
      if (!delivered(status)) {
        throw errValidation(
          `Application ${p.argoAppName} was not Synced at ${branch}@${head.slice(0, 7)} — last seen sync=${status.sync}, health=${status.health}, phase=${status.opPhase ?? "none"}, rev=${syncedRevisionFor(status, p.repoURL) ?? "none"}${status.message ? ` (${status.message})` : ""}`,
        );
      }
      ctx.checkpoint({ wanted, mintedTag, deployedCommit: head, health: status.health });
      ctx.log(
        "meta",
        status.health === "Healthy"
          ? `Application ${p.argoAppName} is Synced + Healthy at ${head.slice(0, 7)} — the deployment carries ${mintedTag}, produced by the external release cycle`
          : `Application ${p.argoAppName} is Synced at ${head.slice(0, 7)} and carries ${mintedTag}, so the delivery is done — its health reads ${status.health}${status.message ? ` (${status.message})` : ""}, which is the consumer repository's to fix`,
      );
    },
  };
}
