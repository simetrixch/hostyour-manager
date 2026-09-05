import { z } from "zod";
import { eq } from "drizzle-orm";
import type { Plan, RunDefinition, Step } from "../../../executor/types.ts";
import type { Db } from "../../../db/client.ts";
import { servers, clusters } from "../../../db/schema/inventory.ts";
import { errValidation } from "../../../kernel/errors.ts";
import { localTx } from "../../../executor/stepkit.ts";
import { attestMachineId } from "../../../executor/attest.ts";
import { isMasterRole } from "../../../../shared/enums.ts";
import { clusterMapPath } from "../../../../shared/cluster-values.ts";
import { removeClusterMarking } from "../../inventory/cluster-marking.ts";
import { ANSIWISE_ELEVATION_SECRET, type AnsiwisePorts } from "./ansiwise-run.kit.ts";
import { loadServer, loadMaster, masterFqdnOf, requirePlatformRepo, type DeploySlavePorts } from "./deploy-slave.kit.ts";
import { takeSlavePlaneDown } from "./deploy-slave.mgmt.ts";

// cluster-remove-slave — TAKING A SLAVE OUT OF AN INSTALLATION, as a run.
//
// Removing a slave was three shell files an operator ran from their own machine
// (hostyour-cloud lifecycle/remove-slave-from-master.sh, .ps1, remove-slave-driver.sh — 1,035 lines
// composing the answers of the remove-slave program by hand), and this manager's inventory was
// never told: a removed slave went on standing at `active`, with its cluster row, its plane and its
// server row all describing a machine nobody operates. So the act is a run kind, the answers are
// composed the way every other program run's are (composeAnswers reads what the program declares
// off the machine), and the rows follow the act in the same run that performed it.
//
// THE ACT ITSELF IS NOT WRITTEN HERE. It already stood in the tree as the compensating action
// cluster-deploy-slave arms when it builds a management plane, and both callers now go through
// takeSlavePlaneDown (deploy-slave.mgmt.ts). A removal an operator starts and a removal an abort
// performs must be the SAME removal, or the deliberate one is the one nobody has exercised.
//
// IT RUNS ON THE MASTER, and every step of it does. The slave itself is touched by nothing here —
// no session is opened to it, no program runs on it, and its machine layer is left exactly as it
// stands. A slave being removed is very often a machine that no longer answers at all (that is the
// ordinary reason to remove one), so a run that needed it to answer would refuse precisely the case
// it exists for. What is left on a machine that still answers is a cluster with no management plane
// on the master: inert, and the machine is then re-installed or thrown away.
//
// A MASTER+SLAVE IS REFUSED, by name, at step 0. Taking the slave part off a machine that also
// carries the master part leaves a live master whose branch and machine layer were installed under
// the combined role, so it needs the branch regenerated and the machine layer re-run — which this
// run kind does none of. It is a real case (cluster-deploy-slave's master arm produces exactly that
// machine), which is why the refusal is here and not left to be discovered on the master.

export const RemoveSlaveParams = z.object({
  serverId: z.string().startsWith("srv_"),
});
export type RemoveSlaveParams = z.infer<typeof RemoveSlaveParams>;

export type RemoveSlavePorts = DeploySlavePorts & AnsiwisePorts;

/** The one resolution of what this run acts on: the server row, its cluster, and the master every
 *  act runs on. Asked of the database at each step rather than carried, because steps() is handed
 *  the persisted params and no database — and because a run that resumes must read the rows as they
 *  stand now, not as they stood when it was planned. */
function resolveRemoval(db: Db, serverId: string): {
  server: typeof servers.$inferSelect;
  cluster: typeof clusters.$inferSelect;
  master: typeof servers.$inferSelect;
} {
  const server = loadServer(db, serverId);
  // A machine carrying the master part keeps its cluster whatever else it is; see the file header.
  if (isMasterRole(server.role)) {
    throw errValidation(
      `${server.name} carries the master part (role ${server.role}) — cluster-remove-slave takes a PURE slave out of the ` +
      "installation, and taking the slave part off a master leaves a live master whose branch and machine layer were " +
      "installed under the combined role; that is a regeneration and a machine-layer re-run, which this run kind does not do",
    );
  }
  const cluster = db.select().from(clusters).where(eq(clusters.serverId, serverId)).get();
  if (!cluster) {
    throw errValidation(
      `this manager records no cluster for ${server.name} — there is no slave here to remove; a server row with no cluster ` +
      "is deleted from the inventory instead (Servers → Delete)",
    );
  }
  return { server, cluster, master: loadMaster(db) };
}

