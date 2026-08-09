import { sqliteTable, text, integer, uniqueIndex, index, primaryKey, check } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { RUN_KIND, RUN_STATUS, STEP_STATUS, EVENT_STREAM, TARGET_KIND, LOCK_RESOURCE } from "../../../shared/enums.ts";
import { operators } from "./operators.ts";

const now = sql`(unixepoch('subsec') * 1000)`;

// runs / steps / events / run_locks — written by server/executor/** ONLY;
// reads go through executor/read.ts. Enforced by .dependency-cruiser.cjs.
export const runs = sqliteTable("runs", {
  id: text("id").primaryKey(),                                     // "run_" + ulid
  kind: text("kind", { enum: RUN_KIND }).notNull(),
  targetKind: text("target_kind", { enum: TARGET_KIND }).notNull(),
  targetId: text("target_id").notNull(),                          // FK-by-convention (kind varies)
  paramsJson: text("params_json", { mode: "json" }).notNull(),    // sanitized — never secret material
  planJson: text("plan_json", { mode: "json" }),                  // NULLABLE: a planning/failed run may have none
  status: text("status", { enum: RUN_STATUS }).notNull().default("planned"),
  startedBy: text("started_by").notNull().references(() => operators.id, { onDelete: "restrict" }),
  approvedAt: integer("approved_at", { mode: "timestamp_ms" }),
  startedAt: integer("started_at", { mode: "timestamp_ms" }),
  finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
  error: text("error"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(now),
  // Soft-delete marker: set by Executor.deleteRun on a planned/failed run.
  // The row and its steps + events stay for retroactive inspection; listRuns filters it out.
  deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
}, (t) => [
  index("runs_status_ix").on(t.status),
  index("runs_target_ix").on(t.targetKind, t.targetId),
  index("runs_created_ix").on(t.createdAt),
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
}, (t) => [
  uniqueIndex("steps_run_ordinal_uq").on(t.runId, t.ordinal),
  uniqueIndex("steps_run_name_uq").on(t.runId, t.name),
]);

// The live log — APPEND-ONLY (enforced by the events_no_update/events_no_delete triggers). One row ≈ one output line.
export const events = sqliteTable("events", {
  id: text("id").primaryKey(),                                     // "evt_" + ulid
  runId: text("run_id").notNull().references(() => runs.id, { onDelete: "cascade" }),
  stepId: text("step_id").references(() => steps.id, { onDelete: "cascade" }), // NULL = run-level meta
  ts: integer("ts", { mode: "timestamp_ms" }).notNull().default(now),
  stream: text("stream", { enum: EVENT_STREAM }).notNull(),
  seq: integer("seq").notNull(),                                   // monotone per run, executor-assigned
  text: text("text").notNull(),
}, (t) => [
  uniqueIndex("events_run_seq_uq").on(t.runId, t.seq),             // also the SSE replay cursor
  index("events_step_ix").on(t.stepId),
]);

// The lock manager's table — the mutex IS the primary key.
export const runLocks = sqliteTable("run_locks", {
  resource: text("resource", { enum: LOCK_RESOURCE }).notNull(),
  key: text("key").notNull(),
  runId: text("run_id").notNull().references(() => runs.id, { onDelete: "restrict" }),
  acquiredAt: integer("acquired_at", { mode: "timestamp_ms" }).notNull().default(now),
}, (t) => [
  primaryKey({ columns: [t.resource, t.key] }),
  index("run_locks_run_ix").on(t.runId),
]);
