import { z } from "zod";
import { eq } from "drizzle-orm";
import type { RunDefinition, Step, Plan, PlanStreamCtx, PlanStreamResult } from "../../executor/types.ts";
import { errValidation } from "../../kernel/errors.ts";
import type { Db } from "../../db/client.ts";
import { apps } from "../../db/schema/inventory.ts";
import type { CredentialStore } from "../../security/store.ts";
import { syncedRevisionFor, type ArgoAppStatus } from "../../adapters/kube/port.ts";
import { consumerArgoAppName } from "../../../shared/consumer.ts";
import { STAGE } from "../../../shared/enums.ts";
import { parseReleaseTag, RELEASE_CHANNEL, RELEASE_TAG_RE } from "../../../shared/release.ts";
import type { VersionsView } from "../../../shared/api-types.ts";
import type { ChannelStages } from "../inventory/channel-stages.ts";
import { attestTargetStep, loadAppCluster, type LifecyclePorts } from "./lifecycle.ts";
import type { BuildPorts } from "#unit/server/build-chain.ts";
import { injectReleaseKitStep } from "#unit/server/inject-release-kit.ts";
import { putReleaseStep, type ReleaseCycleRuntime } from "#unit/server/release-cycle.ts";
import type { BranchCommit, GitHubConsumer } from "#unit/server/adapters/github-consumer/port.ts";
import { parseGitHubOwnerRepo } from "#unit/server/github-repo-url.ts";
import { resolveRepoCredentialId, resolveRepoIdentity, type OwnerIdentityReader, type RepoIdentityApp } from "#unit/server/repo-identity.ts";
import { readOwnerIdentity } from "#unit/server/owners.ts";

// Put a release that stands in a repository on its stage again (hostyour-manager#299): how an app
// goes back to an earlier release, or forward to a later one that stands.
//
// ONE WRITER OF THE DELIVERY BRANCH. `deploy/<stage>`, the branch the app's Application renders,
// is placed by the platform's release pipeline alone: on the release commit plus a pin commit, once
// every image of that release exists. This run adds no second writer. It dispatches the release
// kit's `--existing` mode, which pushes the deploy ref of a release that already stands, and the
// pipeline finds the images and places the branch as it does for every release.
//
// WHAT RUNS NOW IS READ, NEVER STORED: the head of `deploy/<stage>` is the release commit or the pin
// commit on top of it, and the release tag that names that commit is the release that runs.
//
// A DOWNGRADE IS ALLOWED ON PURPOSE (the owner's constraint on #297), and the plan says it: a release
// minted before the one that runs moves the app back.
//
// mutating: true ⇒ attest-target is step 0 (guards.assertGuardsArmed).

export const SetReleaseRequest = z.object({
  appId: z.string().startsWith("app_"),
  /** The release `<x.y.z>-<channel>-<ts14>` to put on the app's stage. */
  tag: z.string().regex(RELEASE_TAG_RE),
});

/** What the steps act with, frozen at plan: the release, and the repository and identity it is
 *  dispatched through. */
export const SetReleaseParams = SetReleaseRequest.extend({
  consumerName: z.string().min(1),
  repoURL: z.string().min(1),
  repoCredentialId: z.string().min(1),
  version: z.string().min(1),
  channel: z.enum(RELEASE_CHANNEL),
  stage: z.enum(STAGE),
  /** The commit the release tag names: the delivery branch stands on it, or on its pin commit. */
  releaseCommit: z.string().regex(/^[0-9a-f]{40}$/),
});
export type SetReleaseParams = z.infer<typeof SetReleaseParams>;

export interface SetReleasePorts extends LifecyclePorts {
  /** The release kit, the workflow dispatch and the build plane — the ports every release cycle
   *  runs on. */
  build: BuildPorts;
  /** The reads of the repository: its tags, and the head of the delivery branch. */
  github: Pick<GitHubConsumer, "listReleaseTags" | "readBranchCommit">;
  /** The sealed credentials the owner's identity is opened from (repo-identity.ts). */
  store: Pick<CredentialStore, "open" | "list">;
}

/** The repository the app was created from, and the one its releases are tagged in. */
function repoUrlOf(db: Db, appId: string): string {
  const row = db.select({ repoUrl: apps.repoUrl }).from(apps).where(eq(apps.id, appId)).get();
  if (!row?.repoUrl) throw errValidation(`app ${appId} records no repository URL — nothing says where its releases are tagged`);
  return row.repoUrl;
}

/** The release a delivery branch head carries: the release tag naming the head itself, or naming the
 *  commit the pin commit was made on top of. */
