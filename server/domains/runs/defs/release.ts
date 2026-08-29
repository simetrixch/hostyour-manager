import { z } from "zod";
import { eq } from "drizzle-orm";
import type { Step, StepCtx, RunDefinition } from "../../../executor/types.ts";
import type { Db } from "../../../db/client.ts";
import { servers } from "../../../db/schema/inventory.ts";
import { isMasterRole } from "../../../../shared/enums.ts";
import { RELEASE_CHANNEL, RELEASE_VERSION_RE, composeReleaseTag, parseReleaseTag, type ReleaseChannel } from "../../../../shared/release.ts";
import { resolveClusterMarking, setClusterRelease } from "../../inventory/cluster-marking.ts";
import { clusterMapPath } from "../../../../shared/cluster-values.ts";
import { PRODUCT_BRANCH } from "../../../../shared/branches.ts";
import { readChannelStages, assertChannelReaches } from "../../inventory/channel-stages.ts";
import { activeClusterTarget, loadMaster, masterFqdnOf, requirePlatformRepo, type DeploySlavePorts, type SlaveTarget } from "./deploy-slave.kit.ts";
import { attestClusterStep, refreshCheckoutStep, prepareRegenerationStep, argocdFollowStep, loadActiveCluster } from "./cluster-release.kit.ts";
import { slaveMachineAnswers, SLAVE_INSTALL_INPUTS } from "./deploy-slave.ts";
import {
  ansiwiseProgramStep, requireProgramsStep, ANSIWISE_ELEVATION_SECRET,
  type AnsiwisePorts, type ExtraAnswers, type ProgramOnSurface,
} from "./ansiwise-run.kit.ts";

// `release` — raise the platform version a cluster stands on. The third cluster run kind, and the
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
// It ALWAYS does all of it, in order: prove the catalogue carries every program it will drive, mint
// the tag and commit the pin, bring the checkout the regeneration reads onto that commit, regenerate
// the install branch AT the pin, rebuild the machine layer from the regenerated revision
// (deploy-cluster, deploy-platform-services — the exact two programs redeploy's master arm runs), then let
// ArgoCD follow. There is no "did the machine layer change" switch — every program is idempotent by
// design, and a conditional would be a case distinction someone has to maintain and that would
// eventually be wrong. It would also make the state unprovable: a run that sometimes skips the
// machine cannot claim the machine layer matches the pin.
//
// THE REGENERATION IS THE MACHINE'S OWN ACT, never re-implemented here. set-pin states the release
// in the cluster map and nothing else; the regeneration program (digita-deploy ansiwise/programs/)
// then READS that pin off a branch (measure_value_in_branch_file) and merges refs/tags/<tag> into
// the branch it regenerates — everything only that branch has, the books above all, is kept, and a
// conflict outside the regenerated paths stops the run with the paths named. The step before it
// exists because the program deliberately fetches nothing: a checkout step is what carries the pin
// commit and the tag onto the machine.
//
// TWO ARMS, decided by the role, because a cluster's pin and its branch are not always on the same
// machine:
//   master, master+   regenerate-branch, on the cluster's own host. The pin stands in the map on the
//     slave           BOOKS branch, which for this cluster IS its own install branch, so the program
//                     reads the pin off the very branch it regenerates, out of the checkout standing
//                     on it. refresh-checkout brings that one checkout onto the pin commit.
//   pure slave        regenerate-slave-branch, ON THE MASTER. A slave's install branch deliberately
//                     carries no cluster map and no books at all (deploy-slave-branch cuts it that
//                     way: the books live on the master's branch, and a second copy goes stale the
//                     moment the Manager writes to that one), so the slave's pin stands on the
//                     MASTER's branch under the SLAVE's name — two names that come apart, which is
//                     what measure_value_in_branch_file's run_answer slot fills. The program reads
//                     that map out of the master's live checkout and merges into a second checkout
//                     there, standing on the slave's branch; prepare-regeneration stands both, and
//                     the SLAVE's own checkout is refreshed after the regeneration, onto the branch
//                     head it just pushed.
//
// THE PIN IS COMMITTED ONLY AFTER THE RUN CAN NO LONGER FAIL ON AN ABSENT PROGRAM. set-pin makes the
// two git writes and the machine's turn comes several steps later, so a catalogue that does not carry
// the regeneration program would leave the map recording a cluster standing on a release it never
// received — which is exactly what cluster-marking.ts's `release` field exists to make impossible.
// require-programs asks every surface for its program list BEFORE set-pin, which is why the two steps
// stand in that order and not the other one.

