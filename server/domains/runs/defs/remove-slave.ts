import { z } from "zod";
import { eq } from "drizzle-orm";
import type { Cleanup, Plan, RunDefinition, Step, StepCtx } from "../../../executor/types.ts";
import type { Db } from "../../../db/client.ts";
import { servers, clusters } from "../../../db/schema/inventory.ts";
import { errValidation } from "../../../kernel/errors.ts";
import { localTx } from "../../../executor/stepkit.ts";
import { attestMachineId } from "../../../executor/attest.ts";
import { isMasterRole } from "../../../../shared/enums.ts";
import { clusterMapPath } from "../../../../shared/cluster-values.ts";
import { holdsManagerKey } from "../../../security/store.ts";
import { removeClusterMarking } from "../../inventory/cluster-marking.ts";
import { ANSIWISE_ELEVATION_SECRET, type AnsiwisePorts } from "./ansiwise-run.kit.ts";
import { loadServer, loadMaster, masterFqdnOf, requirePlatformRepo, type DeploySlavePorts } from "./deploy-slave.kit.ts";
import { takeSlavePlaneDown } from "./deploy-slave.mgmt.ts";
import { leaveHostCleanup, removeManagerKeyCleanup } from "./leave-host.kit.ts";
import { restorePasswordLoginCleanup } from "./password-login.kit.ts";

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
// LEAVING A MACHINE PUTS IT BACK, and this run kind leaves one. The three machine-side acts are the
// SAME code an aborted cluster-deploy-slave runs (defs/leave-host.kit.ts, defs/password-login.kit.ts):
// everything this platform wrote off the machine, the password door back on, and this manager's key
// line off it and out of the store. A machine that leaves an installation with our key still in its
// authorized_keys and its password door still shut is a machine nobody but us can reach and that we
// no longer operate, which is the state the owner's decision of 2026-09-06 names.
//
// THE ORDER IS THE ABORT'S, for the same reason it is the abort's: each act runs while the route the
// next one needs is still open. The master-side removal goes FIRST, while the coordinator still
// knows the node; then the machine is stripped over a session both routes are open for; then the
// password door goes back on; then the key line comes off, LAST, because it is the route every act
// above travels. The map and the rows follow, because they describe what has already happened.
//
// A SLAVE THAT NO LONGER ANSWERS IS THE ORDINARY CASE, and it is the reason a machine gets removed
// at all. So every machine-side step MEASURES FIRST — does this manager hold a key for the machine,
// and does that key open a session — and where it does not, it says which act it is skipping and on
// which machine, and the run goes on with the master side and the rows. No machine-side step ever
// fails the run for a machine that is gone, and none of them guesses that a machine is gone from a
// row: `status` says where a deployment stands and is written by runs that never opened a session.
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

/** THE MEASUREMENT EVERY MACHINE-SIDE STEP TAKES FIRST: can this manager still reach the slave over
 *  its own key? Two absences, and the log says which one it is, because they are undone differently
 *  — a machine no key is sealed for is one an earlier removal already took the key off, and a
 *  machine that answers nothing is one that is gone or off the network.
 *
 *  IT IS ASKED OF THE CREDENTIAL AND OF THE SESSION, never of `servers.status`: the status column
 *  says where a deployment stands and is moved by runs that opened no session at all, so a machine
 *  reading `healthy` may answer nothing and a machine reading `undeployed` may answer at once.
 *
 *  The session it opens is the one the act then uses — ctx.ssh() hands back the session it cached
 *  for this host, so measuring costs one connect and not two. */
async function slaveAnswers(ctx: StepCtx, act: string): Promise<boolean> {
  const server = loadServer(ctx.db, String(ctx.params.serverId));
  if (!holdsManagerKey(ctx.db, server.id)) {
    ctx.log("meta",
      `${act} is skipped: this manager holds no SSH key for ${server.name} any more, so there is no route to it. ` +
      `Whatever stands on that machine stays on it; the master side of this removal goes on.`);
    return false;
  }
  try {
    await ctx.ssh();
    return true;
  } catch (err) {
    ctx.log("meta",
      `${act} is skipped: ${server.name} does not answer this manager's key (${err instanceof Error ? err.message : String(err)}). ` +
      `That is the ordinary reason a slave is removed; whatever stands on that machine stays on it, and the master side of ` +
      `this removal goes on.`);
    return false;
  }
}

/** One of cluster-deploy-slave's compensating actions, run as a STEP of this run kind. The same
 *  function and not a copy of it: a machine put back by a deliberate removal and a machine put back
 *  by an aborted install must be put back the same way, or the deliberate one is the one nobody has
 *  exercised. A Cleanup and a Step are the same shape (executor/types.ts), so the only thing this
 *  adds is the measurement in front. */
