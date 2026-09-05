import { eq } from "drizzle-orm";
import type { Step, StepCtx } from "../../../executor/types.ts";
import { servers } from "../../../db/schema/inventory.ts";
import { errValidation } from "../../../kernel/errors.ts";
import { localTx } from "../../../executor/stepkit.ts";
import {
  clusterShortName, resolveClusterMarking, writeClusterMarking,
} from "../../inventory/cluster-marking.ts";
import { clusterMapPath } from "../../../../shared/cluster-values.ts";
import { loadMaster, loadServer, requirePlatformRepo, type DeploySlavePorts, type SlaveTarget } from "./deploy-slave.kit.ts";
import { coordinatorNodesOf, describeNode, ipv4Of } from "./tailnet.coordinator.ts";

// THE ADDRESS THE MASTER'S CLUSTER WILL DIAL, taken from the one that handed it out.
//
// `servers.tailnetHost` is the slave's `apiHost` in the cluster map (deploy-slave.kit.ts
// `slaveApiHost`): what the master's own in-cluster components — its per-slave ArgoCD, Vault on every
// ESO login, the shared dashboard, the Manager's own kube client — reach this machine's
// kube-apiserver on. Two things have to be true of it at once, and they pull in opposite directions:
//
//   it must be the address the machine ACTUALLY holds — its kube-apiserver answers there, and a
//       machine cannot answer on an address it was not given;
//   it must NOT be the machine's own account of itself — the host this manager is about to trust
//       may not be the host that names where the trust goes.
//
// The coordinator satisfies both. It is a workload of the master's own cluster, it ASSIGNED the
// address, and it is not the machine being deployed. So the platform still states one value; it
// just stops asking a person for a number that does not exist yet when the person is asked.
//
// WHY NOBODY CAN TYPE IT AT SERVER-CREATION TIME. headscale 0.29.2 has no way to be told an address
// in advance — neither `preauthkeys create` (--ephemeral, --expiration, --reusable, --tags, --user)
// nor any `nodes` subcommand (approve-routes, backfillips, delete, expire, list, list-routes,
// rename, tag) takes one. The value first exists when the node registers, which happens in the
// rejoin step of the very run that then needs it.
//
// IT READS ON EVERY DEPLOYMENT, not only after a first join: a rejoin hands the machine a FRESH
// address (hostyour-deploy ansiwise/programs/tailnet-rejoin.yaml says so in its own head), and a row
// still carrying the previous one points everything the master does at a machine that stopped
// answering there.

/** The map's `apiHost`, brought to the address the coordinator gave.
 *
 *  WHY THE MAP NEEDS A SECOND WRITE AT ALL. `mark-slave` composes the whole map eight steps before
 *  the machine joins, and takes `apiHost` from `slaveApiHost` — `tailnetHost ?? lanHost ?? host`.
 *  On a first deployment the column it reads is still empty, because the address does not exist
 *  until the join, so the map is written with the machine's LAN or public name. What consumes it is
 *  the master's own ArgoCD entry for this cluster: the slaves ApplicationSet feeds `slave.apiHost`
 *  into clusters/slaves/slave/templates/externalsecret-cluster-slave.yaml, which renders
 *  `server: "https://<apiHost>:<apiPort>"` with verification on. The machine's serving certificate
 *  carries its addresses as IP entries and never its domain name, so the name the map was written
 *  with is a name that dial cannot verify.
 *
 *  IT IS THE SAME VALUE IN THE SAME ACT. This step is where the address becomes known, so it is
 *  where both places that state it are brought to it — the inventory row the manager dials, and the
 *  map the master's reconciler dials. The map is written ONCE, on the books branch, because that is
 *  the one branch an installation keeps maps on and the one a slave's own checkout stands on.
 *
 *  A REJOIN IS THE OTHER HALF. It hands a machine a FRESH address, and a map left on the previous
 *  one points the master's reconciler at something that has stopped answering there. */
