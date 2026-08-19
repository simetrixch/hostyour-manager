import { z } from "zod";
import type { Step, StepCtx, RunDefinition } from "../../../executor/types.ts";
import { errValidation } from "../../../kernel/errors.ts";
import { isMasterRole } from "../../../../shared/enums.ts";
import { RELEASE_CHANNEL, RELEASE_VERSION_RE, composeReleaseTag, parseReleaseTag, type ReleaseChannel } from "../../../../shared/release.ts";
import { clusterMarkingPath, resolveClusterMarking, setClusterRelease } from "../../inventory/cluster-marking.ts";
import { PRODUCT_BRANCH } from "../../../../shared/branches.ts";
import { readChannelStages, assertChannelReaches } from "../../inventory/channel-stages.ts";
import { activeClusterTarget, requirePlatformRepo, type DeploySlavePorts, type SlaveTarget } from "./deploy-slave.kit.ts";
import { attestClusterStep, refreshCheckoutStep, argocdFollowStep, loadActiveCluster } from "./cluster-release.kit.ts";
import { ansiwiseProgramStep, ANSIWISE_ELEVATION_SECRET, type AnsiwisePorts, type ExtraAnswers } from "./ansiwise-run.kit.ts";

// `release` — raise the platform version a cluster stands on. The third cluster verb, and the
// only one that moves a pin.
//
// A cluster release has the same shape as a unit release — version plus channel, the channel ceiling,
// mint-once, a pin rather than "whatever is current" — and differs in three ways. There is nothing to
// BUILD: the platform GitOps repo is configuration, read and not compiled, so no image and no registry
// are involved and the tag is minted here rather than by a release script in the repo. The pin sits
// elsewhere: for a unit it is an image tag inside chart values, for a cluster it is the revision the
// cluster itself stands on, stated once in clusters/active/<fqdn>.yaml. And there is a MACHINE act no
// unit release has, because a platform version can change what sets the machine up, and ArgoCD
// cannot deliver what it runs on.
//
// It ALWAYS does all of it, in order: mint the tag and commit the pin, bring the machine's checkout
// onto that commit, regenerate the install branch AT the pin (the regenerate-branch program, on the
// machine), rebuild the machine layer from the regenerated revision (deploy-cluster, deploy-gitops —
// the exact two programs redeploy's master arm runs), then let ArgoCD follow. There is no "did the
// machine layer change" switch — every program is idempotent by design, and a conditional would be a
// case distinction someone has to maintain and that would eventually be wrong. It would also make
// the state unprovable: a run that sometimes skips the machine cannot claim the machine layer
// matches the pin.
//
// THE REGENERATION IS THE MACHINE'S OWN ACT, never re-implemented here. set-pin states the release
// in the cluster map and nothing else; regenerate-branch (digita-deploy ansiwise/programs/) then
// READS that pin off the branch itself (measure_value_in_branch_file) and merges refs/tags/<tag>
// into the branch — everything only the branch has, the books above all, is kept, and a conflict
// outside the regenerated paths stops the run with the paths named. The step before it exists
// because the program deliberately fetches nothing: refresh-checkout is what carries the pin commit
// and the tag onto the machine.
//
// MASTER ONLY, refused for a slave at plan time. The pin lives in the cluster map on the BOOKS
// branch — the install branch of the cluster holding the master role — and regenerate-branch reads
// the pin off the very branch it regenerates, out of the checkout standing on it. A slave's install
// branch deliberately carries no cluster map and no books at all (deploy-slave-branch cuts it that
// way: the books live on the master's branch, and a second copy goes stale the moment the
// Controller writes to that one), so nothing on it states a pin to regenerate at, and the master's
// checkout stands on the master's branch, not the slave's. A program that regenerates a SLAVE's
// branch at its pin — deploy-slave-branch's shape, reading the books off the master's branch — is
// not built; until it is, a slave release is refused rather than guessed at.

export const ReleaseParams = z.object({
  serverId: z.string().startsWith("srv_"),
  /** The bare version — the operator names version + channel, never a whole tag; set-pin stamps the
   *  ts14 and mints. */
  version: z.string().regex(RELEASE_VERSION_RE, "must be x.y.z with no leading zeros"),
  channel: z.enum(RELEASE_CHANNEL),
});
export type ReleaseParams = z.infer<typeof ReleaseParams>;

export interface ReleasePorts extends DeploySlavePorts, AnsiwisePorts {}

