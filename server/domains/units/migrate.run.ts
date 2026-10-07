// migrate / tenant-migrate — the whole mechanism in one run: a move IS a backup, a
// restore into the target and a repoint, in this order verbatim — close · dump · restore ·
// verify · switch DNS · open · clear source. The unit keeps its identity (name/guid, addresses,
// sessions, Vault entry); what changes is ONE registration field and the content of ONE DNS record.
// The source is measured RELEASED-but-holding before anything is restored (verify-source-released),
// and it falls only in clear-source, last.
import { z } from "zod";
import type { RunDefinition, LockClaim, Step } from "../../executor/types.ts";
import { attestTargetStep, loadAppCluster } from "./lifecycle.ts";
import { STAGE } from "../../../shared/enums.ts";
import { errValidation } from "../../kernel/errors.ts";
import { loadTenantMove, tenantMoveWorld, tenantMoveCleanupWorld, attestTenantMoveStep } from "./tenant-migrate-stage.ts";
import { tenantLocks } from "./tenant-lifecycle.run.ts";
import { assertMovableTo } from "#unit/server/relocation-target.ts";
import { quiesceStep, verifyQuiescedStep, dumpStep, verifyDumpStep, openAccessStep, discardGenerationCleanup, reopenAccessCleanup, generationOfThisRun, type RelocationPorts, type WorldOf } from "#unit/server/relocation.ts";
import { provisionTargetStep, watchTargetStep, restoreStep, verifyCompletenessStep, switchDnsStep, targetSmokeStep, recordStep } from "#unit/server/relocation-restore.ts";
import { repointStep, clearSourceStep } from "#unit/server/relocation-migrate.ts";
import { verifySourceReleasedStep } from "#unit/server/verify-source-released.ts";
import { consumerWorld, refuseMoveSharingData, type ConsumerRelocationPorts } from "./relocation-world-consumer.ts";
import type { TenantRelocationPorts } from "./relocation-world-tenant.ts";

export const MigrateParams = z.object({ appId: z.string().startsWith("app_"), targetClusterId: z.string().startsWith("cls_") });
export type MigrateParams = z.infer<typeof MigrateParams>;

const tenantMoveBase = z.object({ tenantId: z.string().startsWith("tnt_"), targetClusterId: z.string().startsWith("cls_") });
export const TenantMigrateRequest = tenantMoveBase.extend({ stage: z.enum(STAGE), sourceClusterId: z.string().startsWith("cls_") });
// Stored runs retain their original recovery contract; every new plan requires the explicit request.
export const TenantMigrateParams = z.union([TenantMigrateRequest, tenantMoveBase.strict()]);
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
    dumpStep(ports, worldOf, "move"),
    verifyDumpStep(ports, worldOf),
    provisionTargetStep(worldOf, targetClusterId),
    repointStep(worldOf, targetClusterId),
    watchTargetStep(worldOf, targetClusterId),
    verifySourceReleasedStep(ports, worldOf),
    restoreStep(ports, worldOf, targetClusterId, generationOfThisRun),
    verifyCompletenessStep(ports, worldOf, targetClusterId, generationOfThisRun),
    switchDnsStep(ports, worldOf, targetClusterId, "consumer-migrate"),
    targetSmokeStep(ports, worldOf, targetClusterId),
    openAccessStep(worldOf, "target", targetClusterId),
    clearSourceStep(ports, worldOf),
    recordStep(worldOf, targetClusterId, what),
  ];
}

const summaryTail =
  "The address stays the unit's own — the move updates the CONTENT of its one DNS record and nothing else, so sessions and integrations survive. The source is verified to have RELEASED the unit while still holding its data before anything is restored, and it is cleared LAST — a failure anywhere before that leaves the source data intact. The generation the move takes stays on the storage box as the backup of the moment before it.";

export function makeMigrateDef(ports: ConsumerRelocationPorts): RunDefinition<MigrateParams> {
  return {
    kind: "consumer-migrate",
    paramsSchema: MigrateParams,
    mutating: true, // mutating ⇒ steps()[0] MUST be attest-target
    plan: async (params, { db }) => {
      const ac = loadAppCluster(db, params.appId);
      const target = assertMovableTo(db, ac.clusterId, params.targetClusterId);
      await refuseMoveSharingData(ports, ac.stage, ac.name, target.cluster);
      const stepDefs = migrateSteps(ports, consumerWorld(ports, params.appId), params.targetClusterId, attestTargetStep(ports, params.appId), "moved consumer");
      return {
        kind: "consumer-migrate",
        targetKind: "app",
        targetId: params.appId,
        summary: `Move consumer "${ac.name}" (${ac.stage}) from ${ac.domain} to ${target.domain} through a new backup generation on the Storage Box: quiesce and verify closed, dump every store, provision the target, repoint the registration, verify the source released the unit, restore, verify completeness, switch the one DNS record, smoke, reopen, clear the source. ${summaryTail}`,
        steps: stepDefs.map((s) => ({ name: s.name, title: s.title })),
        targets: [],
        locks: [{ resource: "git-branch", key: ports.registrations.branch }, { resource: "git-branch", key: ac.domain }, { resource: "git-branch", key: target.domain }, masterKubeLock],
        warnings: [],
        requiredSecrets: [],
      };
    },
    steps: (params) => migrateSteps(ports, consumerWorld(ports, params.appId), params.targetClusterId, attestTargetStep(ports, params.appId), "moved consumer"),
    cleanups: (params) => [discardGenerationCleanup(ports, consumerWorld(ports, params.appId)), reopenAccessCleanup(consumerWorld(ports, params.appId))],
  };
}

export function makeTenantMigrateDef(ports: TenantRelocationPorts): RunDefinition<TenantMigrateParams> {
  return {
    kind: "tenant-migrate",
    paramsSchema: TenantMigrateParams,
    mutating: true,
    plan: async (params, { db }) => {
      if (!("stage" in params)) throw errValidation("Move requires the selected stage and source machine — choose the stage and plan again");
      const { source: tc, target } = loadTenantMove(db, params);
      const stepDefs = migrateSteps(ports, tenantMoveWorld(ports, params), params.targetClusterId, attestTenantMoveStep(ports, params), "moved tenant stage");
      return {
        kind: "tenant-migrate",
        targetKind: "tenant",
        targetId: params.tenantId,
        summary: `Move tenant ${tc.guid} stage ${tc.stage} from ${tc.domain} to ${target.domain} through a new backup generation on the Storage Box — the WHOLE bracket, under the unchanged guid: quiesce and verify closed, dump every database of stage ${tc.stage} + its bucket + its crypto material, provision every member on the target, repoint (every source member namespace is marked relocating first, which is what keeps its databases when the flip prunes the ServiceClaims), verify the source released the tenant — its fan-out pruned — while still holding its data, restore, verify completeness, switch the one wildcard record, smoke, reopen, clear that stage from the source. Every other stage stays in place with its data, registration and hosts unchanged. ${summaryTail}`,
        steps: stepDefs.map((s) => ({ name: s.name, title: s.title })),
        targets: [],
        locks: tenantLocks(ports.registrations),
        warnings: [],
        requiredSecrets: [],
      };
    },
    steps: (params) => migrateSteps(ports, tenantMoveWorld(ports, params), params.targetClusterId, attestTenantMoveStep(ports, params), "moved tenant stage"),
    cleanups: (params) => [discardGenerationCleanup(ports, tenantMoveCleanupWorld(ports, params)), reopenAccessCleanup(tenantMoveCleanupWorld(ports, params))],
  };
}
