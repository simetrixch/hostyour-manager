// backup / tenant-backup — the first half of the ONE relocation mechanism, run for its own
// sake: close access ENFORCED, dump every store into a new generation of the unit's backup on the
// Storage Box, verify it, reopen. The generation STAYS, and the unit runs afterwards exactly as before. Both defs compose the same shared steps over their kind's world;
// there is no backup-specific code path to drift.
import { z } from "zod";
import type { RunDefinition, LockClaim, Step } from "../../executor/types.ts";
import { attestTargetStep, attestTenantTargetStep, loadAppCluster, loadTenantCluster } from "./lifecycle.ts";
import { tenantLocks } from "./tenant-lifecycle.run.ts";
import { quiesceStep, verifyQuiescedStep, dumpStep, verifyDumpStep, openAccessStep, discardGenerationCleanup, reopenAccessCleanup, type WorldOf } from "#unit/server/relocation.ts";
import { consumerWorld, type ConsumerRelocationPorts } from "./relocation-world-consumer.ts";
import { tenantWorld, type TenantRelocationPorts } from "./relocation-world-tenant.ts";

export const BackupParams = z.object({ appId: z.string().startsWith("app_") });
export type BackupParams = z.infer<typeof BackupParams>;

export const TenantBackupParams = z.object({ tenantId: z.string().startsWith("tnt_") });
export type TenantBackupParams = z.infer<typeof TenantBackupParams>;

const masterKubeLock: LockClaim = { resource: "master-kube", key: "m" };

/** The backup half over any world — quiesce, prove it, dump, prove it, reopen. */
function backupSteps(ports: ConsumerRelocationPorts | TenantRelocationPorts, worldOf: WorldOf, attest: Step): Step[] {
  return [attest, quiesceStep(worldOf), verifyQuiescedStep(ports, worldOf), dumpStep(ports, worldOf, "manual"), verifyDumpStep(ports, worldOf), openAccessStep(worldOf, "source")];
}

const summaryTail =
  "Access is closed and MEASURED closed for the duration of the dump (downtime, never an inconsistent copy), then reopened. The generation STAYS on the storage box beside the earlier ones, and a restore can pick it.";

export function makeBackupDef(ports: ConsumerRelocationPorts): RunDefinition<BackupParams> {
  return {
    kind: "consumer-backup",
    paramsSchema: BackupParams,
    mutating: true, // mutating ⇒ steps()[0] MUST be attest-target
    plan: async (params, { db }) => {
      const ac = loadAppCluster(db, params.appId);
      const stepDefs = backupSteps(ports, consumerWorld(ports, params.appId), attestTargetStep(ports, params.appId));
      return {
        kind: "consumer-backup",
        targetKind: "app",
        targetId: params.appId,
        summary: `Back up consumer "${ac.name}" on ${ac.domain} (${ac.stage}) into a new generation under consumers/${ac.name}/ on the Storage Box: quiesce, verify access is closed, dump the registration + its databases + the per-consumer PostgreSQL + every PVC with a manifest of checksums, verify the generation, reopen. ${summaryTail}`,
        steps: stepDefs.map((s) => ({ name: s.name, title: s.title })),
        targets: [],
        locks: [{ resource: "git-branch", key: ports.registrations.branch }, { resource: "git-branch", key: ac.domain }, masterKubeLock],
        warnings: [],
        requiredSecrets: [],
      };
    },
    steps: (params) => backupSteps(ports, consumerWorld(ports, params.appId), attestTargetStep(ports, params.appId)),
    cleanups: (params) => [discardGenerationCleanup(ports, consumerWorld(ports, params.appId)), reopenAccessCleanup(consumerWorld(ports, params.appId))],
  };
}

export function makeTenantBackupDef(ports: TenantRelocationPorts): RunDefinition<TenantBackupParams> {
  return {
    kind: "tenant-backup",
    paramsSchema: TenantBackupParams,
    mutating: true,
    plan: async (params, { db }) => {
      const tc = loadTenantCluster(db, params.tenantId);
      const stepDefs = backupSteps(ports, tenantWorld(ports, params.tenantId), attestTenantTargetStep(ports, params.tenantId));
      return {
        kind: "tenant-backup",
        targetKind: "tenant",
        targetId: params.tenantId,
        summary: `Back up tenant ${tc.guid} on ${tc.domain} (${tc.stage}) into a new generation under tenants/${tc.guid}/ on the Storage Box: quiesce the whole bracket, verify access is closed, dump the registration + every ${tc.guid}_* database + the bucket + the crypto material with a manifest of checksums, verify the generation, reopen. ${summaryTail}`,
        steps: stepDefs.map((s) => ({ name: s.name, title: s.title })),
        targets: [],
        locks: tenantLocks(ports.registrations),
        warnings: [],
        requiredSecrets: [],
      };
    },
    steps: (params) => backupSteps(ports, tenantWorld(ports, params.tenantId), attestTenantTargetStep(ports, params.tenantId)),
    cleanups: (params) => [discardGenerationCleanup(ports, tenantWorld(ports, params.tenantId)), reopenAccessCleanup(tenantWorld(ports, params.tenantId))],
  };
}
