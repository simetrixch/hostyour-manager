import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { stampColumns } from "./stamps.ts";

// Revoked session tokens (jti) kept until their absolute lifetime expires.
// Written and pruned by SessionCodec (domains/access/session.ts). An expired row is purged, not
// marked deleted: it records nothing once its token can no longer be presented.
export const revokedSessions = sqliteTable("revoked_sessions", {
  jti: text("jti").primaryKey(),
  expiresAt: integer("expires_at").notNull(),
  ...stampColumns(),
});
