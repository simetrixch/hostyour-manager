import { eq } from "drizzle-orm";
import type { Step, StepCtx } from "../../../executor/types.ts";
import type { Db } from "../../../db/client.ts";
import type { SshSession } from "../../../adapters/ssh/port.ts";
import { clusters, servers } from "../../../db/schema/inventory.ts";
import { errValidation } from "../../../kernel/errors.ts";
import { execCapture, remoteScriptCapture } from "../../../executor/stepkit.ts";
import { attestMachineId } from "../../../executor/attest.ts";
import { ATTEST_TARGET_STEP } from "../../../executor/guards.ts";
import { isMasterRole } from "../../../../shared/enums.ts";
import { clusterShortName } from "../../inventory/cluster-marking.ts";
import { argoAppsCmd, parsePipeRows, refreshPlatformCheckoutScript } from "./deploy-slave.remote.ts";
import { PLATFORM_CHECKOUT } from "./machine-state.ts";
import { loadServer, loadMaster, sleepUnlessAborted, type SlaveTarget } from "./deploy-slave.kit.ts";
import { requireElevationPassword } from "./ansiwise-run.kit.ts";

// The building blocks the run kinds that act on a LIVE cluster share:
//
//   attest-target     the fail-closed precondition below — the cluster is active and the machine
//                     is still the machine the platform adopted.
//   refresh-checkout  brings the machine's platform checkout (/srv/hostyour-cloud, the tree every
//                     deployment program acts on) onto the head of its install branch. The programs
//                     read that checkout as it stands and deliberately fetch nothing themselves, so
//                     whatever the manager just pushed — the cluster map commit on the machine's own
//                     branch above all — reaches the machine through this step or not at all.
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

/** WHERE a cluster's Applications live, and over which session they are read. A cluster carrying the
 *  MASTER part operates its own ArgoCD in namespace `argocd` on itself. A pure slave has no ArgoCD of
 *  its own: its Application CRs live in the per-slave instance in namespace <name> ON THE MASTER,
 *  which is why the session and the namespace are decided together and never separately. */
async function argoSurface(ctx: StepCtx, target: SlaveTarget): Promise<{ session: SshSession; namespace: string; where: string }> {
  const { domain } = target.resolve(ctx.db);
  const server = loadServer(ctx.db, target.serverId);
  if (isMasterRole(server.role)) {
    return { session: await ctx.ssh(), namespace: "argocd", where: `ns argocd on ${server.name}` };
  }
  const master = loadMaster(ctx.db);
  const name = clusterShortName(domain);
  return { session: await ctx.ssh(master.id), namespace: name, where: `ns ${name} on ${master.name}` };
}

/** The fail-closed precondition of every run kind that acts on a LIVE cluster: the cluster row is
 *  active (the target lookup refuses anything else) and the machine answering on that host is still
 *  the machine the platform adopted — a stranger VM on a recycled address must never be handed the
 *  deployment programs. */
export function attestClusterStep(target: SlaveTarget): Step {
  return {
    name: ATTEST_TARGET_STEP,
    title: "Attest the target (cluster state, machine identity)",
    run: async (ctx) => {
      const { domain, stage } = target.resolve(ctx.db);
      const server = loadServer(ctx.db, target.serverId);
      const session = await ctx.ssh();
      const outcome = await attestMachineId({ db: ctx.db, session, serverId: target.serverId, signal: ctx.signal, log: (l) => ctx.log("meta", l) });
      ctx.checkpoint({ domain, stage, machineId: outcome.machineId, machineIdAction: outcome.action });
      ctx.log("meta", `${server.name} attested — cluster ${domain} (${stage}, role ${server.role})`);
    },
  };
}

/** `refresh-checkout`: bring the machine's platform checkout onto the head of its install branch,
 *  tags included. Runs on the run's OWNED host, BEFORE the deployment programs read that checkout —
 *  a stale tree hands deploy-cluster old installer state and deploy-platform-services a cluster map
 *  the manager has since rewritten, and the programs deliberately fetch nothing themselves (a
 *  program acts on the tree it was pointed at; which state that tree stands on is the caller's to
 *  establish). */
