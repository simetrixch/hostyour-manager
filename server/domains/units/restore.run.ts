// restore / tenant-restore — the second half of the ONE relocation mechanism, run on its
// own: provide the target, rebuild the unit FROM the backup generation the operator picked (the
// dumped registration is the blueprint — the live one may be long gone, an offboarded unit's IS),
// prove completeness before DNS, switch the record, smoke, reopen, settle the row. The generation is
// only read — a failed restore leaves it fully intact.
import { z } from "zod";
import type { RunDefinition, LockClaim, Step } from "../../executor/types.ts";
import { loadAppCluster, loadTenantCluster } from "./lifecycle.ts";
import { tenantLocks } from "./tenant-lifecycle.run.ts";
import { loadActiveTargetCluster } from "#unit/server/relocation-target.ts";
import { openAccessStep, pickedGeneration, type RelocationPorts, type WorldOf } from "#unit/server/relocation.ts";
import { findBackup, type BackupUnit } from "../../db/unit-backups.ts";
import { errValidation } from "../../kernel/errors.ts";
import type { Db } from "../../db/client.ts";
import {
  attestRestoreTargetStep,
  provisionTargetFromDumpStep,
  watchTargetStep,
  restoreStep,
  verifyCompletenessStep,
  switchDnsStep,
  targetSmokeStep,
  recordStep,
} from "#unit/server/relocation-restore.ts";
import { consumerWorld, type ConsumerRelocationPorts } from "./relocation-world-consumer.ts";
import { tenantWorld, type TenantRelocationPorts } from "./relocation-world-tenant.ts";

/** A generation as its folder names it (generationId): the UTC moment it was taken. */
const Generation = z.string().regex(/^\d{8}T\d{6}Z$/, "a generation is named YYYYMMDDTHHMMSSZ");

export const RestoreParams = z.object({ appId: z.string().startsWith("app_"), targetClusterId: z.string().startsWith("cls_"), generation: Generation });
export type RestoreParams = z.infer<typeof RestoreParams>;

export const TenantRestoreParams = z.object({ tenantId: z.string().startsWith("tnt_"), targetClusterId: z.string().startsWith("cls_"), generation: Generation });
export type TenantRestoreParams = z.infer<typeof TenantRestoreParams>;

/** The picked generation, refused at plan unless it is written and verified — the same law the steps
 *  hold it to, said before anything is approved. */
function assertRestorable(db: Db, unit: BackupUnit, generation: string): void {
  const g = findBackup(db, { ...unit, generation });
  if (!g) throw errValidation(`${unit.kind} ${unit.unit} (${unit.stage}) has no backup generation ${generation}`);
  if (g.state !== "ok") throw errValidation(`generation ${generation} of ${unit.kind} ${unit.unit} is ${g.state} — only a written and verified generation is restored`);
}

const masterKubeLock: LockClaim = { resource: "master-kube", key: "m" };

/** The restore run kind over any world: the target half of the relocation sequence, opened at the end. */
function restoreSteps(ports: RelocationPorts, worldOf: WorldOf, targetClusterId: string, generation: string, what: string): Step[] {
  const picked = pickedGeneration(generation);
  return [
    attestRestoreTargetStep(ports, worldOf, targetClusterId),
    provisionTargetFromDumpStep(ports, worldOf, targetClusterId, picked),
    watchTargetStep(worldOf, targetClusterId),
    restoreStep(ports, worldOf, targetClusterId, picked),
    verifyCompletenessStep(ports, worldOf, targetClusterId, picked),
    switchDnsStep(ports, worldOf, targetClusterId, "consumer-restore"),
    targetSmokeStep(ports, worldOf, targetClusterId),
    openAccessStep(worldOf, "target", targetClusterId),
    recordStep(worldOf, targetClusterId, what),
  ];
}

const summaryTail =
  "The unit deploys CLOSED (quiesced) while its stores are replayed from the generation, completeness is verified BEFORE the DNS record points anywhere, and access opens last. The generation is only read — a failed restore leaves it fully intact.";

export function makeRestoreDef(ports: ConsumerRelocationPorts): RunDefinition<RestoreParams> {
  return {
    kind: "consumer-restore",
    paramsSchema: RestoreParams,
    mutating: true, // mutating ⇒ steps()[0] MUST be attest-target
    plan: async (params, { db }) => {
      const ac = loadAppCluster(db, params.appId);
      const target = loadActiveTargetCluster(db, params.targetClusterId);
      assertRestorable(db, { kind: "consumer", unit: ac.name, stage: ac.stage }, params.generation);
      const stepDefs = restoreSteps(ports, consumerWorld(ports, params.appId), params.targetClusterId, params.generation, "restored consumer");
      return {
        kind: "consumer-restore",
        targetKind: "app",
        targetId: params.appId,
        summary: `Restore consumer "${ac.name}" (${ac.stage}) from its backup generation ${params.generation} onto ${target.domain}: provision the target from the dumped registration, re-commit it quiesced, replay every store, verify completeness, switch the one DNS record, smoke, open access, mark active. ${summaryTail}`,
        steps: stepDefs.map((s) => ({ name: s.name, title: s.title })),
        targets: [],
        locks: [{ resource: "git-branch", key: ports.registrations.branch }, { resource: "git-branch", key: target.domain }, masterKubeLock],
        warnings: [],
        requiredSecrets: [],
      };
    },
    steps: (params) => restoreSteps(ports, consumerWorld(ports, params.appId), params.targetClusterId, params.generation, "restored consumer"),
  };
}

export function makeTenantRestoreDef(ports: TenantRelocationPorts): RunDefinition<TenantRestoreParams> {
  return {
    kind: "tenant-restore",
    paramsSchema: TenantRestoreParams,
    mutating: true,
    plan: async (params, { db }) => {
      const tc = loadTenantCluster(db, params.tenantId);
      const target = loadActiveTargetCluster(db, params.targetClusterId);
      assertRestorable(db, { kind: "tenant", unit: tc.guid, stage: tc.stage }, params.generation);
      const stepDefs = restoreSteps(ports, tenantWorld(ports, params.tenantId), params.targetClusterId, params.generation, "restored tenant");
      return {
        kind: "tenant-restore",
        targetKind: "tenant",
        targetId: params.tenantId,
        summary: `Restore tenant ${tc.guid} (${tc.stage}) from its backup generation ${params.generation} onto ${target.domain}: provision every member's isolation + the Tenant CR from the dumped registration, re-commit it quiesced, replay every ${tc.guid}_* database and the bucket (the crypto material stays in Vault — one shared mount, byte-identical), verify completeness, switch the one wildcard record, smoke, open access, mark active. ${summaryTail}`,
        steps: stepDefs.map((s) => ({ name: s.name, title: s.title })),
        targets: [],
        locks: tenantLocks(ports.registrations),
        warnings: [],
        requiredSecrets: [],
      };
    },
    steps: (params) => restoreSteps(ports, tenantWorld(ports, params.tenantId), params.targetClusterId, params.generation, "restored tenant"),
  };
}
