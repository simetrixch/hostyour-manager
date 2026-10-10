import { sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { SECRET_WRITE_ACT } from "../../../shared/enums.ts";
import { stampColumns, deletionColumns } from "./stamps.ts";

// THE BOOK OF SECRET WRITES: one live row per key a run of this Manager wrote into a consumer's Vault
// entry, keyed by the entry and the key. The Manager writes that entry and never reads it
// (plugins/unit/server/adapters/vault/seeder-port.ts), so this book is the one place that can say
// which keys hold a value it put there: the key, the act, the run and the time, NEVER the value. A
// later write of the same key REWRITES the live row. The removal of the entry (offboard, purge, an
// aborted onboarding) marks its rows deleted, and the next write of a key adds a new live row.
// Written and read through db/secret-writes.ts only.
//
// `run_id` is a loose reference by convention, NOT a Drizzle FK, for the reason schema/dns-writes.ts
// states: the boundary law "only the executor touches the runs schema" stays intact.
export const secretWrites = sqliteTable("secret_writes", {
  id: text("id").primaryKey(),                                     // "secw_" + ulid
  entry: text("entry").notNull(), // <stage>/consumer/<name>/app, the path below the KV mount
  key: text("key").notNull(),
  act: text("act", { enum: SECRET_WRITE_ACT }).notNull(),
  runId: text("run_id").notNull(),
  ...stampColumns(),
  ...deletionColumns(),
}, (t) => [
  uniqueIndex("secret_writes_key_uq").on(t.entry, t.key).where(sql`deleted IS NULL`),
]);
