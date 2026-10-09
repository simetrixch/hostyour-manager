// add-app-abort.ts — what add-app does when it is aborted: the cleanup that drops the app it
// appended, and the precondition that refuses the abort while the new member is live.
import { and, eq } from "drizzle-orm";
import type { Cleanup } from "../../executor/types.ts";
import type { Db } from "../../db/client.ts";
import { tenants, tenantApps } from "../../db/schema/inventory.ts";
import type { Stage } from "../../../shared/enums.ts";
import { errValidation } from "../../kernel/errors.ts";
import { memberApplication } from "./tenant-fanout.ts";
import type { TenantOnboardPorts } from "./create-tenant.run.ts";

/** What of an add-app run the two below read: the app it appends, to which tenant, on which cluster. */
export interface AppendedApp {
  stage: Stage;
  guid: string;
  app: string;
  tenantId: string;
  clusterId: string;
  /** The website that held `main` when the run was planned; the drop gives the mark back to it. */
  previousMain: string | null;
}

/** The inverse of append-app — registered by append-app, run only on an explicit abort-with-cleanup.
 *  Drops the ONE app this run appended. Read-first: an app the registration does not carry was never
 *  appended (or is already dropped), so the drop is skipped instead of the registrations's refusal being
 *  swallowed — a real git failure now propagates and fails the cleanup step visibly, where the old
 *  bare catch reported it as a completed rollback. The new member's namespace, AppProject and
 *  admission policy are cluster state and stay (soft state, re-addable) — only tenant-purge reaps a
 *  tenant's namespaces, which is why add-app registers no project or policy delete. If the app holds
 *  `main`, the same commit gives it back to the website that held it before this run. */
export function revertAppendCleanup(ports: TenantOnboardPorts, p: AppendedApp): Cleanup {
  return {
    name: "revert-app-append",
    title: "Drop the appended app from the tenant registration",
    run: async (ctx) => {
      const current = await ports.registrations.readTenant(p.stage, p.guid);
      if (!current || !current.entry.apps.some((a) => a.name === p.app)) {
        ctx.log("meta", `app "${p.app}" is not in tenant ${p.guid}'s registration — nothing to drop`);
        return;
      }
      const { commit, approvedTags } = await ports.registrations.updateTenantApps(p.stage, p.guid, { op: "drop", app: p.app, mainTo: p.previousMain, runId: ctx.runId });
      ctx.db.update(tenants).set({ approvedTags, updatedAt: new Date() }).where(eq(tenants.id, p.tenantId)).run();
      ctx.log("meta", `app "${p.app}" dropped from tenant ${p.guid} (${commit}) — ArgoCD will now prune only this member's Application`);
    },
  };
}

/** The abort's PRECONDITION (RunDefinition.assertAbortable), keyed on the NEW MEMBER and never on the
 *  tenant: add-app only ever targets a live tenant, so the tenant-level rule (assertTenantNotLive)
 *  would refuse EVERY add-app abort. What the rollback drops is the one appended apps[] entry — and
 *  that drop is destructive by cascade: the appset stops generating the member's Application, ArgoCD
 *  prunes it, the member's ServiceClaim is deleted and the service-provisioner drops its databases
 *  with its user. So the question is whether THIS member is live, asked from both ends:
 *
 *  1. THE INVENTORY ROW — record-inventory settled the member "active" (the run failed only after it,
 *     or a later run settled it), so the product advertises a serving member the abort would delete.
 *  2. THE CLUSTER, when the row does not say live: the run died at watch-sync-set or smoke, which
 *     cannot tell A STEP THAT FAILED from A STEP THAT TIMED OUT WHILE SUCCEEDING — the member can
 *     converge after the watch budget and carry data by the time anyone aborts. The member's
 *     Application is read back at the moment the abort asks; Synced + Healthy means the run's work
 *     is live, and the way to make the record agree with the cluster is a RETRY (every step re-reads
 *     the world: the watch passes, record-inventory writes the row, the run settles green).
 *
 *  Both ends are asked only while the registration still CARRIES the app — an entry already dropped
 *  generates nothing, and the rollback then has nothing live to reach. Fail-closed: an unreadable
 *  registration or ArgoCD propagates, since "cannot read" is never "is not there". */
export async function assertAddAppAbortable(ports: TenantOnboardPorts, p: AppendedApp, db: Db): Promise<void> {
  const current = await ports.registrations.readTenant(p.stage, p.guid);
  if (!current || !current.entry.apps.some((a) => a.name === p.app)) return;
  const rollback =
    `aborting this add-app would drop "${p.app}" from the registration, ArgoCD would prune the member's Application, and the prune deletes its ServiceClaim — ` +
    `the service-provisioner then drops the member's databases and user`;
  const row = db
    .select({ status: tenantApps.status })
    .from(tenantApps)
    .where(and(eq(tenantApps.tenantId, p.tenantId), eq(tenantApps.name, p.app)))
    .get();
  const rowLive = row?.status === "active";
  let clusterLive = false;
  if (!rowLive) {
    const { argoReader, argoNamespace } = await ports.resolver.resolve(p.clusterId);
    const status = await argoReader.getApplication(argoNamespace, memberApplication(p.guid, p.app, p.stage));
    clusterLive = status !== null && status.sync === "Synced" && status.health === "Healthy";
  }
  if (!rowLive && !clusterLive) return;
  throw errValidation(
    `app "${p.app}" of tenant ${p.guid} is ${rowLive ? "recorded active and its registration entry is generating a member" : "LIVE on the cluster (its member Application reads Synced/Healthy)"} — ${rollback}: data loss on a member that is serving. ` +
      `Retry the run from its failed step instead so it records the member and settles green, or use remove-app to take a live member out deliberately — its prune drops the member's databases too, so back them up first. ` +
      `This run has nothing left to roll back; delete the run once you no longer need its log.`,
  );
}
