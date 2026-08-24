// The onboard release-cycle steps: trigger the injected release workflow ONCE, then
// watch — the workflow run, the build-plane release run, and (for a deployable unit) the deployment
// the bump produced. Split out of onboard.run.ts like onboard-webhook.ts / onboard-release-kit.ts so
// the run file stays a thin orchestrator.
//
// The manager has no task in the release cycle — it only triggers and reads. Everything the
// cycle produces is read back, never computed: the release tag comes off the PipelineRun's own
// release-tag param, and the image tag a deployment carries comes off the values file the bump task
// committed to the delivery branch. Triggering through the INJECTED workflow is simultaneously the
// proof of the injection: a broken kit produces no run, and the watch fails visibly.
import type { Step } from "../../executor/types.ts";
import type { OnboardPorts, OnboardParams, DeployableOnboardParams } from "./onboard.run.ts";
import { WorkflowNotFoundError, type WorkflowRunSummary } from "../../adapters/github-consumer/port.ts";
import { parseGitHubOwnerRepo } from "./onboard-webhook.ts";
import { parseBuildPins } from "../../../shared/pin.ts";
import { syncedRevisionFor, type ArgoAppStatus } from "../../adapters/kube/port.ts";
import { errValidation } from "../../kernel/errors.ts";

/** The workflow file the release kit injects — the one trigger-release dispatches. */
export const RELEASE_WORKFLOW_FILE = "release.yml";

/** The run-name the kit's workflow stamps ("Release ${{ inputs.version }}-${{ inputs.channel }}") —
 *  what listWorkflowRuns reports as displayTitle, and therefore the correlation key. */
export function releaseRunTitle(version: string, channel: string): string {
  return `Release ${version}-${channel}`;
}

/** In-run memory the release-cycle steps share within ONE execute() pass (the seed-secrets/activate
 *  precedent). `triggeredAtIso` bounds the correlation window so an OLD run of the same
 *  version+channel is never adopted as this onboarding's proof; `releaseTag` is the FULL minted tag
 *  read off the build run's param. Both are lost on a crash-resume — the watches then run without
 *  the window (the ambiguity abort still protects the correlation) and re-read the tag. */
export interface ReleaseCycleRuntime {
  triggeredAtIso?: string | undefined;
  releaseTag?: string | undefined;
}

/** The margin subtracted from the local clock for the correlation window: GitHub stamps created_at
 *  on ITS clock, so a small skew must never push the just-dispatched run out of the window. */
