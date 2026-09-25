// backup / tenant-backup — the first half of the ONE relocation mechanism, run for its own
// sake: close access ENFORCED, dump every store into the unit's Storage Box folder, verify the
// folder, reopen. The folder STAYS — that is the entire difference from a move — and the unit runs
// afterwards exactly as before. Both defs compose the same shared steps over their kind's world;
// there is no backup-specific code path to drift.
import { z } from "zod";
import type { RunDefinition, LockClaim, Step } from "../../executor/types.ts";
import { attestTargetStep, attestTenantTargetStep, loadAppCluster, loadTenantCluster } from "./lifecycle.ts";
import { tenantLocks } from "./tenant-lifecycle.run.ts";
import { quiesceStep, verifyQuiescedStep, dumpStep, verifyDumpStep, openAccessStep, type WorldOf } from "./relocation.ts";
import { consumerWorld, type ConsumerRelocationPorts } from "./relocation-world-consumer.ts";
import { tenantWorld, type TenantRelocationPorts } from "./relocation-world-tenant.ts";

export const BackupParams = z.object({ appId: z.string().startsWith("app_") });
export type BackupParams = z.infer<typeof BackupParams>;

export const TenantBackupParams = z.object({ tenantId: z.string().startsWith("tnt_") });
export type TenantBackupParams = z.infer<typeof TenantBackupParams>;

const masterKubeLock: LockClaim = { resource: "master-kube", key: "m" };

/** The backup half over any world — quiesce, prove it, dump, prove it, reopen. */
function backupSteps(ports: ConsumerRelocationPorts | TenantRelocationPorts, worldOf: WorldOf, attest: Step): Step[] {
  return [attest, quiesceStep(worldOf), verifyQuiescedStep(ports, worldOf), dumpStep(ports, worldOf), verifyDumpStep(ports, worldOf), openAccessStep(worldOf, "source")];
}

const summaryTail =
  "Access is closed and MEASURED closed for the duration of the dump (downtime, never an inconsistent copy), then reopened. The folder on the storage box STAYS — keeping it is what makes this a backup.";

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
        summary: `Back up consumer "${ac.name}" on ${ac.domain} (${ac.stage}) into the Storage Box folder /${ac.name}/: quiesce, verify access is closed, dump the registration + its databases + the per-consumer PostgreSQL + the claim bucket + every PVC, verify the folder, reopen. ${summaryTail}`,
        steps: stepDefs.map((s) => ({ name: s.name, title: s.title })),
        targets: [],
        locks: [{ resource: "git-branch", key: ports.registrations.branch }, { resource: "git-branch", key: ac.domain }, masterKubeLock],
        warnings: [],
        requiredSecrets: [],
      };
    },
    steps: (params) => backupSteps(ports, consumerWorld(ports, params.appId), attestTargetStep(ports, params.appId)),
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
        summary: `Back up tenant ${tc.guid} on ${tc.domain} (${tc.stage}) into the Storage Box folder /${tc.guid}/: quiesce the whole bracket, verify access is closed, dump the registration + every ${tc.guid}_* database + the bucket + the crypto material, verify the folder, reopen. ${summaryTail}`,
        steps: stepDefs.map((s) => ({ name: s.name, title: s.title })),
        targets: [],
        locks: tenantLocks(ports.registrations),
        warnings: [],
        requiredSecrets: [],
      };
    },
    steps: (params) => backupSteps(ports, tenantWorld(ports, params.tenantId), attestTenantTargetStep(ports, params.tenantId)),
  };
}
