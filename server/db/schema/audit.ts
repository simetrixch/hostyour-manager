import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { TARGET_KIND } from "../../../shared/enums.ts";

const now = sql`(unixepoch('subsec') * 1000)`;

// APPEND-ONLY (enforced by the audit_no_update/audit_no_delete triggers). Written ONLY by db/audit-writer.ts
//. `run_id` is a loose reference by convention, NOT a Drizzle FK: keeping
// it a plain column means this file never imports schema/runs, so the boundary law
// "only executor touches runs schema" stays intact. audit-writer is the sole
// writer and only ever records valid run ids; run rows are never physically erased —
// "deleting" a planned/failed run (Executor.deleteRun) only sets runs.deleted_at, so every
// run_id here stays resolvable and the `run.deleted` entry records the soft delete.
export const audit = sqliteTable("audit", {
  id: text("id").primaryKey(),                                     // "aud_" + ulid
  ts: integer("ts", { mode: "timestamp_ms" }).notNull().default(now),
  actor: text("actor").notNull(),                                  // operator id, or "system"
  action: text("action").notNull(),                               // dot-namespaced action name
  targetKind: text("target_kind", { enum: TARGET_KIND }),
  targetId: text("target_id"),
  runId: text("run_id"),
  detailJson: text("detail_json", { mode: "json" }),
}, (t) => [
  index("audit_ts_ix").on(t.ts),
  index("audit_target_ix").on(t.targetKind, t.targetId),
]);
