// restore / tenant-restore — the second half of the ONE relocation mechanism, run on its
// own: provide the target, rebuild the unit FROM its Storage Box folder (the dumped registration is
// the blueprint — the live one may be long gone, an offboarded unit's IS), prove completeness before
// DNS, switch the record, smoke, reopen, settle the row. The folder is never touched beyond reads —
// a failed restore leaves the source of truth fully intact.
import { z } from "zod";
import type { RunDefinition, LockClaim, Step } from "../../executor/types.ts";
import { loadAppCluster, loadTenantCluster } from "./lifecycle.ts";
import { tenantLocks } from "./tenant-lifecycle.run.ts";
import { loadActiveTargetCluster } from "./relocation-target.ts";
import { openAccessStep, type RelocationPorts, type WorldOf } from "./relocation.ts";
import {
  attestRestoreTargetStep,
  provisionTargetFromDumpStep,
  watchTargetStep,
  restoreStep,
  verifyCompletenessStep,
  switchDnsStep,
  targetSmokeStep,
  recordStep,
} from "./relocation-restore.ts";
import { consumerWorld, type ConsumerRelocationPorts } from "./relocation-world-consumer.ts";
import { tenantWorld, type TenantRelocationPorts } from "./relocation-world-tenant.ts";

export const RestoreParams = z.object({ appId: z.string().startsWith("app_"), targetClusterId: z.string().startsWith("cls_") });
export type RestoreParams = z.infer<typeof RestoreParams>;

export const TenantRestoreParams = z.object({ tenantId: z.string().startsWith("tnt_"), targetClusterId: z.string().startsWith("cls_") });
export type TenantRestoreParams = z.infer<typeof TenantRestoreParams>;

const masterKubeLock: LockClaim = { resource: "master-kube", key: "m" };

/** The restore verb over any world: the target half of the relocation sequence, opened at the end. */
function restoreSteps(ports: RelocationPorts, worldOf: WorldOf, targetClusterId: string, what: string): Step[] {
  return [
    attestRestoreTargetStep(ports, worldOf, targetClusterId),
    provisionTargetFromDumpStep(ports, worldOf, targetClusterId),
    watchTargetStep(worldOf, targetClusterId),
    restoreStep(ports, worldOf, targetClusterId),
    verifyCompletenessStep(ports, worldOf, targetClusterId),
    switchDnsStep(ports, worldOf, targetClusterId, "restore"),
    targetSmokeStep(ports, worldOf, targetClusterId),
    openAccessStep(worldOf, "target", targetClusterId),
    recordStep(worldOf, targetClusterId, what),
  ];
}

const summaryTail =
  "The unit deploys CLOSED (quiesced) while its stores are replayed from the box folder, completeness is verified BEFORE the DNS record points anywhere, and access opens last. The folder is only read — a failed restore leaves it fully intact.";

export function makeRestoreDef(ports: ConsumerRelocationPorts): RunDefinition<RestoreParams> {
  return {
    kind: "restore",
    paramsSchema: RestoreParams,
    mutating: true, // mutating ⇒ steps()[0] MUST be attest-target
    plan: async (params, { db }) => {
      const ac = loadAppCluster(db, params.appId);
      const target = loadActiveTargetCluster(db, params.targetClusterId, ac.stage);
      const stepDefs = restoreSteps(ports, consumerWorld(ports, params.appId), params.targetClusterId, "restored consumer");
      return {
        kind: "restore",
        targetKind: "app",
        targetId: params.appId,
        summary: `Restore consumer "${ac.name}" (${ac.stage}) from the Storage Box folder /${ac.name}/ onto ${target.domain}: provision the target from the dumped registration, re-commit it quiesced, replay every store, verify completeness, switch the one DNS record, smoke, open access, mark active. ${summaryTail}`,
        steps: stepDefs.map((s) => ({ name: s.name, title: s.title })),
        targets: [],
        locks: [{ resource: "git-branch", key: ports.registry.branch }, { resource: "git-branch", key: target.domain }, masterKubeLock],
        warnings: [],
        requiredSecrets: [],
      };
    },
    steps: (params) => restoreSteps(ports, consumerWorld(ports, params.appId), params.targetClusterId, "restored consumer"),
  };
}

export function makeTenantRestoreDef(ports: TenantRelocationPorts): RunDefinition<TenantRestoreParams> {
  return {
    kind: "tenant-restore",
    paramsSchema: TenantRestoreParams,
    mutating: true,
    plan: async (params, { db }) => {
      const tc = loadTenantCluster(db, params.tenantId);
      const target = loadActiveTargetCluster(db, params.targetClusterId, tc.stage);
      const stepDefs = restoreSteps(ports, tenantWorld(ports, params.tenantId), params.targetClusterId, "restored tenant");
      return {
        kind: "tenant-restore",
        targetKind: "tenant",
        targetId: params.tenantId,
        summary: `Restore tenant ${tc.guid} (${tc.stage}) from the Storage Box folder /${tc.guid}/ onto ${target.domain}: provision every member's isolation + the Tenant CR from the dumped registration, re-commit it quiesced, replay every ${tc.guid}_* database and the bucket (the crypto material stays in Vault — one shared mount, byte-identical), verify completeness, switch the one wildcard record, smoke, open access, mark active. ${summaryTail}`,
        steps: stepDefs.map((s) => ({ name: s.name, title: s.title })),
        targets: [],
        locks: tenantLocks(ports.registry),
        warnings: [],
        requiredSecrets: [],
      };
    },
    steps: (params) => restoreSteps(ports, tenantWorld(ports, params.tenantId), params.targetClusterId, "restored tenant"),
  };
}
