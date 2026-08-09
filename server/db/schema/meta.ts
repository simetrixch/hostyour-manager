import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

const now = sql`(unixepoch('subsec') * 1000)`;

// Small KV for instance state: schema markers, keystore.mode ('plaintext' while the keystore is unhardened),
// the session key, instance id. Written by the migrator + keystore/boot. NOT domain data.
export const meta = sqliteTable("meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().default(now),
});
