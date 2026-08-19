import { z } from "zod";
import { eq } from "drizzle-orm";
import type { Step, RunDefinition } from "../../../executor/types.ts";
import type { Db } from "../../../db/client.ts";
import { servers } from "../../../db/schema/inventory.ts";
import { isMasterRole } from "../../../../shared/enums.ts";
import { deploySlaveSteps, SLAVE_MACHINE_INPUTS } from "./deploy-slave.ts";
import { activeClusterTarget, loadMaster, masterFqdnOf, type DeploySlavePorts } from "./deploy-slave.kit.ts";
import { attestClusterStep, argocdFollowStep, loadActiveCluster } from "./cluster-release.kit.ts";
import { ansiwiseProgramStep, ANSIWISE_ELEVATION_SECRET, type AnsiwisePorts } from "./ansiwise-run.kit.ts";

// `redeploy` — rebuild the MACHINE LAYER of a cluster that is already live. One of the three
// distinguishable cluster verbs: adopt takes a bare machine into service, deploy-slave turns an
// adopted server into a live slave, redeploy rebuilds what is under GitOps on a cluster that is
// already running, and release raises the platform version. Nothing here moves a pin — a machine
// layer is restorable without a version change, and that is exactly what this verb is for.
//
// It takes only the server. The FQDN and the stage are NOT the operator's to state: they are what the
// active cluster row on that server already says, and asking for them again is how a redeploy could be
// aimed at a branch the cluster does not run from (activeClusterTarget resolves and refuses).
//
// TWO ARMS, decided by the role — because "the machine layer" is a different set of things per role:
//   pure slave        the deploy-slave step list in redeploy mode: the map, the machine-layer
//                     programs, the management plane (a fresh emit re-points the registration) and
//                     the GitOps handoff all reconcile. The two BIRTH acts are left out — the
//                     branch cut and the tailnet join, each of which would REPLACE what a live
//                     slave stands on rather than reconcile it — and NOT ONE compensating action
//                     is armed: every one of them (purge MicroK8s, the remove-slave program, drop
//                     the slave part of the cluster map) undoes a WORKING slave.
//   master, master+   the machine layer as the deployment PROGRAMS deliver it, plus the ArgoCD
//     slave           follow. deploy-cluster rebuilds the node below GitOps and deploy-gitops raises
//                     what hands the cluster to the reconciler; both run on the machine's own
//                     `ansiwise serve` surface, each proven by a dry run the machine's gate then
//                     admits the real run against (ansiwise-run.kit.ts). A master has no master-side
//                     registration to redo — it IS the master — so those two programs and the follow
//                     are the whole machine layer here, minus the pin.
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

/** The programs the master arm runs, in the order the machine layer stands on them: the cluster
 *  below GitOps first, then what hands it over. The names are the catalogue's own
 *  (digita-deploy ansiwise/programs/); each step reads the program's declared answers off the
 *  machine, so nothing about their INSIDES is repeated here. */
const MASTER_ARM_PROGRAMS = ["deploy-cluster", "deploy-gitops"] as const;

/** The answers the inventory cannot state, asked for at approve and carried to the step as
 *  `activation-input:<answer>`. The four optional ones may stay blank — a blank input is
 *  dropped at approve and the program's own default (or its refusal, by name) decides. */
const MASTER_ARM_INPUTS = [
  { field: "letsencrypt_email", label: "The mailbox the certificate authority writes to before a certificate expires" },
  { field: "letsencrypt_server", label: "The ACME directory this installation registers with (staging to rehearse, production to serve)" },
  { field: "build_plane", label: "The cluster the image registry stands on — blank when this cluster hosts it itself" },
  { field: "lan_cidr", label: "The IPv4 range this machine shares with the other clusters — blank when it shares none" },
  { field: "storage_path", label: "Where the machine's separate storage is mounted — blank when it has none" },
  { field: "storage_directory", label: "The directory under that mount for the cluster's volumes — blank for the snap's default" },
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
  return [
    attestClusterStep(target),
    ...MASTER_ARM_PROGRAMS.map((program) => ansiwiseProgramStep(target, program, ports)),
    argocdFollowStep(target),
  ];
}

export function makeRedeployDef(ports: RedeployPorts): RunDefinition<RedeployParams> {
  return {
    kind: "redeploy",
    paramsSchema: RedeployParams,
    mutating: true,
    plan: async (params, { db }) => {
      const { server, cluster } = loadActiveCluster(db, params.serverId);
      const master = loadMaster(db);
      const onMaster = isMasterRole(server.role);
      const stepDefs = redeploySteps(params, ports);
      return {
        kind: "redeploy",
        targetKind: "server",
        targetId: params.serverId,
        summary:
          `Rebuild the machine layer of "${server.name}" (${cluster.domain}, ${cluster.stage}, role ${server.role}) in place: ` +
          `${stepDefs.length} idempotent steps${onMaster ? " on the host itself" : ` over two hosts — the slave and the master "${master.name}"`}. ` +
          `The cluster stays active throughout and no release pin is touched.`,
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
