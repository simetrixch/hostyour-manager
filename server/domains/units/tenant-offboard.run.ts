import { eq, and, notInArray } from "drizzle-orm";
import type { RunDefinition, Step } from "../../executor/types.ts";
import { tenants, tenantApps } from "../../db/schema/inventory.ts";
import { errValidation } from "../../kernel/errors.ts";
import { atLeastAsSettledAs } from "../../../shared/enums.ts";
import { localTx } from "../../executor/stepkit.ts";
import { tenantApplicationSet, tenantNamespaces } from "./tenant-fanout.ts";
import { attestTenantTargetStep, clearRelocationHold, loadTenantCluster, type TenantLifecyclePorts } from "./lifecycle.ts";
import { TenantLifecycleParams, tenantLocks, tenantTeardownMembers, allPruned, lingering, tenantSelector } from "./tenant-lifecycle.run.ts";
import { deleteTenantArgoSync, deleteTenantMembers, describeTenantMemberDeletes } from "./tenant-teardown.ts";
import { isTenantRecord, removeTenantBookedRecords, removeUnitDns, tenantRecordName } from "./unit-dns.ts";
import { removeTenantAppsRegistration } from "./tenant-apps-repo-remove.ts";

// tenant-offboard — the tenant analogue of the consumer
// offboard.run.ts, split into its own file for the 400-line budget (it reuses the shared helpers from
// tenant-lifecycle.run.ts). It git-rm's the ONE registration file, waits for ArgoCD to
// prune the WHOLE fan-out to Missing, then deletes every member's isolation AppProject and the
// tenant's argo-sync grant — the exact symmetry-inverse of create-tenant's apply-appprojects →
// provision-argo-sync → write-registration. mutating: true ⇒
// attest-target is the first step. The tenants + tenant_apps rows are NEVER hard-deleted — offboard
// flips them to "offboarded" (a soft, re-onboardable state), keeping the history + the pin.
//
// This run is ROW-driven throughout (loadTenantCluster on the tenants row). The POINTER-driven twin of
// its remove -> watch-prune -> delete-projects -> record shape — the one that also reaches a tenant with
// no inventory row — lives in tenant-teardown.ts, which create-tenant composes for its replaces.

/** offboard adds the one writing kube port (delete the member AppProjects) — already on
 *  TenantLifecyclePorts, so no extra ports type is needed (unlike the consumer OffboardPorts, which
 *  widens the read-only LifecyclePorts; the tenant ports already carry `projects`). */
