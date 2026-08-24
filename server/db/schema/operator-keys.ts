import { sqliteTable, text, integer, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

const now = sql`(unixepoch('subsec') * 1000)`;

// A HUMAN operator's own SSH public key, held so the platform can place it on machines and take it
// off again. Written only by domains/inventory/operator-keys.ts.
//
// WHY THIS IS NOT A CREDENTIAL ROW. The credential store (server/security/store.ts) is an
// ENCRYPTING secret store: every row carries an encrypted blob, seal/open/rotate exist to keep a
// value nobody may read, and the audit trail is about uses of that value. An operator's public key
// has no secret half at all — this manager never holds the private one — so a row there would
// carry a blob to encrypt that is not a secret. The second reason is the one that decides it: a
// credential of kind `ssh_key` is looked up BY SERVER, newest wins (server/executor/context.ts
// getSsh, and the adopt run's install-key), so a human key filed against a server would become the
// identity this manager tries to log in with — a different key, the same lookup.
//
// NO LINK TO `operators`. That table is an IdP identity written at first OIDC login; a key is
// normally added for someone who has not signed in yet, and often by somebody else. The `label` is
// the operator's own free choice of name and is the string the key is placed and removed under on
// every host — it is part of the comment written into authorized_keys, which is why its charset is
// restricted (shared/operator-keys.ts).
export const operatorKeys = sqliteTable("operator_keys", {
  id: text("id").primaryKey(),                                     // "opk_" + ulid
  label: text("label").notNull(),                                  // [a-z0-9-]; the marker on the host carries it
  publicKey: text("public_key").notNull(),                         // "<type> <base64>", the pasted comment dropped
  type: text("type").notNull(),                                    // "ssh-ed25519", "ssh-rsa", …
  fingerprint: text("fingerprint").notNull(),                      // SHA256:… (== ssh-keygen -lf)
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(now),
  createdBy: text("created_by").notNull(),                         // the operator who added it (audit actor)
}, (t) => [
  // The label is the identity on every host: one line per label per machine, so two rows sharing a
  // label would place two keys the removal could not tell apart.
  uniqueIndex("operator_keys_label_uq").on(t.label),
  // The same key added twice under two labels would put two lines carrying the same blob on every
  // host, and removing one would leave the other still granting access.
  uniqueIndex("operator_keys_fingerprint_uq").on(t.fingerprint),
]);
