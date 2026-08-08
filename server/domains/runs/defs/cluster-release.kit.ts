import { eq } from "drizzle-orm";
import type { Step, StepCtx } from "../../../executor/types.ts";
import type { Db } from "../../../db/client.ts";
import type { SshSession } from "../../../adapters/ssh/port.ts";
import { clusters, servers } from "../../../db/schema/inventory.ts";
import { errValidation } from "../../../kernel/errors.ts";
import { remoteCmd, remoteScriptCapture } from "../../../executor/stepkit.ts";
import { attestMachineId } from "../../../executor/attest.ts";
import { ATTEST_TARGET_STEP } from "../../../executor/guards.ts";
import { isMasterRole } from "../../../../shared/enums.ts";
import { clusterShortName } from "../../inventory/cluster-marking.ts";
import { argoAppsCmd, parsePipeRows, refreshCheckoutScript, RESOLVE_REPO_DIR } from "./deploy-slave.remote.ts";
import { loadServer, loadMaster, sleepUnlessAborted, type SlaveTarget } from "./deploy-slave.kit.ts";

// The two building blocks a cluster stands on below GitOps, shared by the two verbs that rebuild or
// raise it:
//
//   host-run       re-runs the installer on the host itself, over SSH. ArgoCD cannot deliver this —
//                  the operating system and the Kubernetes install are what ArgoCD RUNS ON. The
//                  installer is re-runnable by design, so it always runs: "check whether the scripts
//                  changed, then decide" is a case distinction someone has to maintain and that will
//                  eventually be wrong.
//   argocd-follow  waits until everything ArgoCD drives for that cluster has converged on the branch
//                  the host now stands on. Without it a run reports success while the cluster is
//                  still mid-sync, and the state it claims is unproven.
//
// A cluster RELEASE runs both after it has moved the pin. A REDEPLOY of a cluster carrying the master
// part runs exactly these two and moves no pin — the machine layer is restorable without a version
// change. That is the whole difference between the two verbs at this level.

/** How long argocd-follow waits for a cluster to converge. Generous for the same reason the slave
 *  verify window is: after the branch moves, every Application re-syncs and the node may pull images
 *  for the whole platform. Exported so tests can expire it under fake timers. */
export const ARGOCD_FOLLOW_TIMEOUT_MS = 30 * 60_000;

/** Poll cadence of the follow — slow enough to keep the run log readable. */
export const ARGOCD_FOLLOW_POLL_MS = 10_000;

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

/** The fail-closed precondition of every verb that acts on a LIVE cluster: the cluster row is
 *  active (the target lookup refuses anything else) and the machine answering on that host is still
 *  the machine the platform adopted — a stranger VM on a recycled address must never be handed
 *  setup.sh. `check` is where a verb adds its OWN precondition; a release checks the channel ceiling
 *  there, so the refusal lands before the step that would write a pin. */
export function attestClusterStep(target: SlaveTarget, check?: (ctx: StepCtx) => Promise<void>): Step {
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
      if (check) await check(ctx);
    },
  };
}

/** `host-run`: refresh the host's checkout to its install branch, then re-run the installer for the
 *  cluster's stage. Runs on the run's OWNED host — for a master that is the master itself, for a slave
 *  its own machine — so the same step serves both without a case distinction of its own. */
