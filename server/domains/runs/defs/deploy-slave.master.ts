import { eq } from "drizzle-orm";
import type { Step, Plan } from "../../../executor/types.ts";
import type { Db } from "../../../db/client.ts";
import { clusters, servers } from "../../../db/schema/inventory.ts";
import { errValidation } from "../../../kernel/errors.ts";
import { resolveTransport } from "../../../executor/transport.ts";
import type { ServerRole, Stage } from "../../../../shared/enums.ts";
import { resolveClusterMarking, projectClusterMarking } from "../../inventory/cluster-marking.ts";
import { clusterMapPath } from "../../../../shared/cluster-values.ts";
import { attestTargetStep } from "./deploy-slave.attest.ts";
import {
  proveElevationStep, generateKeyStep, installKeyStep, verifyKeyLoginStep, removeSudoersStep,
  type FirstContactInput,
} from "./manager-key.kit.ts";
import { placeAnsiwiseStep } from "./place-ansiwise.step.ts";
import { argocdFollowStep } from "./live-cluster.kit.ts";
import {
  ansiwiseProgramStep, ANSIWISE_ELEVATION_SECRET, type AnsiwisePorts, type ExtraAnswers,
} from "./ansiwise-run.kit.ts";
import {
  loadServer, loadMaster, requirePlatformRepo,
  type DeploySlavePorts, type SlaveInstallInput, type SlaveTarget,
} from "./deploy-slave.kit.ts";
import { hostAnswers, slaveMachineAnswers, checkoutAnswers } from "./deploy-slave.ts";
import { MANAGER_COMMITTER_NAME, MANAGER_COMMITTER_EMAIL } from "../../../adapters/git/git.ts";
import type { DeploySlaveParams } from "./deploy-slave.ts";

// THE MASTER ARM of `cluster-deploy-slave`: what the run does when the machine it is aimed at
// already carries the MASTER part. The arm is chosen by the target's ROLE and by nothing an operator
// states, the way redeploy chooses between its two (redeploy.ts) — a role is a fact of the inventory,
// and a run that let a person pick the arm would let them pick the wrong one.
//
// WHAT IT IS. A machine carrying the master part takes the slave part by REGENERATING ITS OWN
// BRANCH with the combined role. That is the whole difference from the other arm: there is one
// machine, one branch and one cluster, and this run adds a PART to what already stands rather than
// building a second thing beside it.
//
// ONE CLUSTER PER MACHINE STILL HOLDS, and it is not relaxed here. `clusters_server_uq` keeps one
// cluster row per server and the master's own is that row, so this arm allocates no ordinal, inserts
// no cluster row, writes no per-slave management plane and never runs `mark-slave`. The platform
// selects the per-slave plane on `role: slave` exactly, so a machine carrying both parts is one
// cluster on one branch — which is why the refusals below are the shape of the whole arm: the only
// machine it may be aimed at is this manager's own master, and only while that master does not
// carry the part already; the only domain is that master's own, and the only stage is its cluster's.
//
// NOT ONE COMPENSATING ACTION IS ARMED, and this is the reason the arm is a file of its own rather
// than a flag on the other one. Every compensation a first install arms acts on the machine the run
// owns, and here that machine is the control host: `microk8s-reset-slave` would take MicroK8s off the
// cluster this manager's own platform runs on, `remove-slave` would run the master's removal program
// against the master, `remove-slave-marking` would strip the map of the books-keeping cluster, and
// `remove-installed-key` would delete the line every other run kind reaches this host through. So the
// arm registers none of them: what a half-finished run leaves behind is finished by running it
// again, never by undoing it.
//
// THE DOORS ARE LEFT AS THE MACHINE KEEPS THEM. Neither `disable-password-login` nor
// `purge-bootstrap-password` stands in the list, and `enable-ntp` does not either: shutting the
// password door of the host this manager runs on is a deliberate second act with a run kind of its
// own (`cluster-password-login-disable`, which admits the master), and a machine that has been
// keeping a platform running keeps its own clock.

