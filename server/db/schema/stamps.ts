// The fields every table of the Manager carries: when a row was written and changed, and by whom.
// They are spread into each table, so no writer names them: drizzle fills them on every insert and
// every update, `onConflictDoUpdate` included (`buildUpdateSet` adds each column with an
// `$onUpdateFn` that the update does not set). A raw SQL statement bypasses that and names them
// itself. The actor is the signed-in operator of the request, a run's starter while the run
// executes (executor.ts `fireExecute`), and SYSTEM_ACTOR for any other work.
import { integer, text } from "drizzle-orm/sqlite-core";
import { sql, type SQL } from "drizzle-orm";
import { runActor } from "../../kernel/actor.ts";

const now = sql`(unixepoch('subsec') * 1000)`;

/** `creation`, `modified`, `owner` and `modified_by`. On an insert `modified` equals `creation` and
 *  `modified_by` equals `owner`. */
export function stampColumns() {
  return {
    creation: integer("creation", { mode: "timestamp_ms" }).notNull().default(now),
    modified: integer("modified", { mode: "timestamp_ms" }).notNull().default(now).$onUpdateFn(() => now),
    owner: text("owner").notNull().$defaultFn(runActor),
    modifiedBy: text("modified_by").notNull().$onUpdateFn(runActor),
  };
}

/** `deleted` and `deleted_by`, on a table whose rows are deleted: a deleted row stays, and every read
 *  of the table skips it. */
export function deletionColumns() {
  return {
    deleted: integer("deleted", { mode: "timestamp_ms" }),
    deletedBy: text("deleted_by"),
  };
}

/** What an update sets to delete a row. `deleted` is read from the database clock, as `modified` is in
 *  the same statement, so the two are equal. */
export function deletion(): { deleted: SQL; deletedBy: string } {
  return { deleted: now, deletedBy: runActor() };
}
