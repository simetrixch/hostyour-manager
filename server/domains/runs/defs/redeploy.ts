import { z } from "zod";
import { eq } from "drizzle-orm";
import type { Step, RunDefinition } from "../../../executor/types.ts";
import type { Db } from "../../../db/client.ts";
import { servers } from "../../../db/schema/inventory.ts";
import { isMasterRole } from "../../../../shared/enums.ts";
import { deploySlaveSteps, SLAVE_MACHINE_INPUTS, hostAnswers } from "./deploy-slave.ts";
import { placeAnsiwiseStep } from "./place-ansiwise.step.ts";
import { activeClusterTarget, loadMaster, masterFqdnOf, type DeploySlavePorts } from "./deploy-slave.kit.ts";
import { attestClusterStep, argocdFollowStep, loadActiveCluster } from "./live-cluster.kit.ts";
import { ansiwiseProgramStep, ANSIWISE_ELEVATION_SECRET, type AnsiwisePorts } from "./ansiwise-run.kit.ts";
import {
  proveElevationStep, generateKeyStep, installKeyStep, verifyKeyLoginStep, enableNtpStep,
  removeSudoersStep, type FirstContactInput,
} from "./manager-key.kit.ts";

// `redeploy` — rebuild the MACHINE LAYER of a cluster that is already live. One of the two cluster
// run kinds that deliver a machine layer at all, and they are distinct on purpose (shared/enums.ts):
// deploy-slave takes a machine from first contact to a live slave, redeploy rebuilds what is under
// GitOps on a cluster that is already running. Nothing here moves the cluster to another platform
// version — a machine layer is restorable without a version change, and that is exactly what this
// run kind is for.
//
// It takes only the server. The FQDN and the stage are NOT the operator's to state: they are what the
// active cluster row on that server already says, and asking for them again is how a redeploy could be
// aimed at a branch the cluster does not run from (activeClusterTarget resolves and refuses).
//
// FIRST CONTACT STANDS AT THE HEAD OF BOTH ARMS, because a machine reinstalled at the hosting
// provider is exactly the machine a redeploy is asked for. Such a machine keeps its cluster row at
// `active`, which is the row `cluster-deploy-slave` refuses (deploy-slave.attest.ts) and the row this
// run kind is for — and it holds no line of this manager's, so every session that offers the key
// alone is refused. The six steps of the first-contact kit put the key back and leave the machine's
// doors the way this platform keeps them (manager-key.kit.ts); each of them measures before it acts,
// so on a machine that never lost anything all six read their work done and say so in a full
// sentence, and the run does what it did before.
//
// AND NOT ONE OF THEM ARMS A COMPENSATION HERE, on either arm. A redeploy acts on a machine that is
// already live: taking this manager's key line off it would leave a running cluster nothing can
// reach, and this definition implements no cleanup for such a name to be resolved against, so a step
// that armed one would end an abort of this run on a step that does not exist (executor/cleanup.ts).
//
// TWO ARMS, decided by the role — because "the machine layer" is a different set of things per role:
//   pure slave        the deploy-slave step list in redeploy mode: first contact, the map, the
//                     machine-layer programs, the private network, the management plane (a fresh
//                     emit re-points the registration) and the GitOps handoff all reconcile. The one
//                     BIRTH act is left out — the branch cut, which would REPLACE what a live slave
//                     stands on rather than reconcile it — and NOT ONE compensating action is armed:
//                     every one of them (purge MicroK8s, the remove-slave program, drop the slave
//                     part of the cluster map) undoes a WORKING slave.
//
//                     THE TAILNET JOIN IS MEASURED HERE AND NOT A BIRTH ACT, and that is what lets
//                     this arm finish on the machine it is asked for. A machine reset at the provider
//                     holds no membership, and the resident ansiwise surface this arm switches on
//                     binds an address of that network and no other — so a redeploy that joined
//                     nothing could never finish one. It reads the machine's own client
//                     and joins only where that says the machine is off the network, so a live slave
//                     is neither logged out nor handed a fresh address (deploy-slave.ts, the join;
//                     tailnet.kit.ts joinIfAbsentStep for what the reading decides).
//   master, master+   first contact, then the machine layer as the deployment PROGRAMS deliver it,
//     slave           plus the ArgoCD follow. The engine and the catalogue are placed first, then
//                     deploy-host makes the box workable, deploy-cluster rebuilds the node below
//                     GitOps and deploy-platform-services raises what hands the cluster to the
//                     reconciler; the three programs run on the machine's own `ansiwise-rest serve`
//                     surface, each proven by a dry run the machine's gate then admits the real run
//                     against (ansiwise-run.kit.ts). A master has no master-side registration to
//                     redo — it IS the master — so those three programs and the follow are the whole
//                     machine layer here.
//
//                     AND NO JOIN, MEASURED OR OTHERWISE. Every act of this arm reaches the machine
//                     over the session the plan opens on servers.host or servers.lan_host, and the
//                     arm composes neither the resident surface nor the address declaration — so
//                     nothing here binds a private address and nothing here fails for the want of
//                     one. A master's join is also not a free reading to act on: the join program
//                     re-signs the machine's serving certificate, which makes MicroK8s re-issue and
//                     restart the control plane under it (tailnet.kit.ts). `cluster-tailnet-rejoin`
//                     takes a master as its target and performs exactly that, on its own approval
//                     and behind its own warnings, which is where a master's membership is repaired.
//
// WHAT THE MASTER ARM LEAVES OUT of the slave arm's tail is the pair of acts that shut a machine's
// remaining doors: `disable-password-login` and `purge-bootstrap-password`. Both belong to the
// deployment of a SLAVE, whose password door this manager opened and therefore owes shutting; a
// master's daemon and its account are that installation's own, and a redeploy has taken no reading
// that says either should change.
//
// THE PLACEMENT IS WHY A MASTER COULD NOT BE BROUGHT FORWARD AT ALL. `placeAnsiwiseStep` had ONE call
// site, in the slave install, so every engine, catalogue and machine-layer program an installed master
// carried was whatever ansiwise-client left there at its first installation, and no run moved any of
// them again. That is not an ageing problem: `cluster-deploy-slave` drives programs ON THE MASTER
// through the master's own ansiwise-rest, so a slave deploy already depends on a master's machine
// layer being current, and nothing could make it current (hostyour-manager#69). The step is
// idempotent by measurement, which is what lets it run against a machine that already carries all
// three.
//
// mutating: true ⇒ steps()[0].name === "attest-target" (guards.ts assertGuardsArmed), which both
// arms satisfy: the slave arm through deploy-slave's own attest-target, the master arm through the
// shared attestClusterStep.

