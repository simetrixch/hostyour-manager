import { z } from "zod";
import type { RunDefinition, Step } from "../../executor/types.ts";
import {
  attestTargetStep, loadAppCluster, type LifecyclePorts,
  attestTenantTargetStep, loadTenantCluster, type TenantLifecyclePorts,
} from "./lifecycle.ts";
import { tenantWatchNamespaces } from "./tenant-lifecycle.run.ts";

// `restart-workloads` / `tenant-restart-workloads` — roll a unit's pods so they read their secrets again.
//
// THE GAP IT CLOSES. A unit reads its secrets as environment variables (secretKeyRef), and an env var
// is materialized ONCE, when the container starts. ESO writes the new Vault value into the Kubernetes
// Secret; the running process never learns, and keeps presenting the old one until something restarts
// it. So putting a new value in front of a unit was only ever half an act — the Secret changed and
// the pods did not — and nothing on the platform did the other half.
//
// WHY A RUN KIND AND NOT A WATCHER. Replacing a secret value is an EXPLICIT operator procedure on this
// platform, by decision: every ExternalSecret carries refreshPolicy OnChange and refreshInterval "0",
// so nothing reads Vault on a timer anywhere (hostyour-cloud
// charts/external-secret/templates/externalsecret.yaml states the rule). What was missing was that
// procedure's LAST step, not a component that guesses when to take it. A cluster-wide watcher would
// need patch on Deployments and read on Secrets in EVERY namespace and would roll a unit's pods at a
// moment nobody chose; this run is approved, audited and aimed. The other way out — secrets as
// mounted volumes — changes the contract of every unit and still gains nothing for a value that is
// only usable at start (a database URL), which is most of them.
//
// WHAT IT DOES NOT DO. It moves no secret. The two steps before this one belong to the operator:
// write the new value into Vault, then DELETE the target Secret so ESO materializes it again from
// Vault. This run kind takes the third, and its plan summary says so plainly — "restart" is a word an
// operator can read as "replace the secrets", and it does not.
//
// TWO RUN KINDS, ONE MECHANISM. A consumer owns ONE namespace, a tenant owns one PER MEMBER — so the
// tenant run kind is not the consumer run kind with a different id, it walks the member namespaces
// (tenantWatchNamespaces, the same inventory projection the tenant watches are built from) and rolls
// each. Splitting it the other way — one run kind taking a namespace — would put the naming rule in the
// caller's hands and let a typo roll nothing while reporting success.
//
// mutating: true ⇒ attest-target is step 0 (guards.assertGuardsArmed), so a run approved against a
// cluster that has since changed identity refuses before it patches anything.

export const RestartWorkloadsParams = z.object({ appId: z.string().startsWith("app_") });
export type RestartWorkloadsParams = z.infer<typeof RestartWorkloadsParams>;

/** The ONE claim both run kinds make. No `git-branch` lock of any kind, where every other consumer and
 *  tenant run kind claims two: those read or write a registration, and this one neither reads nor writes
 *  git at all — a branch claim it does not need would block the flip run kinds and serialize nothing. What
 *  it does need is that no teardown of the same unit runs beside it, and `master-kube` is what every
 *  one of those already claims. */
const RESTART_LOCKS = [{ resource: "master-kube" as const, key: "m" }];

function restartSteps(ports: LifecyclePorts, p: RestartWorkloadsParams): Step[] {
  return [
    attestTargetStep(ports, p.appId),
    {
      name: "restart-workloads",
      title: "Roll the consumer's workloads so their pods read their secrets again",
      run: async (ctx) => {
        // The namespace IS the consumer name (G1), and the patch runs on the RESOLVED target cluster —
        // a consumer on a slave is rolled through that slave's own client, never the master's.
        const ac = loadAppCluster(ctx.db, p.appId);
        const { clusterReader } = await ports.resolver.resolve(ac.clusterId);
        // The stamp is what makes the pod template DIFFERENT, which is what makes the workload roll.
        // Its value is never read back; it is there for the operator who looks at the workload later.
        const stampedAt = new Date().toISOString();
        const rolled = await clusterReader.restartWorkloads(ac.name, stampedAt);
        ctx.checkpoint({ rolled, stampedAt });
        ctx.log(
          "meta",
          rolled > 0
            ? `${rolled} workload(s) of ${ac.name} rolled on ${ac.domain} (${stampedAt}) — each replaces its pods within its own surge budget, so a unit with more than one replica keeps serving through it; the new pods read whatever their Secrets hold NOW`
            : `${ac.name} has no workload on ${ac.domain} to roll — a suspended consumer renders none, and there is nothing holding a stale value`,
        );
      },
    },
  ];
}