/** The role a machine standing under BOTH parts carries — the answer `regenerate-branch` is given,
 *  and the value the regenerated map must come back stating. Named once, because the run answers it
 *  and then measures for it, and a word typed twice is a word that can disagree with itself. */
export const MASTER_AND_SLAVE_ROLE = "master+slave" satisfies ServerRole;

/** The machine this arm may be AIMED at, with the two refusals that hold it there.
 *
 *  IT MUST BE THIS MANAGER'S OWN MASTER. `servers_one_master_uq` admits one row carrying a master
 *  part and `loadMaster` is what every master-side act of every run kind resolves, so asking that
 *  same equality here is what makes the card, this plan and `attest-target`'s own `takingSlavePart`
 *  (deploy-slave.attest.ts) name ONE machine rather than three that agree by accident.
 *
 *  AND IT MUST NOT ALREADY CARRY THE SLAVE PART. `master+slave` is the role this run writes onto the
 *  row once the regenerated map states it, so a machine standing there carries the part and there is
 *  nothing left to add: the machine layer under both parts is rebuilt by `cluster-redeploy`, whose
 *  master arm runs the same programs over the same branch.
 *
 *  ASKED BY THE PLAN AND NOT BY THE STEPS, because it answers "may this act be started" and not
 *  "what is it acting on". A run whose regeneration has already moved the row and which then failed
 *  in the machine layer is finished by running its own steps again, and a refusal the steps asked
 *  would stop exactly that — so `masterSelfTarget` below resolves through the cluster and never
 *  through this. */
export function masterTakingSlavePart(db: Db, serverId: string): typeof servers.$inferSelect {
  const server = loadServer(db, serverId);
  const master = loadMaster(db);
  if (master.id !== server.id) {
    throw errValidation(
      `${server.name} stands at role ${server.role} and the master part of this installation is carried by ${master.name} — ` +
      "the slave part is added to the machine that operates the management plane, and this installation has one of those",
    );
  }
  if (server.role === MASTER_AND_SLAVE_ROLE) {
    throw errValidation(
      `${server.name} already stands at role ${MASTER_AND_SLAVE_ROLE}, which is the role this run writes — the machine ` +
      "carries the slave part and there is none left to add; what rebuilds the machine layer under both parts is the " +
      "cluster-redeploy run kind, whose master arm runs the same programs over the same branch",
    );
  }
  return server;
}

/** The master's OWN cluster, with the refusals that keep this arm on it: it must have one, that one
 *  must be live, and the domain and the stage the operator stated must be its own.
 *
 *  A machine keeps ONE cluster (`clusters_server_uq`) and the slave part is added to the cluster the
 *  master already keeps, so a run aimed at any other domain is a run asking for a second cluster on
 *  the same machine, and a run stating any other stage is the same cluster claiming to be two. Both
 *  are refused here rather than absorbed, because the alternative — quietly acting on the master's
 *  own domain instead of the stated one — would regenerate a branch nobody asked for.
 *
 *  It is the plan's check AND the steps': the target below resolves through it, so every step that
 *  asks what it is acting on asks this. */
export function masterSelfCluster(db: Db, serverId: string, stated: { domain: string; stage: Stage }): typeof clusters.$inferSelect {
  const server = loadServer(db, serverId);
  const cluster = db.select().from(clusters).where(eq(clusters.serverId, serverId)).get();
  if (!cluster) {
    throw errValidation(
      `${server.name} carries the master part and this manager records no cluster for it — the slave part is added to the ` +
      "master's OWN cluster, and there is none here to add it to",
    );
  }
  if (cluster.status !== "active") {
    throw errValidation(
      `cluster ${cluster.id} for ${cluster.domain} is '${cluster.status}' — the master takes the slave part on its own LIVE ` +
      "cluster, which is the one its platform already runs from",
    );
  }
  if (cluster.domain !== stated.domain) {
    throw errValidation(
      `this run states ${stated.domain} and ${server.name} keeps cluster ${cluster.id} for ${cluster.domain} — one machine keeps ` +
      "one cluster, so the master takes the slave part on its own domain and on no other; a second domain needs a machine of its own",
    );
  }
  if (cluster.stage !== stated.stage) {
    throw errValidation(
      `this run states stage ${stated.stage} and cluster ${cluster.id} for ${cluster.domain} stands at ${cluster.stage} — the ` +
      "slave part is added to that cluster, and a cluster carries one stage",
    );
  }
  return cluster;
}