export const RedeployParams = z.object({
  serverId: z.string().startsWith("srv_"),
});
export type RedeployParams = z.infer<typeof RedeployParams>;

/** The def resolves the role from the inventory rather than from its params, and steps() is handed no
 *  database — so the arm is chosen inside a closure the DEF holds, from the db the composition root
 *  gave it. `db` is therefore a port of this def, exactly as the platform repo is one of deploy-slave. */
export interface RedeployPorts extends DeploySlavePorts, AnsiwisePorts {
  db: Db;
}

/** The programs the master arm runs after deploy-host, in the order the machine layer stands on them:
 *  the cluster below GitOps first, then what hands it over. The names are the catalogue's own
 *  (hostyour-deploy ansiwise/programs/); each step reads the program's declared answers off the
 *  machine, so nothing about their INSIDES is repeated here.
 *
 *  deploy-host is NOT in this list and stands beside it, for the same reason it stands beside the
 *  slave's two (deploy-slave.ts:313): it is the one of the three owed an answer this manager holds
 *  and the machine does not — the public half of the key the manager reaches it with. */
const MASTER_ARM_PROGRAMS = ["deploy-cluster", "deploy-platform-services"] as const;

/** The answers the inventory cannot state, asked for at approve and carried to the step as
 *  `activation-input:<answer>`. The four optional ones may stay blank — a blank input is
 *  dropped at approve and the program's own default (or its refusal, by name) decides. */