export const ReleaseParams = z.object({
  serverId: z.string().startsWith("srv_"),
  /** The bare version — the operator names version + channel, never a whole tag; set-pin stamps the
   *  ts14 and mints. */
  version: z.string().regex(RELEASE_VERSION_RE, "must be x.y.z with no leading zeros"),
  channel: z.enum(RELEASE_CHANNEL),
});
export type ReleaseParams = z.infer<typeof ReleaseParams>;

/** `db` is NOT optional, for the reason redeploy's ports carry one: which arm a release runs is a
 *  question about the target's ROLE, and a definition's steps() is handed the persisted params and no
 *  database. */
export interface ReleasePorts extends DeploySlavePorts, AnsiwisePorts {
  db: Db;
}

/** The programs a release drives, in the order the pinned state stands on them: the install branch
 *  regenerated at the pin, then the machine layer exactly as redeploy's master arm delivers it — the
 *  cluster below GitOps first, then what hands it over. The names are the catalogue's own
 *  (digita-deploy ansiwise/programs/); each step reads the program's declared answers off the
 *  machine, so nothing about their INSIDES is repeated here.
 *
 *  The two lists differ in ONE entry and in WHERE it runs: a slave's regeneration is the master's
 *  act, on the master's surface, because that is where the slave's pin and the slave's books stand.
 *  The two machine-layer programs are the slave's own either way — a machine layer is delivered on
 *  the machine it belongs to. */
const MASTER_RELEASE_PROGRAMS: readonly ProgramOnSurface[] = [
  { program: "regenerate-branch" },
  { program: "deploy-cluster" },
  { program: "deploy-platform-services" },
];
const SLAVE_RELEASE_PROGRAMS: readonly ProgramOnSurface[] = [
  { program: "regenerate-slave-branch", onMaster: true },
  { program: "deploy-cluster" },
  { program: "deploy-platform-services" },
];

/** The answers the inventory cannot state, asked for at approve and carried to the steps as
 *  `activation-input:<answer>`. committer_email is regenerate-branch's (a forge shows it beside
 *  every commit and some refuse a push without one); the letsencrypt pair is deploy-cluster's; the
 *  three optional ones may stay blank — a blank input is dropped at approve and the program's own
 *  default (or its refusal, by name) decides. build_plane_fqdn is deliberately NOT here: the cluster map
 *  states it, and markingAnswers below is where the manager reads it.
 *
 *  The SLAVE arm asks deploy-slave's own list instead (SLAVE_INSTALL_INPUTS): the same machine-layer
 *  inputs plus the branch program's committer identity, which is what its three programs declare
 *  between them — and it names no build plane, because a slave's map states one. */
const RELEASE_INPUTS = [
  { field: "committer_email", label: "The mailbox the regenerated branch's commits are made under" },
  { field: "letsencrypt_email", label: "The mailbox the certificate authority writes to before a certificate expires" },
  { field: "letsencrypt_server", label: "The ACME directory this installation registers with — the authority's production one; a staging directory is refused, because its root is in no machine's trust store" },
  { field: "lan_cidr", label: "The IPv4 range this machine shares with the other clusters — blank when it shares none", optional: true },
  { field: "storage_mount", label: "Where the machine's separate storage is mounted — blank when it has none", optional: true },
  { field: "storage_subdirectory", label: "The directory under that mount for the cluster's volumes — blank for the snap's default", optional: true },
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
        ? `${clusterMapPath(domain)} now states release: ${tag}`
        : `${clusterMapPath(domain)} already states release: ${tag} — nothing to commit`);

      ctx.checkpoint({ tag, minted: minted.minted, pinCommitted: pin.changed });
      ctx.log("meta", `the pin is stated — the regeneration reads it off ${clusterMapPath(domain)} and brings ${domain}'s branch to ${tag}`);
    },
  };
}