function releaseAt(head: BranchCommit | null, releases: readonly { tag: string; commit: string }[]): string | null {
  if (!head) return null;
  return releases.find((r) => r.commit === head.sha)?.tag ?? releases.find((r) => head.parents.includes(r.commit))?.tag ?? null;
}

/** The repository's releases, newest first, and the one that runs on the stage now. */
async function readReleases(ports: Pick<SetReleasePorts, "github" | "store" | "githubApp">, owners: OwnerIdentityReader, repoURL: string, stage: string, signal?: AbortSignal): Promise<{ releases: { tag: string; commit: string }[]; running: string | null }> {
  const { owner, repo } = parseGitHubOwnerRepo(repoURL);
  const identity = await resolveRepoIdentity({ repoURL, ...(ports.githubApp ? { githubApp: ports.githubApp as RepoIdentityApp } : {}), owners, store: ports.store, ...(signal ? { signal } : {}) });
  const read = { owner, repo, token: identity.token, ...(signal ? { signal } : {}) };
  const releases = (await ports.github.listReleaseTags(read))
    .filter((t) => parseReleaseTag(t.name) !== null)
    .map((t) => ({ tag: t.name, commit: t.commit }))
    .sort((a, b) => parseReleaseTag(b.tag)!.ts14.localeCompare(parseReleaseTag(a.tag)!.ts14));
  const head = await ports.github.readBranchCommit({ ...read, branch: `deploy/${stage}` });
  return { releases, running: releaseAt(head, releases) };
}

/** Whether `tag` was minted before `running`: the ts14 orders releases whatever their x.y.z says. */
const mintedBefore = (tag: string, running: string | null): boolean =>
  running !== null && parseReleaseTag(tag)!.ts14 < parseReleaseTag(running)!.ts14;

/** What the Versions dialog offers for one app, read as the plan reads it: its repository is one part,
 *  and a release on a channel that does not reach the app's stage is left out, as the plan refuses it. */
export async function readConsumerVersions(
  ports: Pick<SetReleasePorts, "github" | "store" | "githubApp"> & { channelStages: () => Promise<ChannelStages> },
  db: Db,
  appId: string,
  signal?: AbortSignal,
): Promise<VersionsView> {
  const ac = loadAppCluster(db, appId);
  const { releases, running } = await readReleases(ports, (org) => readOwnerIdentity(db, org), repoUrlOf(db, appId), ac.stage, signal);
  const channels = await ports.channelStages();
  const reachesStage = (tag: string): boolean => (channels[parseReleaseTag(tag)!.channel] ?? []).includes(ac.stage);
  return {
    stage: ac.stage,
    parts: [{
      name: ac.name,
      builds: [],
      running: running ? [running] : [],
      versions: releases.filter((r) => reachesStage(r.tag)).map((r) => ({ tag: r.tag, older: mintedBefore(r.tag, running) })),
    }],
  };
}

/** watch-delivery: the delivery branch stands on the release, and the Application has synced it. The
 *  pipeline places the branch before its run succeeds, so one read after put-release answers; the
 *  Application is then followed until it is Synced at that head. Synced is the verdict and the health
 *  is reported, as the first delivery reports it: whether the images come up is the repository's business. */
function watchDeliveryStep(ports: SetReleasePorts, p: SetReleaseParams): Step {
  const app = consumerArgoAppName(p.consumerName, p.stage);
  return {
    name: "watch-delivery",
    title: `Wait until ${app} is Synced on ${p.tag}`,
    run: async (ctx) => {
      const { owner, repo } = parseGitHubOwnerRepo(p.repoURL);
      const pat = await ctx.creds.open(p.repoCredentialId, { purpose: "set-release:watch-delivery", runId: ctx.runId });
      let head: BranchCommit | null;
      try {
        head = await ports.github.readBranchCommit({ owner, repo, branch: `deploy/${p.stage}`, token: pat.toString("utf8"), signal: ctx.signal });
      } finally {
        pat.fill(0);
      }
      if (!head || (head.sha !== p.releaseCommit && !head.parents.includes(p.releaseCommit))) {
        throw errValidation(`deploy/${p.stage} of ${p.repoURL} stands on ${head ? head.sha.slice(0, 7) : "nothing"}, not on ${p.tag} (${p.releaseCommit.slice(0, 7)}) — the release run succeeded but did not place the branch; read its bump`);
      }
      const at = head.sha;
      const delivered = (s: ArgoAppStatus): boolean => s.sync === "Synced" && syncedRevisionFor(s, p.repoURL) === at;
      const serving = (s: ArgoAppStatus): boolean => delivered(s) && s.health === "Healthy";
      const failedOp = (s: ArgoAppStatus): boolean => s.opPhase === "Failed" || s.opPhase === "Error";
      const ac = loadAppCluster(ctx.db, p.appId);
      const { argoReader, argoNamespace } = await ports.resolver.resolve(ac.clusterId);
      const status = await argoReader.watchApplication(argoNamespace, app, serving, { signal: ctx.signal, failFast: failedOp });
      if (!delivered(status)) {
        throw errValidation(`Application ${app} was not Synced at deploy/${p.stage}@${at.slice(0, 7)} — last seen sync=${status.sync}, health=${status.health}, phase=${status.opPhase ?? "none"}, rev=${syncedRevisionFor(status, p.repoURL) ?? "none"}${status.message ? ` (${status.message})` : ""}`);
      }
      ctx.checkpoint({ deployedCommit: at, health: status.health });
      ctx.log("meta", `Application ${app} is Synced at ${at.slice(0, 7)} and runs ${p.tag}; its health reads ${status.health}${status.message ? ` (${status.message})` : ""}`);
    },
  };
}