/** The master arm's target: the master's own live cluster, refusing a stated domain or stage that is
 *  not it. The domain and the stage the steps act on are therefore the ROW's, and the operator's are
 *  what they are measured against. */
export function masterSelfTarget(serverId: string, stated: { domain: string; stage: Stage }): SlaveTarget {
  return {
    serverId,
    resolve: (db) => {
      const cluster = masterSelfCluster(db, serverId, stated);
      return { domain: cluster.domain, stage: cluster.stage };
    },
  };
}

/** What `regenerate-branch` is answered with, and every value of it is READ rather than asked for.
 *
 *  THE PROGRAM IS THE ONE THE LIFECYCLE DRIVES FROM A CONFIG FILE, and this manager holds no such
 *  file. What it holds instead is the installation's own cluster map, which is where those answers
 *  were written when the installation was generated — the certificate authority, the apex its units
 *  are reached below, the mailboxes its alerts go to, the catalogue its tenants come from. Measured
 *  on a real run: the step was given the role and nothing else, and the machine refused to start the
 *  program with ten sentences, each naming an answer that stood written down two directories away.
 *
 *  THE COMMITTER IS THIS MANAGER, and that is not an inference. It already commits into this same
 *  repository under that identity — the cluster-map commits on the very branch this run regenerates
 *  carry it — so the regeneration it drives writes under the name it writes under everywhere else.
 *
 *  THE ROLE IS THE ONE ANSWER THIS ARM IS AUTHORITATIVE FOR, and it has to overrule the inventory.
 *  An extra answer wins over the row's own (ansiwise-run.kit.ts composeAnswers), and the row is what
 *  `project-marking` moves once the regenerated map states the combined role — so on a first pass it
 *  still says `master` at the moment these answers are composed.
 *
 *  TWO CAN BE ABSENT FROM THE MAP, and both are refused rather than guessed.
 *
 *  `platform_ref` — the map's release line is what the lifecycle's own regeneration reads the ref
 *  off, and an installation that records none has not been released onto: bringing its branch to
 *  whatever the trunk happens to hold would leave a machine standing on a state its own map cannot
 *  name.
 *
 *  `cluster_issuer` — every other answer here is spread only where the map carries it, so an absent
 *  one leaves the program's own default standing. That is harmless for a value whose default is
 *  inert and destructive for this one: regenerate-branch defaults it to platform-local, writes it
 *  into configs/config.<stage> and into the base certificate, and the run then reissues every
 *  address of the installation from the cluster's own root. Measured on apps6 on 2026-09-04 in
 *  run_01M1NP396FB7E7DHCRQ3F10E59, which deleted the platform-acme issuer and reported itself
 *  green. So this one is passed unconditionally, and a map that does not name it stops the run. */
