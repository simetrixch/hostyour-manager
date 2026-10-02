import { and, desc, eq, like, ne } from "drizzle-orm";
import type { Db } from "./client.ts";
import { unitBackups } from "./schema/unit-backups.ts";
import type { BackupState, BackupTrigger, Stage } from "../../shared/enums.ts";

// The one writer and the one reader of the book of backups (schema/unit-backups.ts). It stands under
// server/db for the reason db/dns-writes.ts gives: its writers are run kinds of several files and the
// nightly pass, and a table writer here is what every domain and plugin may reach.

/** The unit a backup is taken of: its kind, its identity (tenant guid, consumer name) and its stage. */
export interface BackupUnit {
  kind: "tenant" | "consumer";
  unit: string;
  stage: Stage;
}

/** One generation of a unit's backup, as the book knows it. */
export interface UnitBackup extends BackupUnit {
  generation: string;
  folder: string;
  trigger: BackupTrigger;
  runId: string | null;
  state: BackupState;
  detail: string | null;
  takenAt: Date;
  finishedAt: Date | null;
}

type GenerationKey = BackupUnit & { generation: string };

const keyOf = (g: GenerationKey) =>
  and(eq(unitBackups.kind, g.kind), eq(unitBackups.unit, g.unit), eq(unitBackups.stage, g.stage), eq(unitBackups.generation, g.generation));

/** Enter a generation that is being taken. */
export function recordBackupStarted(db: Db, g: GenerationKey & { folder: string; trigger: BackupTrigger; runId: string }): void {
  db.insert(unitBackups).values({ ...g, state: "taking", takenAt: new Date() }).run();
}

/** Settle a generation: written and verified, or failed with the reason. */
export function recordBackupFinished(db: Db, g: GenerationKey, outcome: { state: "ok" } | { state: "failed"; detail: string }): void {
  db.update(unitBackups)
    .set({ state: outcome.state, detail: outcome.state === "failed" ? outcome.detail : null, finishedAt: new Date() })
    .where(keyOf(g))
    .run();
}

/** Mark a generation that retention took off the box. */
export function recordBackupPruned(db: Db, g: GenerationKey): void {
  db.update(unitBackups).set({ state: "pruned" }).where(keyOf(g)).run();
}

/** Every generation of one unit, newest first. */
export function listBackups(db: Db, u: BackupUnit): UnitBackup[] {
  return db
    .select()
    .from(unitBackups)
    .where(and(eq(unitBackups.kind, u.kind), eq(unitBackups.unit, u.unit), eq(unitBackups.stage, u.stage)))
    .orderBy(desc(unitBackups.generation))
    .all();
}

/** Every unit's most recent generation that is not pruned, one per unit. */
export function latestBackups(db: Db): UnitBackup[] {
  const latest = new Map<string, UnitBackup>();
  for (const b of db.select().from(unitBackups).where(ne(unitBackups.state, "pruned")).orderBy(desc(unitBackups.generation)).all()) {
    const key = `${b.kind}/${b.unit}/${b.stage}`;
    if (!latest.has(key)) latest.set(key, b);
  }
  return [...latest.values()];
}

/** Does any unit of `kind` hold a nightly generation taken on the UTC day `day` (YYYYMMDD)? */
export function hasNightlyGenerationOn(db: Db, kind: BackupUnit["kind"], day: string): boolean {
  return db
    .select({ generation: unitBackups.generation })
    .from(unitBackups)
    .where(and(eq(unitBackups.kind, kind), eq(unitBackups.trigger, "nightly"), like(unitBackups.generation, `${day}T%`)))
    .get() !== undefined;
}

/** One generation of a unit, or undefined. */
export function findBackup(db: Db, g: GenerationKey): UnitBackup | undefined {
  return db.select().from(unitBackups).where(keyOf(g)).get();
}

/** Every generation a run took or is taking, of any unit. */
export function listBackupsOfRun(db: Db, runId: string): UnitBackup[] {
  return db.select().from(unitBackups).where(eq(unitBackups.runId, runId)).all();
}

/** The generation a run took or is taking of one unit — a run takes at most one per unit. */
export function findBackupOfRun(db: Db, runId: string, u: BackupUnit): UnitBackup | undefined {
  return db
    .select()
    .from(unitBackups)
    .where(and(eq(unitBackups.runId, runId), eq(unitBackups.kind, u.kind), eq(unitBackups.unit, u.unit), eq(unitBackups.stage, u.stage)))
    .get();
}