function setReleaseSteps(ports: SetReleasePorts, p: SetReleaseParams): Step[] {
  const runtime: ReleaseCycleRuntime = {};
  return [
    attestTargetStep(ports, p.appId),
    // The current kit first: the `--existing` input exists only in a kit that carries it.
    injectReleaseKitStep(ports.build, p),
    putReleaseStep(ports.build, p, runtime),
    watchDeliveryStep(ports, p),
  ];
}

export function makeSetReleaseDef(ports: SetReleasePorts): RunDefinition<SetReleaseParams> {
  return {
    kind: "consumer-set-release",
    paramsSchema: SetReleaseParams,
    mutating: true,
    plan: () => {
      throw new Error("consumer-set-release is planned via planStream (the repository is read first), not plan()");
    },
    planStream: async (rawParams, ctx: PlanStreamCtx): Promise<PlanStreamResult<SetReleaseParams>> => {
      const req = SetReleaseRequest.parse(rawParams);
      const ac = loadAppCluster(ctx.db, req.appId);
      const repoURL = repoUrlOf(ctx.db, req.appId);
      const refused = (why: string): PlanStreamResult<SetReleaseParams> => ({ outcome: "rejected", summary: `${req.tag} cannot be put on ${ac.stage} for "${ac.name}" — ${why}`, planJson: { consumerName: ac.name } });
      const release = parseReleaseTag(req.tag)!;
      const reaches = (await ports.build.channelStages())[release.channel] ?? [];
      if (!reaches.includes(ac.stage)) return refused(`the ${release.channel} channel reaches ${reaches.join(", ") || "no stage"} (global.channelStages), and the pipeline pins no release above its channel's ceiling`);
      const owners = (org: string) => readOwnerIdentity(ctx.db, org);
      const { releases, running } = await readReleases(ports, owners, repoURL, ac.stage, ctx.signal);
      const chosen = releases.find((r) => r.tag === req.tag);
      if (!chosen) return refused(`${repoURL} carries no release tag ${req.tag}`);
      if (running === req.tag) return refused(`it runs ${req.tag} already`);
      const repoCredentialId = await resolveRepoCredentialId({ repoURL, ...(ports.githubApp ? { githubApp: ports.githubApp } : {}), owners, store: ports.store, signal: ctx.signal });
      const params: SetReleaseParams = {
        appId: req.appId, tag: req.tag, consumerName: ac.name, repoURL, repoCredentialId,
        version: release.version, channel: release.channel, stage: ac.stage, releaseCommit: chosen.commit,
      };
      const downgrade = mintedBefore(req.tag, running);
      const stepDefs = setReleaseSteps(ports, params);
      const plan: Plan = {
        kind: "consumer-set-release",
        targetKind: "app",
        targetId: req.appId,
        summary:
          `Put release ${req.tag} of "${ac.name}" on ${ac.stage} (${ac.domain}), where ${running ?? "no release of this repository"} runs now: ` +
          `the release workflow puts the existing release on the stage again and mints nothing, the platform's release run places deploy/${ac.stage} on it with its pins, ` +
          `and the run waits until the Application is Synced there.${downgrade ? ` Downgrade: ${req.tag} is older than ${running}.` : ""}`,
        steps: stepDefs.map((s) => ({ name: s.name, title: s.title })),
        targets: [],
        locks: [{ resource: "master-kube", key: "m" }],
        warnings: downgrade ? [`downgrade: "${ac.name}" goes back from ${running} to ${req.tag} — only the release moves back; a database the newer release migrated stays migrated, and the older release must run on it`] : [],
        requiredSecrets: [],
      };
      return { outcome: "planned", params, plan };
    },
    steps: (params) => setReleaseSteps(ports, params),
  };
}