/** Step 0, and its NAME is not a choice: assertGuardsArmed refuses to boot a mutating definition
 *  whose first step is called anything else, and Executor.skipStep refuses to wave exactly this name
 *  through (executor/guards.ts).
 *
 *  It attests the MASTER, which is the machine every act of this run kind reaches. Attesting the
 *  slave would refuse the case the run exists for — see the file header — and would prove nothing
 *  about the machine the destructive work actually lands on. */
function attestTargetStep(serverId: string): Step {
  return {
    name: "attest-target",
    title: "Attest the removal (a pure slave with a cluster, and the master this run acts on)",
    run: async (ctx) => {
      const { server, cluster, master } = resolveRemoval(ctx.db, serverId);
      if (master.id === serverId) throw errValidation(`${server.name} is the master of this installation — it is not a slave of it`);
      // ctx.ssh(master.id) and not the door: the master is the machine this manager was installed
      // from and it takes this manager's own key. A machine that would need the password door opened
      // is a machine no run of this manager has ever reached, which the master by definition is not.
      const session = await ctx.ssh(master.id);
      const outcome = await attestMachineId({ db: ctx.db, session, serverId: master.id, signal: ctx.signal, log: (l) => ctx.log("meta", l) });
      ctx.checkpoint({ clusterId: cluster.id, domain: cluster.domain, masterMachineId: outcome.machineId, machineIdAction: outcome.action });
      ctx.log("meta",
        `removing slave ${server.name} (cluster ${cluster.id}, ${cluster.domain}, ${cluster.status}) from the installation ` +
        `${master.name} keeps the books for — every act of this run is on ${master.name}`);
    },
  };
}

/** The removal itself: the map's slave part, then the remove-slave program on the master. The one
 *  implementation, shared with the compensating action cluster-deploy-slave arms. */
function removePlaneStep(serverId: string, ports: RemoveSlavePorts): Step {
  return {
    name: "remove-slave",
    title: "Remove the slave's management plane from the master (map part, then the remove-slave program)",
    run: async (ctx) => {
      const { cluster } = resolveRemoval(ctx.db, serverId);
      localTx(ctx, (tx) => tx.update(clusters).set({ status: "removing" }).where(eq(clusters.id, cluster.id)).run());
      await takeSlavePlaneDown(ctx, ports, { serverId, domain: cluster.domain, stage: cluster.stage });
      ctx.checkpoint({ clusterId: cluster.id, domain: cluster.domain });
    },
  };
}

/** The map file, after the plane is down. Last of the git acts, because dropping the slave part is
 *  what tears the generated per-slave Application down and the program above needs that to have
 *  happened; only once the master holds nothing about this cluster is the file describing nothing. */
function dropClusterMapStep(serverId: string, ports: RemoveSlavePorts): Step {
  return {
    name: "drop-cluster-map",
    title: "Take the cluster's map off the books branch",
    run: async (ctx) => {
      const { cluster } = resolveRemoval(ctx.db, serverId);
      const repo = requirePlatformRepo(ports);
      const { changed } = await removeClusterMarking(repo, cluster.domain, ctx.runId);
      ctx.log("meta", changed
        ? `${clusterMapPath(cluster.domain)} is gone from ${repo.booksBranch} — nothing in the installation describes this cluster any more`
        : `${clusterMapPath(cluster.domain)} is already gone from ${repo.booksBranch}`);
      ctx.checkpoint({ domain: cluster.domain, changed });
    },
  };
}

/** THE ROWS FOLLOW THE ACT, in the run that performed it. This is the whole of what the three shell
 *  files could never do: they removed the slave from the master and left this manager saying the
 *  cluster was `active`, with a plane and a set of per-slave credential ids describing a management
 *  surface that no longer existed.
 *
 *  The plane goes to `absent` and its JSON with it — every id in it names a Vault mount and an
 *  ArgoCD namespace the program has just deleted. The server goes to `undeployed`: the machine may
 *  well still be running, and what is true of it is that this installation no longer deploys it. */