/** The answers the manager holds in the CLUSTER MAP and the programs declare — read per run off the
 *  books branch, never asked of the operator: an operator re-typing what stands written is how the
 *  record and the run come to disagree. regenerate-branch takes all of them; deploy-cluster takes
 *  build_plane_fqdn, whose "empty means this machine" reading treats the map's self-naming form the same
 *  way (the mirror steps compare it against the fqdn answer — registry_mirror.dart hostsTheMirror).
 *  alert-recipients is the map's comma-separated mailbox list, handed on as the LIST the program
 *  declares (kind text_list) — splitting it here is the one translation, made once. The optional map
 *  fields ride only where the map states them; a required answer the map lacks is then refused by
 *  the machine BY NAME, which is the loudest sentence available for an incomplete map. */
export function markingAnswers(target: SlaveTarget, ports: DeploySlavePorts): ExtraAnswers {
  return async (ctx: StepCtx) => {
    const { domain } = target.resolve(ctx.db);
    const marking = await resolveClusterMarking(requirePlatformRepo(ports), domain);
    return {
      build_plane_fqdn: marking.buildPlaneFqdn,
      ...(marking.unitApex !== undefined ? { unit_apex: marking.unitApex } : {}),
      ...(marking.platformDomain !== undefined ? { platform_domain: marking.platformDomain } : {}),
      ...(marking.alertRecipients !== undefined ? { alert_recipients: marking.alertRecipients } : {}),
      ...(marking.catalogRepo !== undefined ? { catalog_repo: marking.catalogRepo } : {}),
      ...(marking.mailUrl !== undefined ? { mail_url: marking.mailUrl } : {}),
    };
  };
}

/** WHICH arm a server earns. An UNRESOLVABLE server is not an error path: the boot check calls
 *  steps({}) with no params at all, purely to assert that step 0 is attest-target, and on that
 *  question the two arms agree — so it gets the master shape, and a real run, which always names a
 *  server, gets the arm that server's role earns. */
function releasesOnMaster(db: Db, serverId: string): boolean {
  const role = db.select({ role: servers.role }).from(servers).where(eq(servers.id, serverId)).get()?.role;
  return role === undefined || isMasterRole(role);
}

function releaseSteps(params: ReleaseParams, ports: ReleasePorts): Step[] {
  const target = activeClusterTarget(params.serverId);
  const onMaster = releasesOnMaster(ports.db, params.serverId);
  const programs = onMaster ? MASTER_RELEASE_PROGRAMS : SLAVE_RELEASE_PROGRAMS;
  // The map-sourced answers differ with the arm because the programs do. A master's regeneration is
  // handed the installation's own values out of the map it stands on; a slave's regeneration reads
  // the master's map ITSELF, on the machine, and declares none of them — so what is left to state is
  // what the two machine-layer programs take, which is deploy-slave's own reading of the slave's map,
  // shared rather than copied.
  const extra = onMaster ? markingAnswers(target, ports) : slaveMachineAnswers(target, ports);
  const step = (p: ProgramOnSurface): Step =>
    ansiwiseProgramStep(target, p.program, ports, { extra, ...(p.onMaster === true ? { onMaster: true } : {}) });
  // The head every arm shares, in the order the header states and for the reason it states: the
  // ceiling and the machine's identity, then the catalogue's programs, THEN the two git writes.
  const head = [
    attestClusterStep(target, ceilingCheck(target, params.channel, params.version, ports)),
    requireProgramsStep(ports, programs),
    setPinStep(target, params, ports),
  ];
  if (onMaster) {
    return [...head, refreshCheckoutStep(target), ...programs.map(step), argocdFollowStep(target)];
  }
  return [
    ...head,
    // REPLACES refresh-checkout here rather than joining it: refreshCheckoutStep opens the run's
    // OWNED host, which for a slave release is the slave, and would leave the master's books tree —
    // the one carrying this slave's pin — unfetched.
    prepareRegenerationStep(target),
    ...programs.filter((p) => p.onMaster === true).map(step),
    // The slave's own checkout, and only NOW: before the regeneration the branch head this step
    // fetches is the one the release has not delivered yet.
    refreshCheckoutStep(target),
    ...programs.filter((p) => p.onMaster !== true).map(step),
    argocdFollowStep(target),
  ];
}