/** The programs a release drives on the machine, in the order the pinned state stands on them: the
 *  install branch regenerated at the pin, then the machine layer exactly as redeploy's master arm
 *  delivers it — the cluster below GitOps first, then what hands it over. The names are the
 *  catalogue's own (digita-deploy ansiwise/programs/); each step reads the program's declared
 *  answers off the machine, so nothing about their INSIDES is repeated here. */
const RELEASE_PROGRAMS = ["regenerate-branch", "deploy-cluster", "deploy-gitops"] as const;

/** The answers the inventory cannot state, asked for at approve and carried to the steps as
 *  `activation-input:<answer>`. committer_email is regenerate-branch's (a forge shows it beside
 *  every commit and some refuse a push without one); the letsencrypt pair is deploy-cluster's; the
 *  three optional ones may stay blank — a blank input is dropped at approve and the program's own
 *  default (or its refusal, by name) decides. build_plane is deliberately NOT here: the cluster map
 *  states it, and markingAnswers below is where the manager reads it. */
const RELEASE_INPUTS = [
  { field: "committer_email", label: "The mailbox the regenerated branch's commits are made under" },
  { field: "letsencrypt_email", label: "The mailbox the certificate authority writes to before a certificate expires" },
  { field: "letsencrypt_server", label: "The ACME directory this installation registers with (staging to rehearse, production to serve)" },
  { field: "lan_cidr", label: "The IPv4 range this machine shares with the other clusters — blank when it shares none" },
  { field: "storage_path", label: "Where the machine's separate storage is mounted — blank when it has none" },
  { field: "storage_directory", label: "The directory under that mount for the cluster's volumes — blank for the snap's default" },
];

/** The three credentials regenerate-branch demands exactly where the machine IS the build plane
 *  (its `stated_when: build_plane_is_this_machine` answers): the map decides at plan time whether
 *  they are asked for at all. Collected as SECRETS, not inputs — they are GitHub write credentials —
 *  under the `activation-input:` names composeAnswers reads operator-supplied answers from. The
 *  machine keeps them create-only (a filled key is never rewritten), so what is typed here fills a
 *  rotated-empty key and otherwise changes nothing — but the program requires a value where the
 *  predicate holds, exactly as at birth, and approve enforcing them is the same demand made earlier. */
const BUILD_PLANE_PAT_SECRETS = [
  "activation-input:build_hostyour_cloud_repo_pat",
  "activation-input:build_hostyour_manager_repo_pat",
  "activation-input:build_catalog_repo_pat",
];

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

/** `set-pin`: mint the tag and state it in the cluster map. Regenerating the branch FROM that
 *  statement is the machine's own act — the regenerate-branch step after the refresh — so this step
 *  ends where the manager's authority does: at the two git writes only it can make.
 *
 *  Mint-once has two halves and both matter. The remote refuses to re-point a tag it already carries
 *  (PlatformRepo.mintTag), and this step does not even ask for a new one when the map already names a
 *  tag of the requested version and channel — so a resumed run adopts its own earlier tag instead of
 *  minting a second one for the same release and leaving the first orphaned. */
function setPinStep(target: SlaveTarget, params: ReleaseParams, ports: ReleasePorts): Step {
  return {
    name: "set-pin",
    title: "Pin the cluster to the release (mint the tag, write the map)",
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
      ctx.log("meta", `the pin is stated — regenerate-branch reads it off ${clusterMarkingPath(domain)} on the branch and brings the branch to ${tag}`);
    },
  };
}

/** The answers the manager holds in the CLUSTER MAP and the programs declare — read per run off the
 *  books branch, never asked of the operator: an operator re-typing what stands written is how the
 *  record and the run come to disagree. regenerate-branch takes all of them; deploy-cluster takes
 *  build_plane, whose "empty means this machine" reading treats the map's self-naming form the same
 *  way (the mirror steps compare it against the fqdn answer — registry_mirror.dart hostsTheMirror).
 *  alert-recipients is the map's comma-separated mailbox list, handed on as the LIST the program
 *  declares (kind text_list) — splitting it here is the one translation, made once. The optional map
 *  fields ride only where the map states them; a required answer the map lacks is then refused by
 *  the machine BY NAME, which is the loudest sentence available for an incomplete map. */
