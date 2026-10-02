// consumer-nightly-backup / tenant-nightly-backup — the nightly pass over every standing unit of a
// family (hostyour-cloud#254): one online generation each, without closing access, then retention.
// One unit's failure is recorded and the next unit is backed up anyway; the run fails at its end,
// naming every unit that has no generation of tonight, so a red run is the whole report.
import { z } from "zod";
import { inArray } from "drizzle-orm";
import type { RunDefinition, Step, StepCtx } from "../../executor/types.ts";
import { apps, tenants } from "../../db/schema/inventory.ts";
import { errValidation } from "../../kernel/errors.ts";
import { findBackupOfRun, listBackups, recordBackupPruned } from "../../db/unit-backups.ts";
import {
  backupUnitOf, discardGenerationsCleanup, requireDbtoolsImage, requireStorageBox, runRelocationJob, takeOnlineGeneration,
  type RelocationPorts, type RelocationWorld, type WorldOf,
} from "#unit/server/relocation.ts";
import { MONGO_NAMESPACE, purgeGenerationJob } from "#unit/server/relocation-jobs.ts";
import { generationsToKeep, KEEP_NEWEST, KEEP_WEEKS } from "#unit/server/backup-retention.ts";
import { consumerWorld, type ConsumerRelocationPorts } from "./relocation-world-consumer.ts";
import { tenantWorld, type TenantRelocationPorts } from "./relocation-world-tenant.ts";

export const NightlyBackupParams = z.object({}).strict();
export type NightlyBackupParams = z.infer<typeof NightlyBackupParams>;

/** One unit the pass backs up: how it is named in the log, and its world. */
interface NightlyUnit {
  label: string;
  worldOf: WorldOf;
}

/** Take off the box, and mark in the book, every verified generation of the unit retention drops. */
async function applyRetention(ports: RelocationPorts, ctx: StepCtx, w: RelocationWorld): Promise<number> {
  const verified = listBackups(ctx.db, backupUnitOf(w)).filter((b) => b.state === "ok");
  const keep = generationsToKeep(verified.map((b) => b.generation));
  const drop = verified.filter((b) => !keep.has(b.generation));
  if (drop.length === 0) return 0;
  const image = requireDbtoolsImage(ports, "retention");
  for (const g of drop) {
    await runRelocationJob(ports, ctx, w.sourceClusterId, purgeGenerationJob({ unit: w.unit, folder: g.folder, namespace: MONGO_NAMESPACE, image }));
    recordBackupPruned(ctx.db, g);
  }
  return drop.length;
}

/** Back up one unit, and say in `failed` what kept it from a generation of tonight or from retention. */
async function backUpUnit(ports: RelocationPorts, ctx: StepCtx, u: NightlyUnit, failed: string[]): Promise<void> {
  let w: RelocationWorld;
  try {
    w = await u.worldOf(ctx);
    // A resumed step does not take a second generation of a unit this run already settled.
    const settled = findBackupOfRun(ctx.db, ctx.runId, backupUnitOf(w));
    if (settled?.state === "failed") failed.push(`${u.label} (${settled.detail ?? "failed"})`);
    if (settled && settled.state !== "taking") return;
    const g = await takeOnlineGeneration(ports, ctx, w, "nightly");
    ctx.log("meta", `${u.label}: generation ${g.generation} written and verified in ${g.folder}/`);
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    failed.push(`${u.label} (${why})`);
    ctx.log("meta", `${u.label}: NO backup of tonight — ${why}`);
    return;
  }
  try {
    const dropped = await applyRetention(ports, ctx, w);
    if (dropped > 0) ctx.log("meta", `${u.label}: ${dropped} older generation(s) taken off the box by retention`);
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    failed.push(`${u.label} (retention: ${why})`);
    ctx.log("meta", `${u.label}: backed up, but retention failed — ${why}`);
  }
}

function nightlyStep(ports: RelocationPorts, family: string, unitsOf: (ctx: StepCtx) => NightlyUnit[]): Step {
  return {
    name: `back-up-every-${family}`,
    title: `Back up every standing ${family} online into a new generation, then apply retention`,
    run: async (ctx) => {
      const units = unitsOf(ctx);
      const failed: string[] = [];
      for (const u of units) await backUpUnit(ports, ctx, u, failed);
      ctx.checkpoint({ units: units.length, failed: failed.length });
      if (failed.length > 0) throw errValidation(`${failed.length} of ${units.length} ${family}(s) failed the nightly backup: ${failed.join("; ")}`);
      ctx.log("meta", `${units.length} ${family}(s) backed up online, retention applied`);
    },
  };
}

const summaryOf = (count: number, family: string): string =>
  `Back up ${count} standing ${family}(s) online — access stays open — each into a new generation on the Storage Box with its manifest, verify it, and keep the newest ${KEEP_NEWEST} plus the newest of each of the last ${KEEP_WEEKS} weeks. A ${family} that fails is recorded and the next one is backed up; the run fails at its end, naming each.`;

/** The definition both families share: one step, the master lock every relocation run takes (a dump
 *  job of a unit carries the same name in a Backup, a move and this pass), and a plan that refuses a
 *  manager without a Storage Box instead of starting a run that can only fail. */
function nightlyDef(kind: "consumer-nightly-backup" | "tenant-nightly-backup", family: string, ports: RelocationPorts, unitsOf: (ctx: Pick<StepCtx, "db">) => NightlyUnit[]): RunDefinition<NightlyBackupParams> {
  return {
    kind,
    paramsSchema: NightlyBackupParams,
    // It changes no unit: its jobs read the stores and write the box, and the one credential it
    // places is taken away with its job. `mutating` is about what a run puts on a MACHINE.
    mutating: false,
    plan: async (_params, { db }) => {
      requireStorageBox(ports, kind);
      return {
        kind,
        targetKind: "self",
        targetId: "manager",
        summary: summaryOf(unitsOf({ db }).length, family),
        steps: [{ name: `back-up-every-${family}`, title: `Back up every standing ${family} online into a new generation, then apply retention` }],
        locks: [{ resource: "master-kube", key: "m" }],
        warnings: [],
        requiredSecrets: [],
      };
    },
    steps: () => [nightlyStep(ports, family, unitsOf)],
    // The step backs up every unit, so its abort discards the unfinished generation of every unit.
    cleanups: () => [discardGenerationsCleanup(ports, (ctx) => unitsOf(ctx).map((u) => u.worldOf))],
  };
}

export function makeConsumerNightlyBackupDef(ports: ConsumerRelocationPorts): RunDefinition<NightlyBackupParams> {
  return nightlyDef("consumer-nightly-backup", "consumer", ports, ({ db }) =>
    db.select({ id: apps.id, name: apps.name, stage: apps.stage }).from(apps).where(inArray(apps.status, ["active", "suspended"])).all()
      .map((a) => ({ label: `consumer ${a.name} (${a.stage})`, worldOf: consumerWorld(ports, a.id) })));
}

export function makeTenantNightlyBackupDef(ports: TenantRelocationPorts): RunDefinition<NightlyBackupParams> {
  return nightlyDef("tenant-nightly-backup", "tenant", ports, ({ db }) =>
    db.select({ id: tenants.id, guid: tenants.guid, subdomain: tenants.subdomain, stage: tenants.stage }).from(tenants).where(inArray(tenants.status, ["active", "suspended"])).all()
      .map((t) => ({ label: `tenant ${t.subdomain} (${t.guid}, ${t.stage})`, worldOf: tenantWorld(ports, t.id) })));
}
