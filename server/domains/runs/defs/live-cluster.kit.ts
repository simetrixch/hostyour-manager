import { eq } from "drizzle-orm";
import type { Step } from "../../../executor/types.ts";
import type { Db } from "../../../db/client.ts";
import type { ArgoApplicationRow } from "../../../adapters/kube/port.ts";
import { clusters, servers } from "../../../db/schema/inventory.ts";
import { AppError, errValidation } from "../../../kernel/errors.ts";
import { attestMachineId } from "../../../executor/attest.ts";
import { ATTEST_TARGET_STEP } from "../../../executor/guards.ts";
import {
  loadServer, requireResolver, sleepUnlessAborted, type DeploySlavePorts, type SlaveTarget,
} from "./deploy-slave.kit.ts";
import { openDoor } from "./manager-key.kit.ts";
import { ANSIWISE_ELEVATION_SECRET } from "./ansiwise-run.kit.ts";

// The building blocks the run kinds that act on a LIVE cluster share:
//
//   attest-target     the fail-closed precondition below — the cluster is active and the machine
//                     is still the one whose identity this manager recorded.
//   argocd-follow     waits until everything ArgoCD drives for that cluster has converged on the
//                     branch the host now stands on. Without it a run reports success while the
//                     cluster is still mid-sync, and the state it claims is unproven.
//
// The machine layer itself is delivered by the deployment PROGRAMS (deploy-cluster,
// deploy-platform-services), each driven over the machine's own `ansiwise-rest serve` surface by
// ansiwiseProgramStep — ArgoCD cannot deliver this, because the operating system and the Kubernetes
// install are what ArgoCD RUNS ON.

/** How long argocd-follow waits for a cluster to converge. Generous for the same reason the slave
 *  verify window is: after the branch moves, every Application re-syncs and the node may pull images
 *  for the whole platform. */
const ARGOCD_FOLLOW_TIMEOUT_MS = 30 * 60_000;

/** Poll cadence of the follow — slow enough to keep the run log readable. */
const ARGOCD_FOLLOW_POLL_MS = 10_000;

/** The fail-closed precondition of every run kind that acts on a LIVE cluster: the cluster row is
 *  active (the target lookup refuses anything else) and the machine answering on that host is still
 *  the one whose identity this manager recorded — a stranger VM on a recycled address must never be
 *  handed the deployment programs.
 *
 *  THE READING IS TAKEN THROUGH THE DOOR, exactly as the slave install's own attest takes it
 *  (deploy-slave.attest.ts). This is the first command such a run sends, and a machine reinstalled at
 *  the hosting provider carries no line of this manager's: a session offering the key alone is
 *  refused there, and the run would die before the steps that put the key back had a chance to run.
 *  openDoor offers the key where the machine takes it, the run's own password where it does not, and
 *  refuses every credential where the host key on the row and the host key on the wire disagree
 *  (manager-key.kit.ts). The secret is the same one every root command of these run kinds is raised
 *  with, so the door asks the operator for nothing the approve did not already collect. */
export function attestClusterStep(target: SlaveTarget): Step {
  return {
    name: ATTEST_TARGET_STEP,
    title: "Attest the target (cluster state, machine identity)",
    run: async (ctx) => {
      const { domain, stage } = target.resolve(ctx.db);
      const server = loadServer(ctx.db, target.serverId);
      const session = await openDoor(ctx, ANSIWISE_ELEVATION_SECRET);
      const outcome = await attestMachineId({ db: ctx.db, session, serverId: target.serverId, signal: ctx.signal, log: (l) => ctx.log("meta", l) });
      ctx.checkpoint({ domain, stage, machineId: outcome.machineId, machineIdAction: outcome.action });
      ctx.log("meta", `${server.name} attested — cluster ${domain} (${stage}, role ${server.role})`);
    },
  };
}