export function branchAnswers(target: SlaveTarget, serverId: string, ports: DeploySlavePorts): ExtraAnswers {
  const checkout = checkoutAnswers(target, ports);
  return async (ctx) => {
    const { domain } = target.resolve(ctx.db);
    const marking = await resolveClusterMarking(requirePlatformRepo(ports), domain);
    if (marking.release === undefined) {
      throw errValidation(
        `${domain} records no release in ${clusterMapPath(domain)}, so there is no state to bring its ` +
        "branch to. The regeneration reads that line and never the trunk's own head: a machine brought " +
        "to whatever master happens to hold stands on a state its own map cannot name. Cut a platform " +
        "release onto this installation first, then run this again",
      );
    }
    if (marking.clusterIssuer === undefined) {
      throw errValidation(
        `${domain} records no clusterIssuer in ${clusterMapPath(domain)}, and the regeneration is ` +
        "answered with it. Left unanswered the program defaults it to platform-local and reissues " +
        "every certificate of this installation from the cluster's own root, which nothing outside " +
        "the machine trusts. Write the authority this installation issues by — platform-acme or " +
        "platform-local — under global in that map, then run this again",
      );
    }
    const server = ctx.db.select({ lanHost: servers.lanHost }).from(servers).where(eq(servers.id, serverId)).get();
    if (server?.lanHost === undefined || server.lanHost === null || server.lanHost.length === 0) {
      throw errValidation(
        `the inventory row of ${domain} carries no LAN address, and the regeneration is answered with ` +
        "it: the manager serves on the node's own network, and the chart-validation gate has to prove " +
        "it cannot be reached from inside the fence. Write the address on the server row, then run " +
        "this again",
      );
    }
    return {
      ...(await checkout(ctx)),
      platform_ref: marking.release,
      lan_host: server.lanHost,
      committer_name: MANAGER_COMMITTER_NAME,
      committer_email: MANAGER_COMMITTER_EMAIL,
      ...(marking.booksCluster !== undefined ? { books_fqdn: marking.booksCluster } : {}),
      build_plane_fqdn: marking.buildPlaneFqdn,
      ...(marking.unitApex !== undefined ? { unit_apex: marking.unitApex } : {}),
      ...(marking.platformDomain !== undefined ? { platform_domain: marking.platformDomain } : {}),
      ...(marking.alertRecipients !== undefined ? { alert_recipients: marking.alertRecipients } : {}),
      ...(marking.catalogRepo !== undefined ? { catalog_repo: marking.catalogRepo } : {}),
      cluster_issuer: marking.clusterIssuer,
      ...(marking.letsencryptEmail !== undefined ? { letsencrypt_email: marking.letsencryptEmail } : {}),
      ...(marking.letsencryptServer !== undefined ? { letsencrypt_server: marking.letsencryptServer } : {}),
      role: MASTER_AND_SLAVE_ROLE,
    };
  };
}

/** `project-marking` — read the regenerated cluster map back and move the inventory row onto it.
 *
 *  THE MAP IS THE WRITABLE PLACE AND THE ROW IS THE COPY. `servers.role` is what every role decision
 *  in this process queries — which surface a program's serve identity carries, where a cluster's
 *  ArgoCD lives, whether the master-side registration is skipped — so the act that regenerates the
 *  map moves the copy in the same run rather than leaving the two to disagree.
 *
 *  IT REFUSES A MAP THAT DOES NOT CARRY THE COMBINED ROLE, and that refusal is the only proof this
 *  run has that the regeneration above did what it was answered. The three programs below and the
 *  platform's own part selection all read the role, so a run that projected `master` here would go on
 *  to deliver a master's machine layer and report a slave part nothing had built. */
function projectMarkingStep(target: SlaveTarget, ports: DeploySlavePorts): Step {
  return {
    name: "project-marking",
    title: "Project the regenerated cluster map onto the inventory row",
    run: async (ctx) => {
      const { domain } = target.resolve(ctx.db);
      const server = loadServer(ctx.db, target.serverId);
      const repo = requirePlatformRepo(ports);
      const marking = await resolveClusterMarking(repo, domain);
      if (marking.role !== MASTER_AND_SLAVE_ROLE) {
        throw errValidation(
          `${clusterMapPath(domain)} on ${repo.booksBranch} states role '${marking.role}' — the regeneration was answered ` +
          `'${MASTER_AND_SLAVE_ROLE}', so a map without it means the branch this machine reads was not regenerated with the ` +
          "slave part; read the program's run log, then retry this run from the regeneration step",
        );
      }
      const moved = projectClusterMarking(ctx.db, marking, { actor: "system", runId: ctx.runId });
      ctx.checkpoint({ role: marking.role, moved });
      ctx.log("meta", moved.role
        ? `${clusterMapPath(domain)} states role ${marking.role}, so ${server.name} moves from ${moved.role.from} to ${moved.role.to} on its inventory row.`
        : `${server.name} already stands at role ${marking.role} on its inventory row, which is what ${clusterMapPath(domain)} states, so nothing was written.`);
      if (moved.stage) ctx.log("meta", `cluster ${domain} moves from stage ${moved.stage.from} to ${moved.stage.to}, which is what its map states.`);
    },
  };
}

