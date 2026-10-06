import { z } from "zod";
import { eq } from "drizzle-orm";
import type { RunDefinition, Step } from "../../executor/types.ts";
import { apps } from "../../db/schema/inventory.ts";
import { errValidation } from "../../kernel/errors.ts";
import { consumerArgoAppName, consumerNamespace } from "../../../shared/consumer.ts";
import type { WorkloadStatus } from "../../adapters/kube/port.ts";
import { watchConsumerSwitch } from "./consumer-switch-watch.ts";
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

/** Wait for the GENERATED Application (`<name>-<stage>`) to render what the flip just asked for, then
 *  read the workloads. The render from before the flip is Synced and Healthy too (a suspended render
 *  is a healthy Application with no replicas and no Ingress), so the wait reads the `suspended` value
 *  off the chart source (consumer-switch-watch.ts). The workloads are read after it because a
 *  Healthy Application says only that what it asks for stands, not that it asks for anything. */
function watchConvergedStep(ports: LifecyclePorts, appId: string, intent: "suspended" | "running"): Step {
  return {
    name: "watch-converged",
    title: `Wait for ArgoCD to converge on the ${intent} render`,
    run: async (ctx) => {
      const ac = loadAppCluster(ctx.db, appId);
      const suspended = intent === "suspended";
      const entry = (await ports.registrations.readRegistration(ac.stage, ac.name))?.entry;
      if (entry?.chartPath === undefined) throw errValidation(`consumer ${ac.name} has no stage registration with a chart at ${ac.stage} — there is no render to wait for`);
      if (entry.suspended !== suspended) throw errValidation(`consumer ${ac.name} registration no longer requests the ${intent} render`);
      const appName = consumerArgoAppName(ac.name, ac.stage);
      await watchConsumerSwitch(ports, ctx, { clusterId: ac.clusterId, appName, chart: { repoURL: entry.repoURL, chartPath: entry.chartPath } }, "suspended", suspended, intent);
      const namespace = consumerNamespace(ac.name, ac.stage);
      const { clusterReader } = await ports.resolver.resolve(ac.clusterId);
      const asking = (await clusterReader.smoke(namespace)).workloads.filter((w) => w.desired > 0);
      const named = (ws: readonly WorkloadStatus[]): string => ws.map((w) => `${w.kind}/${w.name} (${w.ready}/${w.desired})`).join(", ");
      if (suspended && asking.length > 0) throw errValidation(`Application ${appName} renders suspended, but ${namespace} still runs ${named(asking)}`);
      if (!suspended && asking.length === 0) throw errValidation(`Application ${appName} renders running, but no workload in ${namespace} asks for replicas`);
      const unready = asking.filter((w) => !w.available);
      if (!suspended && unready.length > 0) throw errValidation(`Application ${appName} renders running, but ${named(unready)} in ${namespace} is not available`);
      ctx.log("meta", `Application ${appName} is Synced + Healthy on the ${intent} render — the consumer is ${intent}${suspended ? "" : `: ${named(asking)}`}`);
    },
  };
}

function suspendSteps(ports: LifecyclePorts, params: SuspendResumeParams): Step[] {
  const appId = params.appId;
  return [
    attestTargetStep(ports, appId),
    // The ROW MOVES FIRST, before the GitOps commit. Moving it last, after the convergence
    // watch, leaves a window — often minutes — in which the registration says suspended and the
    // inventory says active. Anything reading the inventory in that window reads a consumer that is
    // serving, while the render is already taking it down.
    //
    // Writing it first cannot produce that disagreement: from the commit onward both say the same
    // thing. A crash in between leaves a row that states the intent and a registration that has not
    // caught up yet, which is the direction a resume repairs — the run re-runs its remaining steps
    // and the world converges onto what the row already says. The reverse order leaves a row nobody
    // would ever correct, because the run has already passed the step that would have.
    {
      name: "record-suspended",
      title: "Record the consumer as suspended",
      run: async (ctx) => {
        localTx(ctx, (tx) => tx.update(apps).set({ status: "suspended", lastRunId: ctx.runId, updatedAt: new Date() }).where(eq(apps.id, appId)).run());
        ctx.log("meta", `consumer recorded as suspended (row kept) — the registration flip follows, so the two never disagree`);
      },
    },
    {
      name: "suspend-registration",
      title: "Flip the consumer registration to suspended",
      run: async (ctx) => {
        const ac = loadAppCluster(ctx.db, appId);
        const { commit } = await ports.registrations.setSuspended(ac.stage, ac.name, true, ctx.runId);
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
        localTx(ctx, (tx) => tx.update(apps).set({ status: "active", lastRunId: ctx.runId, updatedAt: new Date() }).where(eq(apps.id, appId)).run());
        ctx.log("meta", `consumer recorded as active — the registration flip follows, so the two never disagree`);
      },
    },
    {
      name: "resume-registration",
      title: "Flip the consumer registration back to running",
      run: async (ctx) => {
        const ac = loadAppCluster(ctx.db, appId);
        const { commit } = await ports.registrations.setSuspended(ac.stage, ac.name, false, ctx.runId);
        ctx.checkpoint({ commit });
        ctx.log("meta", `registration for ${ac.name} (${ac.stage}) flipped back to running (${commit}) — ArgoCD will re-render the app with its workloads`);
      },
    },
    watchConvergedStep(ports, appId, "running"),
  ];
}

export function makeSuspendDef(ports: LifecyclePorts): RunDefinition<SuspendResumeParams> {
  return {
    kind: "consumer-suspend",
    paramsSchema: SuspendResumeParams,
    mutating: true,
    plan: async (params, { db }) => {
      const ac = loadAppCluster(db, params.appId);
      const stepDefs = suspendSteps(ports, params);
      return {
        kind: "consumer-suspend",
        targetKind: "app",
        targetId: params.appId,
        summary: `Suspend consumer "${ac.name}" on ${ac.domain} (${ac.stage}): flip the registration's suspended field, wait for ArgoCD to converge on the off render, mark suspended. The row is kept.`,
        steps: stepDefs.map((s) => ({ name: s.name, title: s.title })),
        targets: [],
        locks: [...gitBranchLocks(ports.registrations.branch, ac.domain), masterKubeLock],
        warnings: [],
        requiredSecrets: [],
      };
    },
    steps: (params) => suspendSteps(ports, params),
  };
}

export function makeResumeDef(ports: LifecyclePorts): RunDefinition<SuspendResumeParams> {
  return {
    kind: "consumer-resume",
    paramsSchema: SuspendResumeParams,
    mutating: true,
    plan: async (params, { db }) => {
      const ac = loadAppCluster(db, params.appId);
      const stepDefs = resumeSteps(ports, params);
      return {
        kind: "consumer-resume",
        targetKind: "app",
        targetId: params.appId,
        summary: `Resume consumer "${ac.name}" on ${ac.domain} (${ac.stage}): flip the registration's suspended field back, wait for ArgoCD to converge on the running render, mark active.`,
        steps: stepDefs.map((s) => ({ name: s.name, title: s.title })),
        targets: [],
        locks: [...gitBranchLocks(ports.registrations.branch, ac.domain), masterKubeLock],
        warnings: [],
        requiredSecrets: [],
      };
    },
    steps: (params) => resumeSteps(ports, params),
  };
}
