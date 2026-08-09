import { z } from "zod";
import type { Step, RunDefinition } from "../../../executor/types.ts";
import { errValidation } from "../../../kernel/errors.ts";
import { INSTALL_BRANCH_REGENERATOR_MISSING } from "../../../executor/guards.ts";
import { isMasterRole } from "../../../../shared/enums.ts";
import { RELEASE_CHANNEL, RELEASE_VERSION_RE, composeReleaseTag, parseReleaseTag, type ReleaseChannel } from "../../../../shared/release.ts";
import { clusterMarkingPath, resolveClusterMarking, setClusterRelease } from "../../inventory/cluster-marking.ts";
import { PRODUCT_BRANCH } from "../../../../shared/branches.ts";
import { readChannelStages, assertChannelReaches } from "../../inventory/channel-stages.ts";
import { activeClusterTarget, loadMaster, masterFqdnOf, requirePlatformRepo, type DeploySlavePorts, type SlaveTarget } from "./deploy-slave.kit.ts";
import { attestClusterStep, hostRunStep, argocdFollowStep, loadActiveCluster } from "./cluster-release.kit.ts";

// `release` — raise the platform version a cluster stands on. The third cluster verb, and the
// only one that moves a pin.
//
// A cluster release has the same shape as a unit release — version plus channel, the channel ceiling,
// mint-once, a pin rather than "whatever is current" — and differs in three ways. There is nothing to
// BUILD: the platform GitOps repo is configuration, read and not compiled, so no image and no registry
// are involved and the tag is minted here rather than by a release script in the repo. The pin sits
// elsewhere: for a unit it is an image tag inside chart values, for a cluster it is the revision the
// cluster itself stands on, stated once in clusters/active/<fqdn>.yaml. And there is a HOST step no
// unit release has, because a platform version can change the scripts that set the machine up, and
// ArgoCD cannot deliver what it runs on.
//
// It ALWAYS does all three, in order: set the pin, run the installer over SSH, let ArgoCD follow.
// There is no "did the host scripts change" switch — the installer is re-runnable by design, and a
// conditional would be a case distinction someone has to maintain and that would eventually be wrong.
// It would also make the state unprovable: a run that sometimes skips the host cannot claim the
// machine layer matches the pin.
//
// The steps are four, not three: mutating runs start with attest-target (guards.ts
// assertGuardsArmed), and that step is where the CHANNEL CEILING is checked — so a channel that may
// not reach this cluster's stage aborts before anything is minted, committed or pushed.
//
// NOTHING REGENERATES AN INSTALL BRANCH TODAY, so no release is plannable: the third of set-pin's
// three acts has no implementation, and the two steps after it read the branch that act produces —
// host-run runs the installer out of the cluster's checkout of it, argocd-follow calls Synced against
// it "the pinned state". A release that skipped the regeneration would therefore not merely do less,
// it would report a version the cluster never took. KIND_GUARDS refuses the plan
// (INSTALL_BRANCH_REGENERATOR_MISSING states what is missing and what replaces it), and set-pin throws
// the same refusal in the regeneration's place, so the verb cannot be re-enabled by lifting the gate
// alone. What it takes to bring the verb back is a regenerator for that one call site.

export const ReleaseParams = z.object({
  serverId: z.string().startsWith("srv_"),
  /** The bare version — the operator names version + channel, never a whole tag; set-pin stamps the
   *  ts14 and mints. */
  version: z.string().regex(RELEASE_VERSION_RE, "must be x.y.z with no leading zeros"),
  channel: z.enum(RELEASE_CHANNEL),
});
export type ReleaseParams = z.infer<typeof ReleaseParams>;

export type ReleasePorts = DeploySlavePorts;

/** The channel ceiling, read from the ONE table in the platform repo and checked against the stage the
 *  cluster is MARKED with — never against a stage in the params, which nobody re-states here. Runs as
 *  attest-target's own check, so the refusal lands before the pin. */
function ceilingCheck(target: SlaveTarget, channel: ReleaseChannel, version: string, ports: ReleasePorts) {
  return async (ctx: Parameters<NonNullable<Step["run"]>>[0]): Promise<void> => {
    const { domain } = target.resolve(ctx.db);
    const repo = requirePlatformRepo(ports);
    const marking = await resolveClusterMarking(repo, domain);
    const table = await readChannelStages(repo);
    assertChannelReaches(table, channel, marking.stage, `platform release ${version}-${channel}`);
    ctx.log("meta", `channel ${channel} may reach ${marking.stage} — ${marking.name} is marked ${marking.stage}${marking.release ? `, standing on ${marking.release}` : " and carries no release pin yet"}`);
  };
}

/** `set-pin`: mint the tag, state it in the cluster map, and regenerate the install branch from it.
 *  The third act has no implementation and the step throws where it stood.
 *
 *  Mint-once has two halves and both matter. The remote refuses to re-point a tag it already carries
 *  (PlatformRepo.mintTag), and this step does not even ask for a new one when the map already names a
 *  tag of the requested version and channel — so a resumed run adopts its own earlier tag instead of
 *  minting a second one for the same release and leaving the first orphaned. */