function retireRowsStep(serverId: string): Step {
  return {
    name: "retire-rows",
    title: "Retire the inventory (cluster removed, plane absent, server undeployed)",
    run: async (ctx) => {
      const { server, cluster } = resolveRemoval(ctx.db, serverId);
      localTx(ctx, (tx) => {
        tx.update(clusters).set({ status: "removed", planeState: "absent", planeJson: null }).where(eq(clusters.id, cluster.id)).run();
        tx.update(servers).set({ status: "undeployed" }).where(eq(servers.id, serverId)).run();
      });
      ctx.checkpoint({ clusterId: cluster.id, clusterStatus: "removed", serverStatus: "undeployed" });
      ctx.log("meta", `cluster ${cluster.id} (${cluster.domain}) is removed and ${server.name} is undeployed — this installation operates it no longer`);
    },
  };
}

export function removeSlaveSteps(serverId: string, ports: RemoveSlavePorts): Step[] {
  return [
    attestTargetStep(serverId),
    removePlaneStep(serverId, ports),
    dropClusterMapStep(serverId, ports),
    retireRowsStep(serverId),
  ];
}

export function makeRemoveSlaveDef(ports: RemoveSlavePorts): RunDefinition<RemoveSlaveParams> {
  return {
    kind: "cluster-remove-slave",
    paramsSchema: RemoveSlaveParams,
    mutating: true,
    plan: async (params, { db }): Promise<Plan> => {
      const { server, cluster, master } = resolveRemoval(db, params.serverId);
      const stepDefs = removeSlaveSteps(params.serverId, ports);
      return {
        kind: "cluster-remove-slave",
        targetKind: "server",
        targetId: params.serverId,
        summary:
          `Remove the slave "${server.name}" (${cluster.domain}, ${cluster.stage}) from the installation ` +
          `"${master.name}" keeps the books for: ${stepDefs.length} steps, EVERY ONE OF THEM ON THE MASTER. ` +
          `The remove-slave program takes the coordinator membership, the auth mount and its roles, the policies and the ` +
          `per-slave reconciler project off "${master.name}"; the cluster's map then goes off the books branch, and this ` +
          `manager's rows follow — cluster ${cluster.id} to 'removed', ${server.name} to 'undeployed'. ` +
          `THE SLAVE ITSELF IS NOT TOUCHED: no session is opened to it and its machine layer is left standing, inert. ` +
          `Nothing here is undone by a later run — putting this machine back is a fresh deployment, which allocates a new ` +
          `ordinal, because an ordinal is never recycled. ` +
          `The password you enter raises every root command this run sends to "${master.name}" and the master's own ` +
          `programs; it is held in memory for the length of the run and stored nowhere.`,
        steps: stepDefs.map((s) => ({ name: s.name, title: s.title })),
        // The MASTER is the host every act runs on, and this run owns it for its duration: the
        // remove-slave program rewrites Vault and the reconciler's projects on it. The slave is
        // named as a target it does NOT own, because the run decides its fate and reaches it not at
        // all — an operator reading the card has to see both machines the run is about.
        targets: [
          { serverId: master.id, ownsHost: true, label: `${master.name} (${master.role}) — every act runs here` },
          { serverId: server.id, ownsHost: false, label: `${server.name} (${server.role}) — removed, never reached` },
        ],
        locks: [
          { resource: "git-branch", key: masterFqdnOf(db, master) },
          { resource: "master-kube", key: "m" },
        ],
        warnings: [
          `This is not reversible. The per-slave Vault mount, its policies and the ${server.name} reconciler project are destroyed on ${master.name}, and the credentials sealed for them stop naming anything.`,
          `${server.name} keeps whatever the deployment left on it. It is not wiped, not shut down and not disconnected from the private network — removing a slave from the installation and decommissioning a machine are two acts.`,
        ],
        requiredSecrets: [ANSIWISE_ELEVATION_SECRET],
      };
    },
    steps: (params) => removeSlaveSteps(String(params.serverId), ports),
  };
}