export function makeRestartWorkloadsDef(ports: LifecyclePorts): RunDefinition<RestartWorkloadsParams> {
  return {
    kind: "restart-workloads",
    paramsSchema: RestartWorkloadsParams,
    mutating: true,
    plan: async (params, { db }) => {
      const ac = loadAppCluster(db, params.appId);
      const stepDefs = restartSteps(ports, params);
      return {
        kind: "restart-workloads",
        targetKind: "app",
        targetId: params.appId,
        // States what it is NOT, because an operator can read "restart" as "replace the secrets":
        // this run moves no secret, and taken without its first two steps it restarts the pods onto
        // exactly the value they already had.
        summary:
          `Roll every Deployment and StatefulSet of consumer "${ac.name}" on ${ac.domain} (${ac.stage}) so their pods start again and read their Secrets as they stand NOW. ` +
          "This MOVES NO SECRET: writing the new value into Vault and deleting the target Secret so ESO fetches it are the two steps before this one, and without them the pods come back on the same value. " +
          "Rolling, not deleting — each workload replaces its pods within its own surge budget, so a unit with more than one replica keeps serving. The registration and the inventory row are untouched.",
        steps: stepDefs.map((s) => ({ name: s.name, title: s.title })),
        targets: [],
        locks: RESTART_LOCKS,
        warnings: [],
        requiredSecrets: [],
      };
    },
    steps: (params) => restartSteps(ports, params),
  };
}

// ---- The tenant twin: the same act over every member namespace of one tenant ----

export const TenantRestartWorkloadsParams = z.object({ tenantId: z.string().startsWith("tnt_") });
export type TenantRestartWorkloadsParams = z.infer<typeof TenantRestartWorkloadsParams>;

function tenantRestartSteps(ports: TenantLifecyclePorts, p: TenantRestartWorkloadsParams): Step[] {
  return [
    attestTenantTargetStep(ports, p.tenantId),
    {
      name: "restart-workloads",
      title: "Roll every member's workloads so their pods read their secrets again",
      run: async (ctx) => {
        const tc = loadTenantCluster(ctx.db, p.tenantId);
        const { clusterReader } = await ports.resolver.resolve(tc.clusterId);
        // ONE stamp for the whole tenant, so an operator reading two member namespaces afterwards can
        // tell they were rolled by the same act rather than by two unrelated ones.
        const stampedAt = new Date().toISOString();
        const namespaces = tenantWatchNamespaces(ctx.db, tc.tenantId, tc.guid);
        let total = 0;
        for (const ns of namespaces) {
          const rolled = await clusterReader.restartWorkloads(ns, stampedAt);
          total += rolled;
          ctx.log("meta", `${ns}: ${rolled} workload(s) rolled`);
        }
        ctx.checkpoint({ rolled: total, namespaces: namespaces.length, stampedAt });
        ctx.log(
          "meta",
          total > 0
            ? `${total} workload(s) across ${namespaces.length} member namespace(s) of ${tc.guid} rolled on ${tc.domain} (${stampedAt}) — the new pods read whatever their Secrets hold NOW`
            : `no workload in the ${namespaces.length} member namespace(s) of ${tc.guid} to roll — a suspended tenant renders replicas 0, and there is nothing holding a stale value`,
        );
      },
    },
  ];
}

export function makeTenantRestartWorkloadsDef(ports: TenantLifecyclePorts): RunDefinition<TenantRestartWorkloadsParams> {
  return {
    kind: "tenant-restart-workloads",
    paramsSchema: TenantRestartWorkloadsParams,
    mutating: true,
    plan: async (params, { db }) => {
      const tc = loadTenantCluster(db, params.tenantId);
      const namespaces = tenantWatchNamespaces(db, params.tenantId, tc.guid);
      const stepDefs = tenantRestartSteps(ports, params);
      return {
        kind: "tenant-restart-workloads",
        targetKind: "tenant",
        targetId: params.tenantId,
        summary:
          `Roll every Deployment and StatefulSet in all ${namespaces.length} member namespace(s) of tenant ${tc.guid} on ${tc.domain} (${tc.stage}) — ${namespaces.join(", ")} — so their pods start again and read their Secrets as they stand NOW. ` +
          "This MOVES NO SECRET: writing the new value into the tenant's Vault entry and deleting the target Secrets so ESO fetches them are the two steps before this one, and without them the pods come back on the same value. " +
          "Rolling, not deleting — each workload replaces its pods within its own surge budget. The registration and the tenant row are untouched.",
        steps: stepDefs.map((s) => ({ name: s.name, title: s.title })),
        targets: [],
        locks: RESTART_LOCKS,
        warnings: [],
        requiredSecrets: [],
      };
    },
    steps: (params) => tenantRestartSteps(ports, params),
  };
}