function setPinStep(target: SlaveTarget, params: ReleaseParams, ports: ReleasePorts): Step {
  return {
    name: "set-pin",
    title: "Pin the cluster to the release (mint the tag, write the map, regenerate the branch)",
    run: async (ctx) => {
      const { domain } = target.resolve(ctx.db);
      const repo = requirePlatformRepo(ports);

      const standing = (await resolveClusterMarking(repo, domain)).release;
      const parsedStanding = standing ? parseReleaseTag(standing) : null;
      const reusable = parsedStanding?.version === params.version && parsedStanding.channel === params.channel;
      const tag = reusable && standing !== undefined ? standing : composeReleaseTag(params.version, params.channel, new Date());

      // The tag is minted on the TRUNK, and only there: it names a state of the PRODUCT, and the
      // branch regeneration on the master merges refs/tags/<tag> into the install branch. A tag minted
      // on the books branch would name a commit carrying this installation's registrations, and every
      // cluster regenerated from it would inherit them.
      const minted = await repo.withBranch(PRODUCT_BRANCH, (trunk) =>
        trunk.mintTag({ tag, message: `platform release ${tag}` }),
      );
      ctx.log("meta", minted.minted
        ? `minted the platform release tag ${tag} at ${minted.commit.slice(0, 7)} on ${PRODUCT_BRANCH}`
        : `platform release tag ${tag} already stands at ${minted.commit.slice(0, 7)} — reused, never re-pointed`);

      const pin = await setClusterRelease(repo, domain, tag, ctx.runId);
      ctx.log("meta", pin.changed
        ? `${clusterMarkingPath(domain)} now states release: ${tag}`
        : `${clusterMarkingPath(domain)} already states release: ${tag} — nothing to commit`);

      ctx.checkpoint({ tag, minted: minted.minted, pinCommitted: pin.changed });
      // The third act, and the one with nothing behind it. The regeneration runs on the MASTER — the
      // host that keeps a checkout whose origin can push, and the one host every cluster's branch can
      // be regenerated from — and there is no program on it to run: the shell that did this is in no
      // repository and its ansiwise replacement is unbuilt. The plan gate refuses every release for
      // this reason, so this throw is what a run reaches only if that gate is lifted before the
      // regenerator exists, and it names the same reason.
      throw errValidation(INSTALL_BRANCH_REGENERATOR_MISSING);
    },
  };
}

function releaseSteps(params: ReleaseParams, ports: ReleasePorts): Step[] {
  const target = activeClusterTarget(params.serverId);
  return [
    attestClusterStep(target, ceilingCheck(target, params.channel, params.version, ports)),
    setPinStep(target, params, ports),
    hostRunStep(target),
    argocdFollowStep(target),
  ];
}

export function makeReleaseDef(ports: ReleasePorts): RunDefinition<ReleaseParams> {
  return {
    kind: "release",
    paramsSchema: ReleaseParams,
    mutating: true,
    plan: async (params, { db }) => {
      const { server, cluster } = loadActiveCluster(db, params.serverId);
      const master = loadMaster(db);
      const onMaster = isMasterRole(server.role);
      const stepDefs = releaseSteps(params, ports);
      return {
        kind: "release",
        targetKind: "cluster",
        targetId: cluster.id,
        summary:
          `Release platform ${params.version}-${params.channel} onto "${server.name}" (${cluster.domain}, ${cluster.stage}): ` +
          `pin the cluster map, re-run the installer over SSH, then wait for ArgoCD to converge. ` +
          `${stepDefs.length} steps${onMaster ? " on the host itself" : ` over two hosts — the slave and the master "${master.name}"`}.`,
        steps: stepDefs.map((s) => ({ name: s.name, title: s.title })),
        // The pin commit, the tag and the branch regeneration all happen on the master's side of the
        // platform repo, and argocd-follow reads a pure slave's Applications there too — so the master
        // is a declared target whenever it is not the target itself.
        targets: onMaster
          ? [{ serverId: server.id, ownsHost: true, label: `${server.name} (${server.role})` }]
          : [
            { serverId: server.id, ownsHost: true, label: `${server.name} (slave)` },
            { serverId: master.id, ownsHost: false, label: `${master.name} (master)` },
          ],
        // Every branch this run touches: the trunk, where the tag is minted; the books branch, where
        // the cluster map's pin is committed, which is the master's own install branch and is claimed
        // by name rather than left to the coincidence that the next line often names the same string;
        // and the cluster's own install branch, which is regenerated and force-pushed. Claiming the
        // master's branch twice on a master release is harmless — the lock manager dedupes.
        locks: [
          { resource: "git-branch", key: PRODUCT_BRANCH },
          { resource: "git-branch", key: masterFqdnOf(db, master) },
          { resource: "git-branch", key: cluster.domain },
          { resource: "master-kube", key: "m" },
        ],
        warnings: [
          `The installer re-runs on ${server.name} — expect a brief kube-apiserver blip while kubelite restarts.`,
          `The install branch ${cluster.domain} is regenerated from the tag and force-pushed; a machine setting that conflicts stops the run instead of being overwritten.`,
        ],
        requiredSecrets: [],
      };
    },
    steps: (params) => releaseSteps(params, ports),
  };
}