async function alignMapAddress(ctx: StepCtx, ports: DeploySlavePorts, domain: string, address: string): Promise<boolean> {
  const repo = requirePlatformRepo(ports);
  const marking = await resolveClusterMarking(repo, domain);
  if (marking.apiHost === address) {
    ctx.log("meta", `${clusterMapPath(domain)} already states apiHost ${address} — nothing to write`);
    return false;
  }
  const corrected = { ...marking, apiHost: address };
  await writeClusterMarking(repo, corrected, ctx.runId);
  ctx.log(
    "meta",
    `${clusterMapPath(domain)} now states apiHost ${address}, was ${marking.apiHost ?? "unset"} — the address the ` +
    `coordinator gave this machine, on ${repo.booksBranch}`,
  );
  return true;
}

/** `declare-tailnet-address`: ask the coordinator which address it gave this slave, and put that on
 *  the slave's row and in its cluster map.
 *
 *  It stands between the join and `enable-ansiwise-service`, and OUTSIDE the redeploy guard the
 *  rejoin sits in: a redeploy does not join again, but it is the run that has to notice a row whose
 *  address went stale — and on a machine deployed before this step existed it is the run that fills
 *  the column for the first time. */
export function declareTailnetAddressStep(target: SlaveTarget, serverId: string, ports: DeploySlavePorts): Step {
  return {
    name: "declare-tailnet-address",
    title: "Declare the address the coordinator gave this machine",
    run: async (ctx) => {
      const { domain, stage } = target.resolve(ctx.db);
      const server = loadServer(ctx.db, serverId);
      // The slave's name AT THE COORDINATOR — the first label of its domain, which is what the mint
      // program files its user under (`user_answer: slave_cluster_name`, derived
      // `first_dns_label_of`). Filing and reading are one name or neither works.
      const owner = clusterShortName(domain);
      const master = loadMaster(ctx.db);
      // ON THE MASTER, because that is where the coordinator runs — this step deliberately never
      // touches the machine being deployed.
      const session = await ctx.ssh(master.id);
      const mine = await coordinatorNodesOf(ctx, session, stage, owner);

      // NO NODE. The join is what creates it, and it stands earlier in this same run — so this is a
      // machine whose registration did not land, not a row waiting to be filled in.
      if (mine.length === 0) {
        throw errValidation(
          `the coordinator lists no node owned by "${owner}", and that is the name this platform files ${server.name} ` +
          "under — the join earlier in this run is what registers it, so read that step's record rather than this one",
        );
      }
      // TWO NODES, and the manager may not pick. Its token would go to whichever it guessed, and one
      // of the two is a machine nobody meant — a registration from an earlier life of this slave, or
      // something else that joined under the same name.
      if (mine.length > 1) {
        throw errValidation(
          `the coordinator lists ${mine.length} nodes owned by "${owner}": ${mine.map(describeNode).join(" and ")}. The ` +
          "cluster map carries one address for this machine, so this step may not choose between them — delete the node " +
          "that is not this machine at the coordinator, then run this step again",
        );
      }
      const address = ipv4Of(mine[0]!);
      if (address === undefined) {
        throw errValidation(
          `the coordinator lists ${describeNode(mine[0]!)} for "${owner}" but no IPv4 among its addresses — a cluster ` +
          "map's apiHost carries four numbers and nothing else, so there is no address here to declare",
        );
      }

      const before = server.tailnetHost;
      if (before === address) {
        ctx.log("meta", `${server.name} already declares ${address}, which is what the coordinator gave it — nothing to write`);
      } else {
        // The previous value is SAID and not silently replaced: on a rejoin this is the moment the
        // old address stops being the one anything should dial, and that is worth reading in the log
        // of the run that changed it.
        localTx(ctx, (tx) => tx.update(servers).set({ tailnetHost: address }).where(eq(servers.id, serverId)).run());
        ctx.log(
          "meta",
          before === null
            ? `${server.name} now declares ${address} — the address the coordinator gave it at the join above`
            : `${server.name} now declares ${address}, replacing ${before} — the coordinator hands a fresh address at every join`,
        );
      }
      // The row and the map state the same address or the master's reconciler and this manager dial
      // two different machines. Done after the row, so a map write that fails leaves the row already
      // right and the step retryable from a state that is closer, not further.
      const map = await alignMapAddress(ctx, ports, domain, address);
      ctx.checkpoint({ address, written: before !== address, replaced: before, map });
    },
  };
}
