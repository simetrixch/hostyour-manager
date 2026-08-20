import { z } from "zod";
import { eq } from "drizzle-orm";
import type { RunDefinition, Step } from "../../executor/types.ts";
import { apps } from "../../db/schema/inventory.ts";
import { errValidation } from "../../kernel/errors.ts";
import { consumerArgoAppName } from "../../../shared/consumer.ts";
import type { ArgoAppStatus } from "../../adapters/kube/port.ts";
import { localTx } from "../../executor/stepkit.ts";
import { attestTargetStep, loadAppCluster, type LifecyclePorts } from "./lifecycle.ts";

// suspend / resume. Both are a FIELD FLIP of the stage registration: `suspended`
// is not a generator selector, so the Application keeps being generated either way and the chart
// renders the off state (replicas 0, no Ingress). A prune-based suspend would be destructive by
// construction — the charts render ServiceClaims whose deprovision finalizer runs on EVERY claim
// deletion, an ArgoCD prune included, and drops the user AND the databases. So each run kind flips the
// field, waits for ArgoCD to converge on the new render, and moves the row. Both are mutating
// (attest-target first) and keep the consumer row throughout.

export const SuspendResumeParams = z.object({ appId: z.string().startsWith("app_") });
export type SuspendResumeParams = z.infer<typeof SuspendResumeParams>;

/** The branches both run kinds must hold, in the order the other consumer runs claim them (onboard,
 *  offboard, purge, backup, restore, migrate). The FLIP commits on the books branch — the install
 *  branch of the cluster holding the master role — so that is the key that serializes it; a lock on
 *  the consumer's own cluster domain names a branch this run never writes and would let a concurrent
 *  offboard hard-reset the shared books worktree between this run's fetch and its commit. The
 *  consumer's cluster branch is claimed too, because the converge watch reads that cluster. */
const gitBranchLocks = (booksBranch: string, domain: string) => [
  { resource: "git-branch" as const, key: booksBranch },
  { resource: "git-branch" as const, key: domain },
];
const masterKubeLock = { resource: "master-kube" as const, key: "m" };

/** Wait for the GENERATED Application (`<name>-<stage>`) to converge on the render the flip just
 *  asked for. Both run kinds wait for the SAME condition — Synced/Healthy — because neither prunes: the
 *  suspended render is still a full, healthy Application, it simply carries no replicas and no
 *  Ingress. `intent` only names the state in the message. Sync REVISIONS are deliberately not
 *  compared: the registration states no revision at all, the Application follows the delivery branch,
 *  and a branch tip moves. */
function watchConvergedStep(ports: LifecyclePorts, appId: string, intent: "suspended" | "running"): Step {
  return {
    name: "watch-converged",
    title: `Wait for ArgoCD to converge on the ${intent} render`,
    run: async (ctx) => {
      const ac = loadAppCluster(ctx.db, appId);
      // The GENERATED Application is named `<name>-<stage>` (the consumers appset) — watching the
      // bare name would read Missing immediately and falsely pass.
      const appName = consumerArgoAppName(ac.name, ac.stage);
      const converged = (s: ArgoAppStatus): boolean => s.sync === "Synced" && s.health === "Healthy";
      const { argoReader, argoNamespace } = await ports.resolver.resolve(ac.clusterId);
      const status = await argoReader.watchApplication(argoNamespace, appName, converged, { timeoutMs: ports.argoWatchTimeoutMs, signal: ctx.signal });
      if (!converged(status)) {
        throw errValidation(`Application ${appName} did not reach Synced/Healthy on the ${intent} render — last seen sync=${status.sync}, health=${status.health}${status.message ? ` (${status.message})` : ""}`);
      }
      ctx.log("meta", `Application ${appName} is Synced + Healthy — the consumer is ${intent}`);
    },
  };
}