/** The master arm's step list: first contact, then the machine's own branch regenerated under the
 *  combined role and its machine layer re-run from it.
 *
 *  FIRST CONTACT STANDS HERE TOO, and every one of its steps is measure-then-act (manager-key.kit.ts):
 *  on a master this manager has been reaching for months they read a key that is installed and a
 *  login that works, write nothing, and each says so in a full sentence. They are in the list because
 *  a run states what it measured, not because the master is expected to need them.
 *
 *  THE ORDER IS WHAT MAKES THE THREE PROGRAMS DELIVER BOTH PARTS. `regenerate-branch` puts the
 *  combined role into the map on the machine's own branch, `project-marking` moves the inventory row
 *  onto that map, and only then do the machine-layer programs run — each of which is driven over a
 *  serve identity carrying the row's role and reads the map the branch now holds. Run in any other
 *  order they would deliver a pure master's machine layer. */
export function masterSlavePartSteps(params: DeploySlaveParams, ports: DeploySlavePorts & AnsiwisePorts): Step[] {
  const sid = params.serverId;
  const target = masterSelfTarget(sid, params);
  const input: SlaveInstallInput = { target, mode: "deploy" };
  // The password every root command of this run is raised with, and — on a machine this manager held
  // no key for — what would open the first login. One secret, named once, and the same one the
  // machine's own programs are driven with (ansiwise-run.kit.ts).
  const firstContact: FirstContactInput = { serverId: sid, secretName: ANSIWISE_ELEVATION_SECRET };
  // Read off the machine's OWN map, which for a machine that keeps the books is where the
  // installation's answers were written when it was generated — so nobody is asked at approve for a
  // certificate authority, a mailbox or a build plane that already stands written down.
  const machineAnswers = slaveMachineAnswers(target, ports);
  return [
    attestTargetStep(input),
    // ---- FIRST CONTACT: the manager's own key on the machine, measured before anything is written.
    proveElevationStep(firstContact),
    generateKeyStep(firstContact),
    // install-key is the only one of these that leaves anything on the machine, and the kit takes the
    // arming of its compensation as an answer from the composing definition. This arm answers no: the
    // key it would take back is the line every other run kind of this manager reaches the control
    // host through, and an abort that removed it would leave the machine this installation is
    // operated from reachable by nobody.
    installKeyStep(firstContact, { arm: false }),
    verifyKeyLoginStep(firstContact),
    // Last of the key steps, and it may stand here for the same reason it may on the other arm:
    // every root command this run sends afterwards is raised with the password the run carries —
    // the programs by their own engine, the steps through the step-kit's `elevation`.
    removeSudoersStep(firstContact),
    // The binary the programs below are spoken to through, the catalogue they are read from and the
    // platform checkout they act on, all three at what clusters/platform/versions.yaml pins.
    // Idempotent by measurement, which is what lets it run against a machine that carries all three.
    placeAnsiwiseStep(target, ports),
    // THE ACT THIS ARM EXISTS FOR: the machine's own branch, regenerated under the combined role.
    // The program rewrites the branch from the trunk and stamps this installation into it, the map
    // among what it stamps — so the slave part arrives as a property of the branch the machine
    // already reads, and not as a second branch beside it.
    ansiwiseProgramStep(target, "regenerate-branch", ports, { extra: branchAnswers(target, sid, ports) }),
    projectMarkingStep(target, ports),
    // ---- the machine layer, exactly as every cluster gets it: the three deployment programs on the
    // machine's own surface, each dry-proven then run. deploy-host is owed the two checkout answers
    // and the public half of the key this manager reaches the machine with, which is why it stands
    // apart from the two below rather than in a list with them.
    ansiwiseProgramStep(target, "deploy-host", ports, { extra: hostAnswers(target, sid, ports) }),
    ansiwiseProgramStep(target, "deploy-cluster", ports, { extra: machineAnswers }),
    ansiwiseProgramStep(target, "deploy-platform-services", ports, { extra: machineAnswers }),
    // What the cluster's own reconciler makes of the branch it now stands on. A cluster carrying the
    // master part operates its own ArgoCD, so the follow reads this machine and no other.
    argocdFollowStep(target),
  ];
}

