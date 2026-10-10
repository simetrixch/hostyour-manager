import { sqliteTable, text, integer, primaryKey } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { BACKUP_STATE, BACKUP_TRIGGER, STAGE } from "../../../shared/enums.ts";
import { stampColumns } from "./stamps.ts";

const now = sql`(unixepoch('subsec') * 1000)`;

// THE BOOK OF BACKUPS: one row per generation of a unit's backup on the Hetzner Storage Box, keyed by
// the unit (kind, name, stage) and the generation. The box holds the data; this book is what a page
// lists and what a restore picks from, so neither has to list the box. `folder` is the generation's
// path below the box root as it was WRITTEN, so a restore reads exactly that folder. Written and read
// through db/unit-backups.ts only (hostyour-cloud#254).
//
// `run_id` is a loose reference by convention, NOT a Drizzle FK, for the reason schema/dns-writes.ts
// states: the boundary law "only the executor touches the runs schema" stays intact. Every writer
// names the run that takes the generation: a Backup, a move, or the nightly pass.
export const unitBackups = sqliteTable("unit_backups", {
  kind: text("kind").$type<"tenant" | "consumer">().notNull(),
  unit: text("unit").notNull(), // the tenant guid or the consumer name
  stage: text("stage", { enum: STAGE }).notNull(),
  generation: text("generation").notNull(), // the UTC moment it was taken, YYYYMMDDTHHMMSSZ
  folder: text("folder").notNull(),
  trigger: text("trigger", { enum: BACKUP_TRIGGER }).notNull(),
  runId: text("run_id"),
  state: text("state", { enum: BACKUP_STATE }).notNull(),
  detail: text("detail"), // why a generation failed
  takenAt: integer("taken_at", { mode: "timestamp_ms" }).notNull().default(now),
  finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
  ...stampColumns(),
}, (t) => [
  primaryKey({ columns: [t.kind, t.unit, t.stage, t.generation] }),
]);