function suspendSteps(ports: LifecyclePorts, params: SuspendResumeParams): Step[] {
  const appId = params.appId;
  return [
    attestTargetStep(ports, appId),
    // The ROW MOVES FIRST, before the GitOps commit. It used to move last, after the convergence
    // watch, which left a window — often minutes — in which the registration said suspended and the
    // inventory said active. Anything reading the inventory in that window read a consumer that is
    // serving, while the render was already taking it down.
    //
    // Writing it first cannot produce that disagreement: from the commit onward both say the same
    // thing. A crash in between leaves a row that states the intent and a registration that has not
    // caught up yet, which is the direction a resume repairs — the run re-runs its remaining steps
    // and the world converges onto what the row already says. The reverse order left a row nobody
    // would ever correct, because the run had already passed the step that would have.
    {
      name: "record-suspended",
      title: "Record the consumer as suspended",
      run: async (ctx) => {
        localTx(ctx, (tx) => tx.update(apps).set({ status: "suspended", lastRunId: ctx.runId }).where(eq(apps.id, appId)).run());
        ctx.log("meta", `consumer recorded as suspended (row kept) — the registration flip follows, so the two never disagree`);
      },
    },
    {
      name: "suspend-registration",
      title: "Flip the consumer registration to suspended",
      run: async (ctx) => {
        const ac = loadAppCluster(ctx.db, appId);
        const { commit } = await ports.registry.setSuspended(ac.stage, ac.name, true, ctx.runId);
        ctx.checkpoint({ commit });
        ctx.log("meta", `registration for ${ac.name} (${ac.stage}) flipped to suspended (${commit}) — ArgoCD will re-render the app in its off state`);
      },
    },
    watchConvergedStep(ports, appId, "suspended"),
  ];
}

function resumeSteps(ports: LifecyclePorts, params: SuspendResumeParams): Step[] {
  const appId = params.appId;
  return [
    attestTargetStep(ports, appId),
    // Same order as suspend above, and for the same reason: the row moves BEFORE the commit, so the
    // inventory and the registration never state opposite things. Resuming had the wider window of
    // the two — the watch waits for workloads to come UP, which takes longer than taking them down.
    {
      name: "record-active",
      title: "Record the consumer as active",
      run: async (ctx) => {
        localTx(ctx, (tx) => tx.update(apps).set({ status: "active", lastRunId: ctx.runId }).where(eq(apps.id, appId)).run());
        ctx.log("meta", `consumer recorded as active — the registration flip follows, so the two never disagree`);
      },
    },
    {
      name: "resume-registration",
      title: "Flip the consumer registration back to running",
      run: async (ctx) => {
        const ac = loadAppCluster(ctx.db, appId);
        const { commit } = await ports.registry.setSuspended(ac.stage, ac.name, false, ctx.runId);
        ctx.checkpoint({ commit });
        ctx.log("meta", `registration for ${ac.name} (${ac.stage}) flipped back to running (${commit}) — ArgoCD will re-render the app with its workloads`);
      },
    },
    watchConvergedStep(ports, appId, "running"),
  ];
}

export function makeSuspendDef(ports: LifecyclePorts): RunDefinition<SuspendResumeParams> {
  return {
    kind: "suspend",
    paramsSchema: SuspendResumeParams,
    mutating: true,
    plan: async (params, { db }) => {
      const ac = loadAppCluster(db, params.appId);
      const stepDefs = suspendSteps(ports, params);
      return {
        kind: "suspend",
        targetKind: "app",
        targetId: params.appId,
        summary: `Suspend consumer "${ac.name}" on ${ac.domain} (${ac.stage}): flip the registration's suspended field, wait for ArgoCD to converge on the off render, mark suspended. The row is kept.`,
        steps: stepDefs.map((s) => ({ name: s.name, title: s.title })),
        targets: [],
        locks: [...gitBranchLocks(ports.registry.branch, ac.domain), masterKubeLock],
        warnings: [],
        requiredSecrets: [],
      };
    },
    steps: (params) => suspendSteps(ports, params),
  };
}

export function makeResumeDef(ports: LifecyclePorts): RunDefinition<SuspendResumeParams> {
  return {
    kind: "resume",
    paramsSchema: SuspendResumeParams,
    mutating: true,
    plan: async (params, { db }) => {
      const ac = loadAppCluster(db, params.appId);
      const stepDefs = resumeSteps(ports, params);
      return {
        kind: "resume",
        targetKind: "app",
        targetId: params.appId,
        summary: `Resume consumer "${ac.name}" on ${ac.domain} (${ac.stage}): flip the registration's suspended field back, wait for ArgoCD to converge on the running render, mark active.`,
        steps: stepDefs.map((s) => ({ name: s.name, title: s.title })),
        targets: [],
        locks: [...gitBranchLocks(ports.registry.branch, ac.domain), masterKubeLock],
        warnings: [],
        requiredSecrets: [],
      };
    },
    steps: (params) => resumeSteps(ports, params),
  };
}
