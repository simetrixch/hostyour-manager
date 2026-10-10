import { sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { stampColumns } from "./stamps.ts";

// An operator is an IdP identity, never a local account: upsertOperator writes the row at the first
// OIDC login, keyed on the stable `subject`, and only domains/access may write here (dep-cruiser rule
// only-access-writes-operators). Group membership is deliberately not stored — every session re-reads
// it from the IdP. The baseline migration seeds op_system and op_emergency (username "emergency"),
// because runs.owner has an FK onto this table and a break-glass session with no operator row could
// not start a run at all.
export const operators = sqliteTable("operators", {
  id: text("id").primaryKey(),                                     // "op_" + ulid
  username: text("username").notNull(),
  displayName: text("display_name").notNull(),
  subject: text("subject"),                                        // the identity provider's OIDC `sub`
  email: text("email"),
  ...stampColumns(),
}, (t) => [
  uniqueIndex("operators_username_uq").on(t.username),
  uniqueIndex("operators_subject_uq").on(t.subject).where(sql`subject IS NOT NULL`),
]);
