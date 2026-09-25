import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { CREDENTIAL_KIND, CREDENTIAL_PURPOSE, CREDENTIAL_SUBJECT } from "../../../shared/enums.ts";

const now = sql`(unixepoch('subsec') * 1000)`;

// Written by server/security/store.ts ONLY. encrypted_blob is self-describing by prefix — a
// plaintext pass-through, an AES-256-GCM envelope under the local data key, or a reference to the
// value held in Vault — so one column serves every keystore mode and a store that changes mode still
// reads the rows written under the previous one.
//
// EVERY ROW HAS AN OWNER AND A PURPOSE (hostyour-manager#225): `subject_kind` + `subject_id` say
// whose the credential is — a server, an owner, a unit — and `purpose` what it is for, a
// closed vocabulary (shared/enums.ts CREDENTIAL_PURPOSE). A reader asks by subject and purpose,
// never by parsing a label: the label is what a person reads. The owner's two credentials
// (its packages reader, its repository PAT) are rows here and nothing else — the table of ids that
// once held them (organisation_identities, #219) went with this column pair. The subject is no
// foreign key: a server's row is taken with the server (inventory), a unit's with the unit, and the
// table stays importable by the store alone.
export const credentials = sqliteTable("credentials", {
  id: text("id").primaryKey(),                                     // "cred_" + ulid
  kind: text("kind", { enum: CREDENTIAL_KIND }).notNull(),
  label: text("label").notNull(),
  subjectKind: text("subject_kind", { enum: CREDENTIAL_SUBJECT }).notNull(),
  subjectId: text("subject_id").notNull(),                         // the server's id, the owner's login, the unit's name
  purpose: text("purpose", { enum: CREDENTIAL_PURPOSE }).notNull(),
  encryptedBlob: text("encrypted_blob").notNull(),
  fingerprint: text("fingerprint").notNull(),                      // public, non-secret identifier
  publicKey: text("public_key"),                                   // OpenSSH public line for ssh_key; else NULL
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(now),
  lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
  rotatedAt: integer("rotated_at", { mode: "timestamp_ms" }),
  revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),      // soft-revoke; blob kept for audit
}, (t) => [
  index("credentials_subject_ix").on(t.subjectKind, t.subjectId),
  // Plain (NON-unique) lookup index. The fingerprint is a public CORRELATOR, not a key:
  // the same secret bytes legitimately appear on more than one row — a slave's stable
  // long-lived SA token re-sealed under a renamed label (which a global unique index over
  // the fingerprint would refuse), and a rotate() that keeps the superseded row.
  index("credentials_fingerprint_ix").on(t.fingerprint),
]);