function offboardSteps(ports: TenantLifecyclePorts, params: TenantLifecycleParams): Step[] {
  const tenantId = params.tenantId;
  return [
    attestTenantTargetStep(ports, tenantId),
    // The tenant's apps build registration goes with the tenant (#217), read off the registration
    // while it still stands — the next step git-rms it. The repository stands (#241).
    {
      name: "remove-apps-registration",
      title: "Remove the tenant's apps build registration; the repository stands",
      run: async (ctx) => {
        const tc = loadTenantCluster(ctx.db, tenantId);
        if ((await ports.registrations.scanTenant(tc.stage, tc.guid)).status !== "read") {
          ctx.log("meta", `tenant ${tc.guid}'s registration is not readable — an apps bundle it may name stays registered`);
          return;
        }
        await removeTenantAppsRegistration(ctx, ports, { stage: tc.stage, guid: tc.guid }, { clear: false });
      },
    },
    {
      name: "remove-tenant",
      title: "Remove the tenant registration (GitOps un-deploy)",
      run: async (ctx) => {
        // removeTenant refuses when the registration is already gone (VALIDATION) — so on a resume (the
        // removal already committed before the crash) skip instead of throwing, mirroring add-app.
        // ABSENT is the only state that skips, and the probe is the TOLERANT scan, never the strict
        // readTenant — the same change tenant-teardown.ts's remove step carries, for a reason that bites
        // hardest HERE: readTenant THROWS (INTERNAL) on a body failing YAML/schema, so an ACTIVE tenant
        // whose registration drifted would fail at this very step, identically on every retry, and the
        // registration would stay committed with the whole fan-out still serving. That would break the
        // one NON-destructive removal run kind — the run kind api.ts deliberately keeps open on a
        // still-provisioning tenant because it is the clean way OUT — and leave tenant-purge, which
        // destroys the tenant's Vault crypto entry, as the only way to remove a tenant.
        // "unreadable" means a registration DOES stand and must still be git-rm'd BY PATH, which is all
        // removeTenant ever needs.
        const tc = loadTenantCluster(ctx.db, tenantId);
        // The relocation mark goes FIRST, on every member namespace this teardown takes down: each
        // member chart renders its own ServiceClaim, and the prune this removal sets off is what hands
        // those claims to the teardown the mark disarms. It runs before the resume skip too — a resumed
        // run still has to clear it.
        const { clusterReader } = await ports.resolver.resolve(tc.clusterId);
        await clearRelocationHold(ctx, clusterReader, tenantNamespaces(tenantTeardownMembers(ctx.db, tc.guid, tc.stage), tc.guid, tc.stage), tc.guid);
        if ((await ports.registrations.scanTenant(tc.stage, tc.guid)).status === "absent") {
          ctx.log("meta", `tenant ${tc.guid} registration already removed — skipping (resume)`);
          return;
        }
        const { commit } = await ports.registrations.removeTenant(tc.stage, tc.guid, ctx.runId);
        ctx.checkpoint({ commit });
        ctx.log("meta", `tenant ${tc.guid} registration removed (${commit}) — ArgoCD will now prune the whole fan-out`);
      },
    },
    {
      name: "watch-removal",
      title: "Wait for ArgoCD to prune the whole tenant fan-out",
      run: async (ctx) => {
        // The expected set comes from inventory, not the registration — remove-tenant just git-rm'd
        // it, but the tenants/tenant_apps rows are still there until record-offboard, so the fan-out
        // names still resolve. It is the TEARDOWN set (tenantTeardownMembers), every app row whatever
        // its status: a settled row's Application may still be serving, and an Application ArgoCD
        // never generated reads Missing, so the wider set costs a prune watch nothing.
        const tc = loadTenantCluster(ctx.db, tenantId);
        const names = tenantApplicationSet(tenantTeardownMembers(ctx.db, tc.guid, tc.stage), tc.guid, tc.stage);
        const { argoReader, argoNamespace } = await ports.resolver.resolve(tc.clusterId);
        const status = await argoReader.watchApplicationSet(argoNamespace, names, allPruned(names), { timeoutMs: ports.argoWatchTimeoutMs, signal: ctx.signal, labelSelector: tenantSelector(tc.guid) });
        if (!allPruned(names)(status)) throw errValidation(`tenant ${tc.guid} fan-out was not pruned — ${lingering(status)}; the registration is removed but workloads linger, check ArgoCD`);
        ctx.log("meta", `tenant ${tc.guid} fan-out pruned (${names.length} Application(s)) — the tenant is no longer deployed`);
      },
    },
    {
      name: "delete-appprojects",
      title: "Delete every member's isolation AppProject, admission policy and the argo-sync grant",
      run: async (ctx) => {
        // After the fan-out is pruned, no Application references any of the isolation projects — delete
        // them ALL (the inverse of create-tenant's apply-appprojects), one project and one admission
        // policy per member of the TEARDOWN set (tenantTeardownMembers, which says why a settled app
        // row is still one), through the delete the pointer-driven teardown shares.
        const tc = loadTenantCluster(ctx.db, tenantId);
        const members = tenantTeardownMembers(ctx.db, tc.guid, tc.stage);
        const kube = await ports.resolver.resolve(tc.clusterId);
        const deletes = await deleteTenantMembers(kube, tc.guid, tc.stage, members);
        // The inverse of create-tenant's provision-argo-sync, in the same namespace and the same step
        // as the projects: a Role naming this guid's Applications must not outlive the guid.
        const removed = await deleteTenantArgoSync(ports, tc.guid, kube.argoNamespace);
        ctx.checkpoint({ members, ...deletes, argoSyncDeleted: removed });
        ctx.log("meta", describeTenantMemberDeletes(deletes, removed));
      },
    },
    {
      name: "remove-dns",
      title: "Remove the tenant's public DNS record",
      run: async (ctx) => {
        // The inverse of create-tenant's provision-dns (no address is left pointing nowhere
        // — without exception, so this step is fail-CLOSED). The tenant's one record is the one its
        // recorded routing names (tenantRecordName: the wildcard under host routing, the zone under
        // path routing); the apex comes off the target cluster's values chain, the same read the
        // create side made.
        const tc = loadTenantCluster(ctx.db, tenantId);
        const unitApex = await ports.resolveUnitApex(tc.domain, tc.stage);
        const recordName = tenantRecordName(tc.routing, tc.subdomain, tc.stage, unitApex);
        await removeUnitDns(ctx, { dns: ports.dns, unit: tc.guid, recordName });
        // The own domain's and its redirect hosts' records, where this installation wrote them; one in a
        // zone nobody here manages is the operator's to remove, which is decided before the book forgets
        // what it removes.
        const ownHosts = tc.ownDomain === "" ? [] : [tc.ownDomain, ...tc.ownDomainRedirects];
        const unbooked = ownHosts.filter((host) => !isTenantRecord(ctx.db, host, tc.guid));
        await removeTenantBookedRecords(ctx, { dns: ports.dns, guid: tc.guid, stage: tc.stage, except: [recordName] });
        for (const host of unbooked) ctx.log("meta", `the own host ${host} is not recorded as written here — remove its record at its provider`);
      },
    },
    {
      name: "record-offboard",
      title: "Record the tenant as offboarded",
      run: async (ctx) => {
        // soft state, never a row delete. Flip the tenant + its app rows to offboarded and tie
        // them to this run; keep the rows (history + a future re-onboard). A PROVISIONING app row
        // (create-tenant recorded it before it deployed) is just as deployed as an
        // active one, and leaving it at "provisioning" after the offboard pruned its Application would
        // strand a lie in the inventory — so the filter is not "active", it is "not already settled at
        // least this deeply" (atLeastAsSettledAs, shared/enums.ts, which states the rule and both defects
        // it closes). On BOTH writes, because they are two independent facts about two different rows:
        // an app row a remove-app already offboarded keeps its own run id rather than being restamped by
        // a removal that did not remove it, and — the row this run resolves by ID, so it reaches any
        // status the caller's tenant happens to carry — a tenants row a tenant-purge already settled
        // "purged" is NOT downgraded here. POST /api/tenants/:id/offboard takes any row id and checks no
        // status, so this run is reachable on a deprovisioned tenant; every step above then no-ops (the
        // pointer is gone, the fan-out is pruned, the AppProject is deleted) and an unguarded write would
        // put that tenant back on the "Offboarded tenants" panel, offering the purge that already ran.
        const tc = loadTenantCluster(ctx.db, tenantId);
        const keep = atLeastAsSettledAs("offboarded");
        const before = ctx.db.select({ status: tenants.status }).from(tenants).where(eq(tenants.id, tenantId)).get();
        localTx(ctx, (tx) => {
          tx.update(tenantApps).set({ status: "offboarded", lastRunId: ctx.runId }).where(and(eq(tenantApps.tenantId, tenantId), notInArray(tenantApps.status, keep))).run();
          tx.update(tenants).set({ status: "offboarded", lastRunId: ctx.runId, updatedAt: new Date() }).where(and(eq(tenants.id, tenantId), notInArray(tenants.status, keep))).run();
        });
        // The log follows what the row actually did — a step reporting an offboard it did not record
        // would be the same false statement one layer down (the run log is where an operator reads what
        // happened). loadTenantCluster above already proved the row exists, so `before` is never absent.
        // It speaks about the TENANT row alone, which is what it read; the app rows are judged one by one
        // by the same filter.
        ctx.log(
          "meta",
          before && keep.includes(before.status)
            ? `tenant ${tc.guid} is already recorded ${before.status} on cluster ${tc.clusterId}, a removal at least as complete as this one — leaving that row and the run id that settled it untouched; this offboard un-deployed nothing it does not already account for`
            : `tenant ${tc.guid} recorded as offboarded on cluster ${tc.clusterId} (row kept)`,
        );
      },
    },
  ];
}

