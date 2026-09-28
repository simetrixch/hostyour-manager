import { sqliteTable, text, integer, primaryKey } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { SECRET_WRITE_ACT } from "../../../shared/enums.ts";

const now = sql`(unixepoch('subsec') * 1000)`;

// THE BOOK OF SECRET WRITES: one row per key a run of this Manager wrote into a consumer's Vault
// entry, keyed by the entry and the key. The Manager writes that entry and never reads it
// (plugins/unit/server/adapters/vault/seeder-port.ts), so this book is the one place that can say
// which keys hold a value it put there: the key, the act, the run and the time, NEVER the value. A
// later write of the same key REWRITES the row. The removal of the entry (offboard, purge, an aborted
// onboarding) deletes its rows. Written and read through db/secret-writes.ts only.
//
// `run_id` is a loose reference by convention, NOT a Drizzle FK, for the reason schema/dns-writes.ts
// states: the boundary law "only the executor touches the runs schema" stays intact.
export const secretWrites = sqliteTable("secret_writes", {
  entry: text("entry").notNull(), // <stage>/consumer/<name>/app, the path below the KV mount
  key: text("key").notNull(),
  act: text("act", { enum: SECRET_WRITE_ACT }).notNull(),
  runId: text("run_id").notNull(),
  writtenAt: integer("written_at", { mode: "timestamp_ms" }).notNull().default(now),
}, (t) => [
  primaryKey({ columns: [t.entry, t.key] }),
]);
