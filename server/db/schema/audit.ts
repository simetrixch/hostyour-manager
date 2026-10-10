import { sqliteTable, text, index } from "drizzle-orm/sqlite-core";
import { stampColumns } from "./stamps.ts";

// APPEND-ONLY (enforced by the audit_no_update/audit_no_delete triggers), so `modified` and `modified_by`
// keep the values of the insert. Written ONLY by db/audit-writer.ts
//. `run_id` is a loose reference by convention, NOT a Drizzle FK: keeping
// it a plain column means this file never imports schema/runs, so the boundary law
// "only executor touches runs schema" stays intact. audit-writer is the sole
// writer and only ever records valid run ids; run rows are never physically erased —
// "deleting" a planned/failed run (Executor.deleteRun) only sets runs.deleted, so every
// run_id here stays resolvable and the `run.deleted` entry records the soft delete.
export const audit = sqliteTable("audit", {
  id: text("id").primaryKey(),                                     // "aud_" + ulid
  action: text("action").notNull(),                               // dot-namespaced action name
  targetKind: text("target_kind"),
  targetId: text("target_id"),
  runId: text("run_id"),
  detailJson: text("detail_json", { mode: "json" }),
  // `owner` is who acted: an operator id, or SYSTEM_ACTOR (kernel/actor.ts).
  ...stampColumns(),
}, (t) => [
  index("audit_creation_ix").on(t.creation),
  index("audit_target_ix").on(t.targetKind, t.targetId),
]);