export function makeOffboardTenantDef(ports: TenantLifecyclePorts): RunDefinition<TenantLifecycleParams> {
  return {
    kind: "tenant-offboard",
    paramsSchema: TenantLifecycleParams,
    mutating: true, // mutating ⇒ steps()[0] MUST be attest-target
    plan: async (params, { db }) => {
      const tc = loadTenantCluster(db, params.tenantId);
      const stepDefs = offboardSteps(ports, params);
      return {
        kind: "tenant-offboard",
        targetKind: "tenant",
        targetId: params.tenantId,
        summary: `Offboard tenant ${tc.guid} from ${tc.domain} (${tc.stage}): remove the registration, wait for ArgoCD to prune the whole fan-out, delete every member's isolation AppProject, its admission policy and the tenant's argo-sync grant, remove the tenant's DNS record, mark offboarded. The tenant's IDENTITY is kept — its Vault crypto entry stands until a purge destroys it — and the inventory row too. Its member DATABASES are NOT kept: pruning the fan-out deletes every member's ServiceClaim, and the service-provisioner drops a claim's databases together with its user, so a re-onboarded tenant starts on empty stores. Run a backup first if the data has to come back.`,
        steps: stepDefs.map((s) => ({ name: s.name, title: s.title })),
        targets: [], // no host owned — the Manager acts master-locally
        locks: tenantLocks(ports.registrations),
        warnings: [],
        requiredSecrets: [],
      };
    },
    steps: (params) => offboardSteps(ports, params),
  };
}
