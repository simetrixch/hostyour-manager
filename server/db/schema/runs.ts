import { sqliteTable, text, integer, uniqueIndex, index, check, foreignKey } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { RUN_STATUS, STEP_STATUS, EVENT_STREAM, LOCK_RESOURCE } from "../../../shared/enums.ts";
import { operators } from "./operators.ts";
import { stampColumns, deletionColumns } from "./stamps.ts";

// runs / steps / events / run_locks — written by server/executor/** ONLY;
// reads go through executor/read.ts. Enforced by .dependency-cruiser.cjs.
export const runs = sqliteTable("runs", {
  id: text("id").primaryKey(),                                     // "run_" + ulid
  kind: text("kind").notNull(),                                  // the core's run kinds and every plugin's
  targetKind: text("target_kind").notNull(),                     // the core's target kinds and every plugin's
  targetId: text("target_id").notNull(),                          // FK-by-convention (kind varies)
  paramsJson: text("params_json", { mode: "json" }).notNull(),    // sanitized — never secret material
  planJson: text("plan_json", { mode: "json" }),                  // NULLABLE: a planning/failed run may have none
  status: text("status", { enum: RUN_STATUS }).notNull().default("planned"),
  approvedAt: integer("approved_at", { mode: "timestamp_ms" }),
  startedAt: integer("started_at", { mode: "timestamp_ms" }),
  finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
  error: text("error"),
  // `owner` is the operator who started the run; the run executes as that operator.
  ...stampColumns(),
  // Set by Executor.deleteRun on a settled run. The row and its steps and events stay for
  // retroactive inspection; listRuns filters it out.
  ...deletionColumns(),
}, (t) => [
  foreignKey({ columns: [t.owner], foreignColumns: [operators.id] }).onDelete("restrict"),
  index("runs_status_ix").on(t.status),
  index("runs_target_ix").on(t.targetKind, t.targetId),
  index("runs_creation_ix").on(t.creation),
  check("runs_plan_json_ck", sql`plan_json IS NOT NULL OR status IN ('planning','failed','cancelled')`),
]);

export const steps = sqliteTable("steps", {
  id: text("id").primaryKey(),                                     // "step_" + ulid
  runId: text("run_id").notNull().references(() => runs.id, { onDelete: "cascade" }),
  ordinal: integer("ordinal").notNull(),                           // 0-based execution order
  name: text("name").notNull(),                                    // stable id, e.g. "attest-target"
  title: text("title").notNull(),                                  // human
  status: text("status", { enum: STEP_STATUS }).notNull().default("pending"),
  startedAt: integer("started_at", { mode: "timestamp_ms" }),
  finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
  checkpointJson: text("checkpoint_json", { mode: "json" }),
  skipReason: text("skip_reason"),
  error: text("error"),
  ...stampColumns(),
}, (t) => [
  uniqueIndex("steps_run_ordinal_uq").on(t.runId, t.ordinal),
  uniqueIndex("steps_run_name_uq").on(t.runId, t.name),
]);

// The live log — APPEND-ONLY (enforced by the events_no_update/events_no_delete triggers), so `modified`
// and `modified_by` keep the values of the insert. One row ≈ one output line.
export const events = sqliteTable("events", {
  id: text("id").primaryKey(),                                     // "evt_" + ulid
  runId: text("run_id").notNull().references(() => runs.id, { onDelete: "cascade" }),
  stepId: text("step_id").references(() => steps.id, { onDelete: "cascade" }), // NULL = run-level meta
  stream: text("stream", { enum: EVENT_STREAM }).notNull(),
  seq: integer("seq").notNull(),                                   // monotone per run, executor-assigned
  text: text("text").notNull(),
  ...stampColumns(),
}, (t) => [
  uniqueIndex("events_run_seq_uq").on(t.runId, t.seq),             // also the SSE replay cursor
  index("events_step_ix").on(t.stepId),
]);

// The lock manager's table. The mutex is the unique index over the rows not released: a released
// lock keeps its row, with `deleted` set.
export const runLocks = sqliteTable("run_locks", {
  id: text("id").primaryKey(),                                     // "lock_" + ulid
  resource: text("resource", { enum: LOCK_RESOURCE }).notNull(),
  key: text("key").notNull(),
  runId: text("run_id").notNull().references(() => runs.id, { onDelete: "restrict" }),
  ...stampColumns(),
  ...deletionColumns(),
}, (t) => [
  uniqueIndex("run_locks_resource_key_uq").on(t.resource, t.key).where(sql`deleted IS NULL`),
  index("run_locks_run_ix").on(t.runId),
]);
