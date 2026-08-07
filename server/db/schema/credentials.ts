import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { CREDENTIAL_KIND } from "../../../shared/enums.ts";
import { servers } from "./inventory.ts";

const now = sql`(unixepoch('subsec') * 1000)`;

// Written by server/security/store.ts ONLY. encrypted_blob is self-describing by prefix — a
// plaintext pass-through, an AES-256-GCM envelope under the local data key, or a reference to the
// value held in Vault — so one column serves every keystore mode and a store that changes mode still
// reads the rows written under the previous one.
export const credentials = sqliteTable("credentials", {
  id: text("id").primaryKey(),                                     // "cred_" + ulid
  kind: text("kind", { enum: CREDENTIAL_KIND }).notNull(),
  label: text("label").notNull(),
  serverId: text("server_id").references(() => servers.id, { onDelete: "restrict" }), // NULL for PATs etc.
  encryptedBlob: text("encrypted_blob").notNull(),
  fingerprint: text("fingerprint").notNull(),                      // public, non-secret identifier
  publicKey: text("public_key"),                                   // OpenSSH public line for ssh_key; else NULL
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(now),
  lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
  rotatedAt: integer("rotated_at", { mode: "timestamp_ms" }),
  revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),      // soft-revoke; blob kept for audit
}, (t) => [
  index("credentials_server_ix").on(t.serverId),
  // Plain (NON-unique) lookup index. The fingerprint is a public CORRELATOR, not a key:
  // the same secret bytes legitimately appear on more than one row — a slave's stable
  // long-lived SA token re-sealed under a renamed label (the create-mgmt incident:
  // the old global credentials_fingerprint_uq made the second seal die on UNIQUE), a
  // rotate() that keeps the superseded row, and the constant "bootstrap-password" marker
  // (inventory/write.ts) shared by every server with a stored adopt password.
  index("credentials_fingerprint_ix").on(t.fingerprint),
]);