/** The master arm's plan. ONE host and ONE cluster, which is what makes it a different plan and not
 *  only a different step list: the other arm declares the slave and the master as two targets and
 *  claims two git branches, and here both halves of every one of those pairs are the same machine. */
export function masterSlavePartPlan(params: DeploySlaveParams, ports: DeploySlavePorts & AnsiwisePorts, db: Db): Plan {
  const server = masterTakingSlavePart(db, params.serverId);
  const cluster = masterSelfCluster(db, params.serverId, params);
  const stepDefs = masterSlavePartSteps(params, ports);
  // The address the run will actually dial: the card must name the address the first connect line in
  // the log names, or an operator approves one address and gets the other.
  const dialled = resolveTransport(server, "default");
  return {
    kind: "cluster-deploy-slave",
    targetKind: "server",
    targetId: params.serverId,
    summary:
      `Add the slave part to "${server.name}" (${dialled.host}), which already carries the master part: ` +
      `${stepDefs.length} steps on that one host. Its own branch ${cluster.domain} is regenerated under role ` +
      `${MASTER_AND_SLAVE_ROLE} and its machine layer re-run from it, so the machine keeps the ONE cluster it already has ` +
      `(${cluster.id}, ${cluster.stage}): no ordinal is allocated, no second cluster row is written and no per-slave ` +
      `management plane is built, because the plane a slave is given is the one this machine already operates. ` +
      `The password you enter raises every root command of this run and of the machine's own programs; it is held in memory ` +
      `for the length of the run and stored nowhere. The machine is left taking passwords as it does today and its sealed ` +
      `bootstrap password is left where it stands — shutting either door on the host this manager runs from is a separate act. ` +
      `NOT ONE COMPENSATING ACTION IS ARMED: every one of them would act on this same host, so an abort leaves the machine as ` +
      `the last completed step left it, and the way back is running this run again.`,
    steps: stepDefs.map((s) => ({ name: s.name, title: s.title })),
    // ONE target, owned. Every act of this arm is on the machine itself: there is no master-side half,
    // because this machine IS the master.
    targets: [{ serverId: server.id, ownsHost: true, label: `${server.name} (${server.role})` }],
    // The branch the regeneration rewrites, and the kube-apiserver the follow reads. No master-vault
    // claim, exactly as redeploy's master arm takes none: this arm mints no per-slave credential and
    // runs no registration, so there is no Vault surgery of this manager's for another run to
    // interleave with.
    locks: [
      { resource: "git-branch", key: cluster.domain },
      { resource: "master-kube", key: "m" },
    ],
    // The abort is stated in the SUMMARY and not here, because the summary is what the approve card
    // renders (RunView carries one and no warnings) and a person decides on this run there.
    warnings: [
      `The machine layer re-runs on ${server.name}, which is the host this manager's own platform stands on — expect a brief kube-apiserver blip while kubelite restarts.`,
    ],
    // The programs raise their commands to root with a password the CALLER hands over per run (the
    // installation's ansiwise.yaml: password_from_caller) — collected at approve, held in memory,
    // sent with each POST /runs, persisted nowhere.
    requiredSecrets: [ANSIWISE_ELEVATION_SECRET],
    // Nothing is asked beyond it. What the three programs declare past the inventory stands in this
    // machine's own cluster map, and machineAnswers reads it there.
  };
}