const TRIGGER_WINDOW_SKEW_MS = 30_000;

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
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
export function triggerReleaseStep(ports: OnboardPorts, p: OnboardParams, runtime: ReleaseCycleRuntime): Step {
  return {
    name: "trigger-release",
    title: "Trigger the injected release workflow",
    run: async (ctx) => {
      if (!ports.github) {
        throw errValidation(`onboard "${p.consumerName}" requires the GitHub client to trigger the release workflow but none is wired on this manager — the release cycle cannot start`);
      }
      const { owner, repo } = parseGitHubOwnerRepo(p.repoURL);
      const retry = ports.dispatchRetry ?? { budgetMs: 60_000, intervalMs: 5_000 };
      const pat = await ctx.creds.open(p.repoCredentialId, { purpose: "onboard:trigger-release", runId: ctx.runId });
      try {
        const token = pat.toString("utf8");
        const ref = await ports.github.getDefaultBranch({ owner, repo, token, signal: ctx.signal });
        runtime.triggeredAtIso = new Date(Date.now() - TRIGGER_WINDOW_SKEW_MS).toISOString();
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

/** watch-release-workflow: find THE run the trigger fired — by the kit's run-name (releaseRunTitle)
 *  inside the trigger's time window — and follow it to completion. Ambiguity aborts: two runs with
 *  this onboarding's title inside the window mean the correlation cannot name ITS run, and guessing
 *  would attach the onboarding's verdict to somebody else's release. */
export function watchReleaseWorkflowStep(ports: OnboardPorts, p: OnboardParams, runtime: ReleaseCycleRuntime): Step {
  return {
    name: "watch-release-workflow",
    title: "Watch the release workflow run to completion",
    run: async (ctx) => {
      if (!ports.github) {
        throw errValidation(`onboard "${p.consumerName}" requires the GitHub client to watch the release workflow but none is wired on this manager`);
      }
      const { owner, repo } = parseGitHubOwnerRepo(p.repoURL);
      const title = releaseRunTitle(p.version, p.channel);
      const pollMs = ports.releasePollIntervalMs ?? 2_000;
      const deadline = Date.now() + ports.releaseWorkflowTimeoutMs;
      const pat = await ctx.creds.open(p.repoCredentialId, { purpose: "onboard:watch-release-workflow", runId: ctx.runId });
      try {
        const token = pat.toString("utf8");
        // Phase 1 — correlate: the runs created inside the window whose display title is this
        // release's. The workflow run appears a moment after the dispatch, so an empty list is
        // polled, not failed.
        let found: WorkflowRunSummary;
        for (;;) {
          const runs = await ports.github.listWorkflowRuns({
            owner, repo, token, workflowFile: RELEASE_WORKFLOW_FILE,
            ...(runtime.triggeredAtIso ? { createdAfter: runtime.triggeredAtIso } : {}),
            signal: ctx.signal,
          });
          const matches = runs.filter((r) => r.displayTitle === title);
          if (matches.length > 1) {
            throw errValidation(
              `cannot correlate the release run: ${matches.length} workflow runs titled "${title}" exist inside the trigger window (${matches.map((m) => m.htmlUrl).join(", ")}) — refusing to guess which one this onboarding fired`,
            );
          }
          const first = matches[0];
          if (first !== undefined) {
            found = first;
            break;
          }
          if (Date.now() >= deadline || ctx.signal.aborted) {
            throw errValidation(`no workflow run titled "${title}" appeared on ${owner}/${repo} within the watch budget — the dispatch was accepted but nothing ran; check the repo's Actions page`);
          }
          await sleep(pollMs, ctx.signal);
        }
        ctx.log("meta", `release run correlated — "${found.displayTitle}" (${found.htmlUrl})`);
        // Phase 2 — follow it to completion and judge the conclusion.
        let run = found;
        while (run.status !== "completed") {
          if (Date.now() >= deadline || ctx.signal.aborted) {
            throw errValidation(`release run "${title}" did not complete within the watch budget — last status ${run.status} (${run.htmlUrl})`);
          }
          await sleep(pollMs, ctx.signal);
          run = await ports.github.getWorkflowRun({ owner, repo, token, runId: found.id, signal: ctx.signal });
        }
        if (run.conclusion !== "success") {
          throw errValidation(`release run "${title}" completed with conclusion "${run.conclusion ?? "none"}" — the release cycle failed in the repo's own workflow, see ${run.htmlUrl}`);
        }
        ctx.checkpoint({ workflowRunId: run.id, htmlUrl: run.htmlUrl, conclusion: run.conclusion });
        ctx.log("meta", `release run "${title}" completed with conclusion success — the release tag and its deploy ref are pushed`);
      } finally {
        pat.fill(0);
      }
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
      const outcome = await ports.buildPlane.awaitReleaseRun(
        { unit: p.consumerName, version: p.version, channel: p.channel, ...(runtime.triggeredAtIso ? { sinceIso: runtime.triggeredAtIso } : {}) },
        { timeoutMs: ports.releaseBuildTimeoutMs, signal: ctx.signal },
      );
      const ns = `${p.consumerName}-build`;
      if (outcome === null) {
        throw errValidation(
          `no release PipelineRun for ${p.version}-${p.channel}-* settled in ${ns} within the watch budget — the deploy ref was pushed but the webhook fired no run (or it is still going); check the EventListener and the ${ns} namespace`,
        );
      }
      if (!outcome.succeeded) {
        throw errValidation(`release PipelineRun ${ns}/${outcome.runName} (${outcome.releaseTag}) FAILED — the release cycle died in the build plane; read that run's log`);
      }
      runtime.releaseTag = outcome.releaseTag;
      ctx.checkpoint({ pipelineRun: outcome.runName, releaseTag: outcome.releaseTag });
      ctx.log("meta", `release PipelineRun ${ns}/${outcome.runName} Succeeded — release ${outcome.releaseTag} is built, pushed and bumped for ${p.stage}`);
    },
  };
}

/** watch-deployment (deployable form only): the first deployment comes OUT of the release cycle —
 *  the bump wrote the minted image tag into the delivery branch's values file, and ArgoCD syncs that
 *  branch. This step reads the tag off `deploy/<stage>:<chartPath>/values-<stage>.yaml` (the file
 *  the bump wrote — read, never computed) and then waits for the generated Application to reach
 *  Synced/Healthy at that branch head. */
export function watchDeploymentStep(ports: OnboardPorts, p: DeployableOnboardParams): Step {
  return {
    name: "watch-deployment",
    title: "Wait for the deployment the release cycle produced",
    run: async (ctx) => {
      const branch = `deploy/${p.stage}`;
      const file = `${p.chartPath}/values-${p.stage}.yaml`;
      const wanted = `${p.version}-${p.channel}-`;
      const pollMs = ports.releasePollIntervalMs ?? 2_000;
      // Phase 1 — read the bump's own commit. The branch exists (the pipeline just synced it), but
      // push visibility can lag a moment, so the read is polled inside a small budget.
      const deadline = Date.now() + ports.releaseWorkflowTimeoutMs;
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
            const tags = new Set(p.builds.filter((b) => pins.some((x) => x.image === b && x.tag.startsWith(wanted))).length === p.builds.length
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
          throw errValidation(`${branch}:${file} does not pin every declared build at a ${wanted}* tag within the watch budget — the release run reported Succeeded but its bump commit is not visible; check the delivery branch`);
        }
        await sleep(pollMs, ctx.signal);
      }
      ctx.log("meta", `the bump wrote ${mintedTag} into ${branch}:${file} (commit ${head.slice(0, 7)}) — waiting for the Application to converge on it`);
      // Phase 2 — the generated Application follows the delivery branch as a literal; it is deployed
      // once it reads Synced/Healthy with the consumer-chart source at the bump commit.
      const synced = (s: ArgoAppStatus): boolean =>
        s.sync === "Synced" && s.health === "Healthy" && syncedRevisionFor(s, p.repoURL) === head;
      // A FAILED/ERRORED sync operation is terminal — nothing left to converge on — so stop the poll
      // the moment one is observed rather than waiting the whole budget out on it.
      const failedOp = (s: ArgoAppStatus): boolean => s.opPhase === "Failed" || s.opPhase === "Error";
      const { argoReader, argoNamespace } = await ports.resolver.resolve(p.clusterId);
      const status = await argoReader.watchApplication(argoNamespace, p.argoAppName, synced, { timeoutMs: ports.argoWatchTimeoutMs, signal: ctx.signal, failFast: failedOp });
      if (!synced(status)) {
        throw errValidation(
          `Application ${p.argoAppName} did not reach Synced/Healthy at ${branch}@${head.slice(0, 7)} — last seen sync=${status.sync}, health=${status.health}, phase=${status.opPhase ?? "none"}, rev=${syncedRevisionFor(status, p.repoURL) ?? "none"}${status.message ? ` (${status.message})` : ""}`,
        );
      }
      ctx.checkpoint({ mintedTag, deployedCommit: head });
      ctx.log("meta", `Application ${p.argoAppName} is Synced + Healthy at ${head.slice(0, 7)} — the deployment carries ${mintedTag}, produced by the external release cycle`);
    },
  };
}
