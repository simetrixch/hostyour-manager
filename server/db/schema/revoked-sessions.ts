import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

// Revoked session tokens (jti) kept until their absolute lifetime expires.
// Written and pruned by SessionCodec (domains/access/session.ts).
export const revokedSessions = sqliteTable("revoked_sessions", {
  jti: text("jti").primaryKey(),
  expiresAt: integer("expires_at").notNull(),
});