export function makeReleaseDef(ports: ReleasePorts): RunDefinition<ReleaseParams> {
  return {
    kind: "cluster-release",
    paramsSchema: ReleaseParams,
    mutating: true,
    plan: async (params, { db }) => {
      const { server, cluster } = loadActiveCluster(db, params.serverId);
      const onMaster = isMasterRole(server.role);
      const master = loadMaster(db);
      const booksBranch = masterFqdnOf(db, master);
      // The build-plane PATs are demanded exactly where the machine will demand them: the map says
      // whether this cluster carries the build plane, and regenerate-branch's stated_when answers
      // hold or lapse on the same fact (build_plane_fqdn == fqdn), so plan and machine can never disagree.
      // The slave arm asks for none: regenerate-slave-branch declares no credential answer at all —
      // a slave's secrets file is nothing a branch program of the master's writes.
      const marking = await resolveClusterMarking(requirePlatformRepo(ports), cluster.domain);
      const stepDefs = releaseSteps(params, ports);
      return {
        kind: "cluster-release",
        targetKind: "cluster",
        targetId: cluster.id,
        summary:
          `Release platform ${params.version}-${params.channel} onto "${server.name}" (${cluster.domain}, ${cluster.stage}, role ${server.role}): ` +
          `pin the cluster map, regenerate the install branch at the pin, rebuild the machine layer from it ` +
          `(the ${onMaster ? "regenerate-branch" : "regenerate-slave-branch"}, deploy-cluster and deploy-platform-services programs over the ansiwise surface), ` +
          `then wait for ArgoCD to converge. ${stepDefs.length} steps ` +
          `${onMaster ? "on the host itself" : `over two hosts — the slave and the master "${master.name}", whose branch carries this slave's pin and books`}.`,
        steps: stepDefs.map((s) => ({ name: s.name, title: s.title })),
        // The master arm owns only its own host. The slave arm additionally reaches the master, where
        // the regeneration runs out of the two checkouts the step before it stands.
        targets: onMaster
          ? [{ serverId: server.id, ownsHost: true, label: `${server.name} (${server.role})` }]
          : [
            { serverId: server.id, ownsHost: true, label: `${server.name} (slave)` },
            { serverId: master.id, ownsHost: false, label: `${master.name} (master)` },
          ],
        // Every branch this run touches: the trunk, where the tag is minted; the cluster's own
        // install branch, which the regeneration merges the tag into; and the BOOKS branch, where the
        // pin is committed. For a master those last two are one branch and the key is stated once;
        // for a slave they are two machines' two branches. master-kube because argocd-follow reads
        // the master's ArgoCD either way — a slave's Applications live in its instance THERE.
        locks: [
          { resource: "git-branch", key: PRODUCT_BRANCH },
          { resource: "git-branch", key: cluster.domain },
          ...(onMaster ? [] : [{ resource: "git-branch" as const, key: booksBranch }]),
          { resource: "master-kube", key: "m" },
        ],
        warnings: [
          `The machine layer re-runs on ${server.name} at the regenerated revision — expect a brief kube-apiserver blip while kubelite restarts.`,
          `The install branch ${cluster.domain} is regenerated by merging the tag into it and pushed; everything only the branch has is kept, and a conflict outside the regenerated paths stops the run with the paths named.`,
          ...(onMaster ? [] : [`The regeneration runs on ${master.name}, out of its second checkout — the pin and the books stand on ${booksBranch}, never on the slave's own branch.`]),
        ],
        // The programs raise their commands to root with a password the CALLER hands over per run
        // (the installation's ansiwise.yaml: password_from_caller) — collected at approve, held in
        // memory, sent with each POST /runs, persisted nowhere. The build-plane PATs ride the same
        // channel exactly when the map says this cluster builds (see BUILD_PLANE_PAT_SECRETS).
        requiredSecrets: [ANSIWISE_ELEVATION_SECRET, ...(onMaster && marking.buildPlane ? BUILD_PLANE_PAT_SECRETS : [])],
        requiredInputs: onMaster ? RELEASE_INPUTS : SLAVE_INSTALL_INPUTS,
      };
    },
    steps: (params) => releaseSteps(params, ports),
  };
}