export function hostRunStep(target: SlaveTarget): Step {
  return {
    name: "host-run",
    title: "Run the installer on the host (refresh the checkout, then setup.sh)",
    run: async (ctx) => {
      const { domain, stage } = target.resolve(ctx.db);
      const server = loadServer(ctx.db, target.serverId);
      const session = await ctx.ssh();
      // The checkout must stand on the branch state this run is delivering BEFORE setup.sh reads it —
      // a stale tree runs old installer code and silently installs the previous release.
      const refresh = await remoteScriptCapture(ctx, session, "refresh-checkout", refreshCheckoutScript(domain), { timeoutMs: 2 * 60_000 });
      const heads = /^CHECKOUT_HEAD (\S+) (\S+)$/m.exec(refresh.stdout);
      if (refresh.result.code !== 0 || !heads) {
        throw errValidation(
          `could not refresh the GitOps checkout on ${server.name} to origin/${domain} (exit ${refresh.result.code}) — ` +
          `setup.sh must run from the CURRENT install-branch head, never a stale tree; see the run log, fix the host's checkout, then retry the run`,
        );
      }
      ctx.log("meta", `${server.name}: checkout refreshed ${heads[1]}..${heads[2]} on ${domain}`);
      // The whole host-side imperative surface: MicroK8s, addons, storage, cert-manager. The
      // budget is the cold-install one — a release may bring a MicroK8s channel change with it.
      await remoteCmd(ctx, session, `${RESOLVE_REPO_DIR}\ncd "$GITOPS_DIR" && sudo -n ./setup.sh --${stage}`, { timeoutMs: 45 * 60_000 });
      ctx.checkpoint({ host: server.name, branch: domain, head: heads[2] });
      ctx.log("meta", `${server.name}: setup.sh --${stage} completed — the machine layer stands on ${domain}@${heads[2]}`);
    },
  };
}

/** `argocd-follow`: wait until every Application ArgoCD drives for this cluster is Synced AND Healthy.
 *
 *  Synced is what makes this a statement about the PIN and not merely about health: every Application
 *  of a cluster tracks that cluster's install branch, and the branch is the state the release
 *  regenerated from the tag — so "Synced" says the cluster runs the pinned revision, and there is
 *  nothing left for the run to claim on its own. Bounded and abortable; zero Applications means the
 *  appset has not generated yet and is retried, never read as "nothing to wait for". */
export function argocdFollowStep(target: SlaveTarget): Step {
  return {
    name: "argocd-follow",
    title: "Follow ArgoCD until the cluster's applications are Synced and Healthy",
    run: async (ctx) => {
      const { session, namespace, where } = await argoSurface(ctx, target);
      const deadline = Date.now() + ARGOCD_FOLLOW_TIMEOUT_MS;
      for (;;) {
        const lines: string[] = [];
        const r = await session.exec(argoAppsCmd(namespace), {
          signal: ctx.signal,
          timeoutMs: 60_000,
          onStdout: (l) => {
            lines.push(l);
            ctx.log("stdout", l);
          },
          onStderr: (l) => ctx.log("stderr", l),
        });
        const rows = r.code === 0 ? parsePipeRows(lines.join("\n")) : [];
        const pending = rows.filter((row) => row[1] !== "Synced" || row[2] !== "Healthy");
        if (r.code === 0 && rows.length > 0 && pending.length === 0) {
          ctx.checkpoint({ namespace, applications: rows.length });
          ctx.log("meta", `all ${rows.length} applications in ${where} are Synced + Healthy — the cluster runs the pinned state`);
          return;
        }
        const detail = r.code !== 0
          ? `kubectl exit ${r.code} (${where} not answering yet?)`
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

/** The cluster a verb acts on, with its server — the lookup both cluster-level defs make in plan(),
 *  where a database IS available. Refuses anything but an ACTIVE cluster: a release and a redeploy
 *  both act on a cluster that is already running. */
export function loadActiveCluster(db: Db, serverId: string): {
  server: typeof servers.$inferSelect;
  cluster: typeof clusters.$inferSelect;
} {
  const server = loadServer(db, serverId);
  const cluster = db.select().from(clusters).where(eq(clusters.serverId, serverId)).get();
  if (!cluster) throw errValidation(`server ${server.name} carries no cluster — deploy it first`);
  if (cluster.status !== "active") {
    throw errValidation(`cluster ${cluster.id} for ${cluster.domain} is '${cluster.status}' — this verb acts on a LIVE cluster`);
  }
  return { server, cluster };
}