function machineSideStep(act: Cleanup): Step {
  return {
    name: act.name,
    title: act.title,
    run: async (ctx) => {
      if (!await slaveAnswers(ctx, act.name)) {
        ctx.checkpoint({ act: act.name, reached: false });
        return;
      }
      await act.run(ctx);
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
 *  ArgoCD namespace the program has just deleted.
 *
 *  THE SERVER'S OWN ROW IS WRITTEN BY WHICHEVER OF THE TWO THINGS HAPPENED. A machine that was put
 *  back already stands at `bare`: remove-manager-key set it there when it took the last route off,
 *  and that is what a machine nothing has reached is. Writing `undeployed` over it would say this
 *  installation still holds something on a machine it holds nothing on, and a fresh first contact
 *  reads `bare` as the state to start from. A machine that never answered keeps whatever the
 *  deployment left on it, so it goes to `undeployed`: it may well still be running, and what is true
 *  of it is that this installation no longer deploys it. */
function retireRowsStep(serverId: string): Step {
  return {
    name: "retire-rows",
    title: "Retire the inventory (cluster removed, plane absent, the server as its machine now stands)",
    run: async (ctx) => {
      const { server, cluster } = resolveRemoval(ctx.db, serverId);
      const putBack = server.status === "bare";
      localTx(ctx, (tx) => {
        tx.update(clusters).set({ status: "removed", planeState: "absent", planeJson: null }).where(eq(clusters.id, cluster.id)).run();
        if (!putBack) tx.update(servers).set({ status: "undeployed" }).where(eq(servers.id, serverId)).run();
      });
      ctx.checkpoint({ clusterId: cluster.id, clusterStatus: "removed", serverStatus: putBack ? "bare" : "undeployed" });
      ctx.log("meta", putBack
        ? `cluster ${cluster.id} (${cluster.domain}) is removed and ${server.name} stands at bare — it was put back and this installation holds nothing on it`
        : `cluster ${cluster.id} (${cluster.domain}) is removed and ${server.name} is undeployed — this installation operates it no longer`);
    },
  };
}

export function removeSlaveSteps(serverId: string, ports: RemoveSlavePorts): Step[] {
  return [
    attestTargetStep(serverId),
    removePlaneStep(serverId, ports),
    machineSideStep(leaveHostCleanup(ANSIWISE_ELEVATION_SECRET)),
    machineSideStep(restorePasswordLoginCleanup(ANSIWISE_ELEVATION_SECRET)),
    machineSideStep(removeManagerKeyCleanup),
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
          `"${master.name}" keeps the books for, and PUT THE MACHINE BACK: ${stepDefs.length} steps over two machines. ` +
          `On "${master.name}": the remove-slave program takes the coordinator membership, the auth mount and its roles, ` +
          `the policies and the per-slave reconciler project off it. ` +
          `On "${server.name}", IF IT STILL ANSWERS this manager's key: everything this platform wrote goes off it — the ` +
          `paths it owns, both engine executables, the cluster snap with its data and the private-network membership — ` +
          `then password login goes back on, then this manager's key line comes off the machine and out of the store. ` +
          `IF IT DOES NOT ANSWER, each of those three steps says so by name and the run goes on: a slave that is gone is ` +
          `the ordinary reason to remove one, and nothing here fails on it. ` +
          `The cluster's map then goes off the books branch and this manager's rows follow — cluster ${cluster.id} to ` +
          `'removed', and ${server.name} to 'bare' where it was put back or 'undeployed' where it never answered. ` +
          `Nothing here is undone by a later run — putting this machine back into service is a fresh deployment, which ` +
          `allocates a new ordinal, because an ordinal is never recycled. ` +
          `The password you enter raises every root command this run sends to either machine and the master's own ` +
          `programs; it is held in memory for the length of the run and stored nowhere.`,
        steps: stepDefs.map((s) => ({ name: s.name, title: s.title })),
        // BOTH MACHINES ARE OWNED, and the run holds a `server:<id>` lock on each for its duration
        // (executor/locks.ts deriveServerLocks): the remove-slave program rewrites Vault and the
        // reconciler's projects on the master, and the machine-side steps strip the slave and take
        // the way in off it. A second run touching either while this one is stripping it is what the
        // locks are for.
        targets: [
          { serverId: master.id, ownsHost: true, label: `${master.name} (${master.role}) — the master side runs here` },
          { serverId: server.id, ownsHost: true, label: `${server.name} (${server.role}) — removed, and put back where it answers` },
        ],
        locks: [
          { resource: "git-branch", key: masterFqdnOf(db, master) },
          { resource: "master-kube", key: "m" },
        ],
        warnings: [
          `This is not reversible. The per-slave Vault mount, its policies and the ${server.name} reconciler project are destroyed on ${master.name}, and the credentials sealed for them stop naming anything.`,
          `Where ${server.name} answers, this run takes this manager's key off it and puts password login back on. After that the only way in is a password somebody sets at the machine: the bootstrap password the deployment destroyed cannot be minted again.`,
          `Where ${server.name} does not answer, it keeps everything the deployment left on it, this manager's key line included. It is not wiped and not shut down — removing a slave from the installation and decommissioning a machine are two acts.`,
          `Three things no leave puts back, on a machine that does answer: the destroyed bootstrap password, the packages deploy-host installed (git, openssl, curl, jq, apache2-utils) and the clock sources it wrote. Nothing recorded what the machine had before them.`,
        ],
        requiredSecrets: [ANSIWISE_ELEVATION_SECRET],
      };
    },
    steps: (params) => removeSlaveSteps(String(params.serverId), ports),
  };
}