const MASTER_ARM_INPUTS = [
  { field: "letsencrypt_email", label: "The mailbox the certificate authority writes to before a certificate expires" },
  { field: "letsencrypt_server", label: "The ACME directory this installation registers with — the authority's production one; a staging directory is refused, because its root is in no machine's trust store" },
  { field: "build_plane_fqdn", label: "The cluster the image registry stands on — blank when this cluster hosts it itself", optional: true },
  { field: "lan_cidr", label: "The IPv4 range this machine shares with the other clusters — blank when it shares none", optional: true },
  { field: "storage_mount", label: "Where the machine's separate storage is mounted — blank when it has none", optional: true },
  { field: "storage_subdirectory", label: "The directory under that mount for the cluster's volumes — blank for the snap's default", optional: true },
];

function redeploySteps(params: RedeployParams, ports: RedeployPorts): Step[] {
  const target = activeClusterTarget(params.serverId);
  // WHICH arm is a question about the inventory, and steps() is handed the persisted params and no
  // database — so the def holds one as a port and asks here. An UNRESOLVABLE server is not an error
  // path: the boot check calls steps({}) with no params at all, purely to assert that step 0 is
  // attest-target, and on that question the two arms agree — so it gets the shorter shape and a real
  // run, which always names a server, gets the arm that server's role earns.
  const role = ports.db.select({ role: servers.role }).from(servers).where(eq(servers.id, params.serverId)).get()?.role;
  if (role !== undefined && !isMasterRole(role)) {
    return deploySlaveSteps({ target, mode: "redeploy" }, ports);
  }
  // The password every root command of this arm is raised with is also what opens a session on a
  // machine that no longer holds this manager's key — one secret, named once, and the same one the
  // machine's own programs are driven with (ansiwise-run.kit.ts).
  const firstContact: FirstContactInput = { serverId: params.serverId, secretName: ANSIWISE_ELEVATION_SECRET };
  return [
    attestClusterStep(target),
    // ---- FIRST CONTACT: this manager's own key on the machine, and the machine's clock and its
    // standing grants the way this platform keeps them. The steps stand HERE, before every act
    // below, because all of those reach the machine over ctx.ssh(), and ctx.ssh() authenticates with
    // the key install-key puts there and verify-key-login proves. Only attest-target above them
    // needs no key at all — it opens the same door itself.
    proveElevationStep(firstContact),
    generateKeyStep(firstContact),
    // NOTHING IS ARMED, and install-key is where that decision is made rather than assumed: the kit
    // takes the arming as an answer from the composing definition, because the executor resolves a
    // registered compensation by NAME against that definition's own cleanups(). This one implements
    // none, and a machine whose cluster is live must keep the only way in this manager has.
    installKeyStep(firstContact, { arm: false }),
    verifyKeyLoginStep(firstContact),
    enableNtpStep(firstContact),
    // Last of the key steps, and it may only stand here because every root command this arm sends
    // afterwards is raised with the password the run carries: the three programs by the machine's own
    // engine, the placement and the follow through the step-kit's `elevation`.
    removeSudoersStep(firstContact),
    // FIRST among the machine-side acts, and for the reason it is first in the slave install: the
    // three programs below are read from a catalogue and spoken to through a binary, and this is
    // what puts both at what clusters/platform/versions.yaml pins. A master whose engine drifted off
    // that pin is the state this run kind exists to end.
    placeAnsiwiseStep(target, ports),
    ansiwiseProgramStep(target, "deploy-host", ports, { extra: hostAnswers(params.serverId, ports) }),
    ...MASTER_ARM_PROGRAMS.map((program) => ansiwiseProgramStep(target, program, ports)),
    argocdFollowStep(target),
  ];
}