/** `argocd-follow`: wait until every Application ArgoCD drives for this cluster is Synced AND Healthy.
 *
 *  Synced is what makes this a statement about the BRANCH and not merely about health: every
 *  Application of a cluster tracks that cluster's install branch — so "Synced" says the cluster runs
 *  that branch's revision, and there is nothing left for the run to claim on its own. Bounded and
 *  abortable; zero Applications means the appset has not generated yet and is retried, never read as
 *  "nothing to wait for".
 *
 *  IT SENDS THE CLUSTER NOTHING. The Applications are read over the Manager pod's own
 *  ServiceAccount, through the same resolver every unit run kind reaches ArgoCD with, and both the
 *  reader and the namespace come from ONE resolve: `argoNamespace` is `argocd` for a target carrying
 *  the master part and the per-slave instance's namespace on the master for a slave, and pairing
 *  them anywhere else would put that pairing one rename away from coming apart
 *  (domains/units/cluster-kube.ts). What this used to do was run `microk8s kubectl` over the
 *  target's SSH session every ten seconds for up to thirty minutes, raising every one of those
 *  reads to root with the machine's elevation password. */
export function argocdFollowStep(target: SlaveTarget, ports: DeploySlavePorts): Step {
  return {
    name: "argocd-follow",
    title: "Follow ArgoCD until the cluster's applications are Synced and Healthy",
    run: async (ctx) => {
      const { cluster } = loadActiveCluster(ctx.db, target.serverId);
      const { argoReader, argoNamespace } = await requireResolver(ports).resolve(cluster.id);
      const where = `ns ${argoNamespace}`;
      const deadline = Date.now() + ARGOCD_FOLLOW_TIMEOUT_MS;
      for (;;) {
        // A kube read that failed is a failing TICK and not a step death. This step runs right after
        // deploy-platform-services restarted kubelite on the master arm, and the Manager's own
        // reader is on that API server: the pod loses it mid-follow by design (ansiwise-run.kit.ts
        // says so where the restart is driven). The retry ends at the same deadline.
        let rows: ArgoApplicationRow[] | undefined;
        let refusal = "";
        try {
          rows = await argoReader.listApplications(argoNamespace);
        } catch (e) {
          if (!(e instanceof AppError) || e.code !== "UPSTREAM") throw e;
          refusal = `the kube API did not answer — ${e.message}`;
        }
        if (rows !== undefined) {
          const pending = rows.filter((row) => row.sync !== "Synced" || row.health !== "Healthy");
          if (rows.length > 0 && pending.length === 0) {
            ctx.checkpoint({ namespace: argoNamespace, applications: rows.length });
            ctx.log("meta", `all ${rows.length} applications in ${where} are Synced + Healthy — the cluster runs its branch's state`);
            return;
          }
          refusal = rows.length === 0
            ? "no Applications generated yet"
            : `${rows.length - pending.length}/${rows.length} ready — pending: ${pending.slice(0, 5).map((row) => `${row.name} (${row.sync}/${row.health})`).join(", ")}`;
        }
        if (Date.now() >= deadline) {
          throw errValidation(`the applications in ${where} did not converge within ${ARGOCD_FOLLOW_TIMEOUT_MS / 60_000} min — last state: ${refusal}`);
        }
        ctx.log("meta", `waiting for ${where} to converge (${refusal})`);
        await sleepUnlessAborted(ARGOCD_FOLLOW_POLL_MS, ctx.signal);
      }
    },
  };
}

/** The cluster a run kind acts on, with its server — the lookup a cluster-level def makes in plan(),
 *  where a database IS available. Refuses anything but an ACTIVE cluster: a redeploy acts on a
 *  cluster that is already running. */
export function loadActiveCluster(db: Db, serverId: string): {
  server: typeof servers.$inferSelect;
  cluster: typeof clusters.$inferSelect;
} {
  const server = loadServer(db, serverId);
  const cluster = db.select().from(clusters).where(eq(clusters.serverId, serverId)).get();
  if (!cluster) throw errValidation(`server ${server.name} carries no cluster — deploy it first`);
  if (cluster.status !== "active") {
    throw errValidation(`cluster ${cluster.id} for ${cluster.domain} is '${cluster.status}' — this run kind acts on a LIVE cluster`);
  }
  return { server, cluster };
}