export function refreshCheckoutStep(target: SlaveTarget): Step {
  return {
    name: "refresh-checkout",
    title: "Bring the machine's platform checkout onto its install branch head",
    run: async (ctx) => {
      const { domain } = target.resolve(ctx.db);
      const server = loadServer(ctx.db, target.serverId);
      const session = await ctx.ssh();
      const refresh = await remoteScriptCapture(ctx, session, "refresh-checkout", refreshPlatformCheckoutScript(domain), { timeoutMs: 2 * 60_000 });
      const heads = /^CHECKOUT_HEAD (\S+) (\S+)$/m.exec(refresh.stdout);
      if (refresh.result.code !== 0 || !heads) {
        throw errValidation(
          `could not refresh ${PLATFORM_CHECKOUT} on ${server.name} to origin/${domain} (exit ${refresh.result.code}) — ` +
          `the deployment programs read that checkout as it stands, so a stale tree would deliver the previous state; ` +
          `see the run log, fix the machine's checkout, then retry the run`,
        );
      }
      ctx.checkpoint({ host: server.name, branch: domain, head: heads[2] });
      ctx.log("meta", `${server.name}: ${PLATFORM_CHECKOUT} refreshed ${heads[1]}..${heads[2]} on ${domain}`);
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
 *  IT REACHES THE CLUSTER THE SAME WAY ITS FIVE NEIGHBOURS DO: with the elevation password the run
 *  asked for at approve, which is what the three program steps raise every one of their commands
 *  with. It used to ask for `sudo -n`, and that is a rule only the adoption puts on a machine — so
 *  on a master installed by ansiwise-client, which is never adopted, the last step of a redeploy was
 *  refused while every step before it had gone green. Measured on a first master on 2026-08-27:
 *  /etc/sudoers.d/ held only a README, and the run said "sudo: interactive authentication is
 *  required" under a line telling the operator the cluster was not answering yet. */
export function argocdFollowStep(target: SlaveTarget): Step {
  return {
    name: "argocd-follow",
    title: "Follow ArgoCD until the cluster's applications are Synced and Healthy",
    run: async (ctx) => {
      const { session, namespace, where } = await argoSurface(ctx, target);
      const elevation = requireElevationPassword(ctx);
      const deadline = Date.now() + ARGOCD_FOLLOW_TIMEOUT_MS;
      for (;;) {
        const read = await execCapture(ctx, session, argoAppsCmd(namespace), { timeoutMs: 60_000, elevation });
        const rows = read.code === 0 ? parsePipeRows(read.out) : [];
        const pending = rows.filter((row) => row[1] !== "Synced" || row[2] !== "Healthy");
        if (read.code === 0 && rows.length > 0 && pending.length === 0) {
          ctx.checkpoint({ namespace, applications: rows.length });
          ctx.log("meta", `all ${rows.length} applications in ${where} are Synced + Healthy — the cluster runs its branch's state`);
          return;
        }
        // A non-zero exit names the command and points at the log, and guesses at no cause: the
        // reading that guessed "not answering yet?" was printed under a REFUSED elevation for as
        // long as this step used `sudo -n`, and it sent the operator to look at the cluster.
        const detail = read.code !== 0
          ? `kubectl exit ${read.code} reading ${where} — the run log above carries what it said`
          : rows.length === 0
            ? "no Applications generated yet"
            : `${rows.length - pending.length}/${rows.length} ready — pending: ${pending.slice(0, 5).map((row) => `${row[0] ?? "?"} (${row[1] ?? "?"}/${row[2] ?? "?"})`).join(", ")}`;
        if (Date.now() >= deadline) {
          throw errValidation(`the applications in ${where} did not converge within ${ARGOCD_FOLLOW_TIMEOUT_MS / 60_000} min — last state: ${detail}`);
        }
        ctx.log("meta", `waiting for ${where} to converge (${detail})`);
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