export function makeRedeployDef(ports: RedeployPorts): RunDefinition<RedeployParams> {
  return {
    kind: "cluster-redeploy",
    paramsSchema: RedeployParams,
    mutating: true,
    plan: async (params, { db }) => {
      const { server, cluster } = loadActiveCluster(db, params.serverId);
      const master = loadMaster(db);
      const onMaster = isMasterRole(server.role);
      const stepDefs = redeploySteps(params, ports);
      return {
        kind: "cluster-redeploy",
        targetKind: "server",
        targetId: params.serverId,
        // WHAT EACH ARM DOES BESIDE THE MACHINE LAYER IS PART OF THE SUMMARY, because the summary is
        // what the approve card renders (RunView carries one and no warnings) and the acts below
        // reach the machine's way in: the head of both lists puts this manager's key back where the
        // machine has lost it, and the slave arm's tail takes two ways in away for good. They stand
        // in the composed lists as surely as a first install's do — and a person approving a rebuild
        // of the machine layer would otherwise read nothing about them.
        summary:
          `Rebuild the machine layer of "${server.name}" (${cluster.domain}, ${cluster.stage}, role ${server.role}) in place: ` +
          `${stepDefs.length} idempotent steps${onMaster
            ? " on the host itself — one pass over its own deployment programs, which is the whole machine layer under every part that machine carries"
            : ` over two hosts — the slave and the master "${master.name}"`}. ` +
          `The cluster stays active throughout and no release pin is touched. ` +
          `The password you enter raises every root command of this run and of the machine's own programs; it is held in memory ` +
          `for the length of the run and stored nowhere.` +
          ` It also opens the first session wherever this manager's key no longer does, which is what a machine reinstalled at ` +
          `the hosting provider answers with: the key goes back on, the clock is set to synchronise and a standing ` +
          `passwordless-root drop-in is taken off. Each of the three is measured first, so nothing is written on a machine that ` +
          `lost none of them, and none of the three is undone on an abort.` +
          (onMaster ? "" :
            ` This arm additionally re-establishes the two doors a deployed slave stands behind: the daemon's password door is ` +
            `shut, and any password sealed beside this server's row is destroyed. A host whose password door was deliberately ` +
            `reopened has it shut again here, and neither is put back on an abort.` +
            ` It also reads whether the machine still holds an address of the private network, and puts it back on that network ` +
            `only where it holds none — a machine already on it is neither logged out nor handed a fresh address, and nothing ` +
            `is minted for it.`),
        steps: stepDefs.map((s) => ({ name: s.name, title: s.title })),
        // The master arm owns only its own host. The slave arm additionally reaches the master, whose
        // Vault and kube-apiserver the management-plane steps drive — the same two targets, and the
        // same locks, deploy-slave declares, because it is running deploy-slave's steps.
        targets: onMaster
          ? [{ serverId: server.id, ownsHost: true, label: `${server.name} (${server.role})` }]
          : [
            { serverId: server.id, ownsHost: true, label: `${server.name} (slave)` },
            { serverId: master.id, ownsHost: false, label: `${master.name} (master)` },
          ],
        locks: onMaster
          ? [{ resource: "git-branch", key: cluster.domain }, { resource: "master-kube", key: "m" }]
          : [
            { resource: "git-branch", key: cluster.domain },
            { resource: "git-branch", key: masterFqdnOf(db, master) },
            { resource: "master-vault", key: "m" },
            { resource: "master-kube", key: "m" },
          ],
        warnings: [
          `The machine layer re-runs on ${server.name} — expect a brief kube-apiserver blip while kubelite restarts.`,
        ],
        // BOTH arms drive programs now, and the programs raise their commands to root with a
        // password the CALLER hands over per run (the installation's ansiwise.yaml:
        // password_from_caller) — collected at approve, held in memory, sent with each POST /runs,
        // persisted nowhere. The inputs differ: the master arm may host the build plane and is
        // asked for it; the slave arm reads it off its own cluster map and asks only what the
        // machine-layer programs declare beyond the inventory.
        requiredSecrets: [ANSIWISE_ELEVATION_SECRET],
        requiredInputs: onMaster ? MASTER_ARM_INPUTS : SLAVE_MACHINE_INPUTS,
      };
    },
    steps: (params) => redeploySteps(params, ports),
  };
}
