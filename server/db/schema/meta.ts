import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { stampColumns } from "./stamps.ts";

// Small KV for instance state: schema markers, keystore.mode ('plaintext' while the keystore is unhardened),
// the session key, instance id. Written by the migrator + keystore/boot. NOT domain data.
export const meta = sqliteTable("meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  ...stampColumns(),
});
