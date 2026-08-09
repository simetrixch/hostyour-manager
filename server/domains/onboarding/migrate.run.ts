// migrate / tenant-migrate — the whole mechanism in one run: a move IS a backup, a
// restore into the target and a repoint, in this order verbatim — close · dump · restore ·
// verify · switch DNS · open · clear source. The unit keeps its identity (name/guid, addresses,
// sessions, Vault entry); what changes is ONE registration field and the content of ONE DNS record.
// The source is measured RELEASED-but-holding before anything is restored (verify-source-released),
// and it falls only in clear-source, last.
import { z } from "zod";
import type { RunDefinition, LockClaim, Step } from "../../executor/types.ts";
import { attestTargetStep, attestTenantTargetStep, loadAppCluster, loadTenantCluster } from "./lifecycle.ts";
import { tenantLocks } from "./tenant-lifecycle.run.ts";
import { assertMovableTo } from "./relocation-target.ts";
import { quiesceStep, verifyQuiescedStep, dumpStep, verifyDumpStep, openAccessStep, type RelocationPorts, type WorldOf } from "./relocation.ts";
import { provisionTargetStep, watchTargetStep, restoreStep, verifyCompletenessStep, switchDnsStep, targetSmokeStep, recordStep } from "./relocation-restore.ts";
import { repointStep, clearSourceStep } from "./relocation-migrate.ts";
import { verifySourceReleasedStep } from "./verify-source-released.ts";
import { consumerWorld, type ConsumerRelocationPorts } from "./relocation-world-consumer.ts";
import { tenantWorld, type TenantRelocationPorts } from "./relocation-world-tenant.ts";

export const MigrateParams = z.object({ appId: z.string().startsWith("app_"), targetClusterId: z.string().startsWith("cls_") });
export type MigrateParams = z.infer<typeof MigrateParams>;

export const TenantMigrateParams = z.object({ tenantId: z.string().startsWith("tnt_"), targetClusterId: z.string().startsWith("cls_") });
export type TenantMigrateParams = z.infer<typeof TenantMigrateParams>;

const masterKubeLock: LockClaim = { resource: "master-kube", key: "m" };

/** The relocation sequence over any world — the one place the order is stated, so the two kinds cannot
 *  drift: close (quiesce + verify) · dump (+ verify) · provide + repoint + watch · prove the source
 *  released · restore (+ completeness) · switch DNS · smoke · open · clear source · record. */
function migrateSteps(ports: RelocationPorts, worldOf: WorldOf, targetClusterId: string, attest: Step, what: string): Step[] {
  return [
    attest,
    quiesceStep(worldOf),
    verifyQuiescedStep(ports, worldOf),
    dumpStep(ports, worldOf),
    verifyDumpStep(ports, worldOf),
    provisionTargetStep(worldOf, targetClusterId),
    repointStep(worldOf, targetClusterId),
    watchTargetStep(worldOf, targetClusterId),
    verifySourceReleasedStep(ports, worldOf),
    restoreStep(ports, worldOf, targetClusterId),
    verifyCompletenessStep(ports, worldOf, targetClusterId),
    switchDnsStep(ports, worldOf, targetClusterId, "migrate"),
    targetSmokeStep(ports, worldOf, targetClusterId),
    openAccessStep(worldOf, "target", targetClusterId),
    clearSourceStep(ports, worldOf),
    recordStep(worldOf, targetClusterId, what),
  ];
}

const summaryTail =
  "The address stays the unit's own — the move updates the CONTENT of its one DNS record and nothing else, so sessions and integrations survive. The source is verified to have RELEASED the unit while still holding its data before anything is restored, and it is cleared LAST — a failure anywhere before that leaves the source data and the box folder fully intact.";

export function makeMigrateDef(ports: ConsumerRelocationPorts): RunDefinition<MigrateParams> {
  return {
    kind: "migrate",
    paramsSchema: MigrateParams,
    mutating: true, // mutating ⇒ steps()[0] MUST be attest-target
    plan: async (params, { db }) => {
      const ac = loadAppCluster(db, params.appId);
      const target = assertMovableTo(db, ac.clusterId, params.targetClusterId, ac.stage);
      const stepDefs = migrateSteps(ports, consumerWorld(ports, params.appId), params.targetClusterId, attestTargetStep(ports, params.appId), "moved consumer");
      return {
        kind: "migrate",
        targetKind: "app",
        targetId: params.appId,
        summary: `Move consumer "${ac.name}" (${ac.stage}) from ${ac.domain} to ${target.domain} through the Storage Box folder /${ac.name}/: quiesce and verify closed, dump every store, provision the target, repoint the registration, verify the source released the unit, restore, verify completeness, switch the one DNS record, smoke, reopen, clear the source. ${summaryTail}`,
        steps: stepDefs.map((s) => ({ name: s.name, title: s.title })),
        targets: [],
        locks: [{ resource: "git-branch", key: ports.registry.branch }, { resource: "git-branch", key: ac.domain }, { resource: "git-branch", key: target.domain }, masterKubeLock],
        warnings: [],
        requiredSecrets: [],
      };
    },
    steps: (params) => migrateSteps(ports, consumerWorld(ports, params.appId), params.targetClusterId, attestTargetStep(ports, params.appId), "moved consumer"),
  };
}

export function makeTenantMigrateDef(ports: TenantRelocationPorts): RunDefinition<TenantMigrateParams> {
  return {
    kind: "tenant-migrate",
    paramsSchema: TenantMigrateParams,
    mutating: true,
    plan: async (params, { db }) => {
      const tc = loadTenantCluster(db, params.tenantId);
      const target = assertMovableTo(db, tc.clusterId, params.targetClusterId, tc.stage);
      const stepDefs = migrateSteps(ports, tenantWorld(ports, params.tenantId), params.targetClusterId, attestTenantTargetStep(ports, params.tenantId), "moved tenant");
      return {
        kind: "tenant-migrate",
        targetKind: "tenant",
        targetId: params.tenantId,
        summary: `Move tenant ${tc.guid} (${tc.stage}) from ${tc.domain} to ${target.domain} through the Storage Box folder /${tc.guid}/ — the WHOLE bracket, under the unchanged guid: quiesce and verify closed, dump every ${tc.guid}_* database + the bucket + the crypto material, provision every member on the target, repoint (every source member namespace is marked relocating first, which is what keeps its databases when the flip prunes the ServiceClaims), verify the source released the tenant — its fan-out pruned — while still holding its data, restore, verify completeness, switch the one wildcard record, smoke, reopen, clear the source. ${summaryTail}`,
        steps: stepDefs.map((s) => ({ name: s.name, title: s.title })),
        targets: [],
        locks: tenantLocks(ports.registry),
        warnings: [],
        requiredSecrets: [],
      };
    },
    steps: (params) => migrateSteps(ports, tenantWorld(ports, params.tenantId), params.targetClusterId, attestTenantTargetStep(ports, params.tenantId), "moved tenant"),
  };
}