export function markingAnswers(target: SlaveTarget, ports: ReleasePorts): ExtraAnswers {
  return async (ctx: StepCtx) => {
    const { domain } = target.resolve(ctx.db);
    const marking = await resolveClusterMarking(requirePlatformRepo(ports), domain);
    return {
      build_plane: marking.buildPlaneFqdn,
      ...(marking.unitApex !== undefined ? { unit_apex: marking.unitApex } : {}),
      ...(marking.platformDomain !== undefined ? { platform_domain: marking.platformDomain } : {}),
      ...(marking.alertRecipients !== undefined
        ? { alert_recipients: marking.alertRecipients.split(",").map((m) => m.trim()).filter((m) => m.length > 0) }
        : {}),
      ...(marking.catalogRepo !== undefined ? { catalog_repo: marking.catalogRepo } : {}),
      ...(marking.postUrl !== undefined ? { post_url: marking.postUrl } : {}),
    };
  };
}

function releaseSteps(params: ReleaseParams, ports: ReleasePorts): Step[] {
  const target = activeClusterTarget(params.serverId);
  const extra = markingAnswers(target, ports);
  return [
    attestClusterStep(target, ceilingCheck(target, params.channel, params.version, ports)),
    setPinStep(target, params, ports),
    refreshCheckoutStep(target),
    ...RELEASE_PROGRAMS.map((program) => ansiwiseProgramStep(target, program, ports, { extra })),
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
      if (!isMasterRole(server.role)) {
        throw errValidation(
          `a release names a cluster carrying the MASTER part, and "${server.name}" (${cluster.domain}) is a slave. ` +
          "The release pin lives in the cluster map on the books branch — the master's own install branch — and " +
          "regenerate-branch reads that pin off the very branch it regenerates, out of the checkout standing on it; " +
          "a slave's install branch deliberately carries no cluster map and no books at all (deploy-slave-branch cuts " +
          "it that way: the books live on the master's branch, and a second copy goes stale the moment the Controller " +
          "writes to that one), so nothing on it states a pin to regenerate at. The program that regenerates a SLAVE's " +
          "branch at its pin — deploy-slave-branch's shape, reading the books off the master's branch — is not built; " +
          "until it is, releasing a slave is refused rather than guessed at. To rebuild the slave's machine layer " +
          "without a version change, use redeploy.",
        );
      }
      // The build-plane PATs are demanded exactly where the machine will demand them: the map says
      // whether this cluster carries the build plane, and regenerate-branch's stated_when answers
      // hold or lapse on the same fact (build_plane == fqdn), so plan and machine can never disagree.
      const marking = await resolveClusterMarking(requirePlatformRepo(ports), cluster.domain);
      const stepDefs = releaseSteps(params, ports);
      return {
        kind: "release",
        targetKind: "cluster",
        targetId: cluster.id,
        summary:
          `Release platform ${params.version}-${params.channel} onto "${server.name}" (${cluster.domain}, ${cluster.stage}): ` +
          `pin the cluster map, regenerate the install branch at the pin, rebuild the machine layer from it ` +
          `(the regenerate-branch, deploy-cluster and deploy-gitops programs on the machine's own ansiwise surface), ` +
          `then wait for ArgoCD to converge. ${stepDefs.length} steps on the host itself.`,
        steps: stepDefs.map((s) => ({ name: s.name, title: s.title })),
        targets: [{ serverId: server.id, ownsHost: true, label: `${server.name} (${server.role})` }],
        // Every branch this run touches: the trunk, where the tag is minted; and the cluster's own
        // install branch — which for the master this verb releases IS the books branch the pin is
        // committed on, claimed here by the master's own domain. master-kube because argocd-follow
        // reads the master's ArgoCD.
        locks: [
          { resource: "git-branch", key: PRODUCT_BRANCH },
          { resource: "git-branch", key: cluster.domain },
          { resource: "master-kube", key: "m" },
        ],
        warnings: [
          `The machine layer re-runs on ${server.name} at the regenerated revision — expect a brief kube-apiserver blip while kubelite restarts.`,
          `The install branch ${cluster.domain} is regenerated by merging the tag into it and pushed; everything only the branch has is kept, and a conflict outside the regenerated paths stops the run with the paths named.`,
        ],
        // The programs raise their commands to root with a password the CALLER hands over per run
        // (the installation's ansiwise.yaml: password_from_caller) — collected at approve, held in
        // memory, sent with each POST /runs, persisted nowhere. The build-plane PATs ride the same
        // channel exactly when the map says this cluster builds (see BUILD_PLANE_PAT_SECRETS).
        requiredSecrets: [ANSIWISE_ELEVATION_SECRET, ...(marking.buildPlane ? BUILD_PLANE_PAT_SECRETS : [])],
        requiredInputs: RELEASE_INPUTS,
      };
    },
    steps: (params) => releaseSteps(params, ports),
  };
}
