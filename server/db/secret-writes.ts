import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "./client.ts";
import { secretWrites } from "./schema/secret-writes.ts";
import { deletion } from "./schema/stamps.ts";
import { newId } from "../kernel/ids.ts";
import type { SecretWriteAct, Stage } from "../../shared/enums.ts";

// The one writer and the one reader of the book of secret writes (schema/secret-writes.ts). It stands
// under server/db for the reason db/dns-writes.ts gives: its writers are run kinds of several files,
// and a table writer here is what every domain may reach.

/** One key of a consumer's Vault entry, as the book knows it: what the last write of this Manager did
 *  to it, by which run and when. Never the value. */
export interface SecretWrite {
  entry: string;
  key: string;
  act: SecretWriteAct;
  runId: string;
  writtenAt: Date;
}

/** The entry a consumer's application secrets live in, below the KV mount — the path the seeder
 *  writes (`<stage>/consumer/<name>/app`), and the name the book keys them by. */
export function consumerSecretEntry(stage: Stage, consumerName: string): string {
  return `${stage}/consumer/${consumerName}/app`;
}

/** The entry a tenant's Google translation settings live in, below the KV mount: the path the seeder
 *  writes, and the name the book keys it by. */
export function tenantGoogleTranslationEntry(stage: Stage, guid: string): string {
  return `${stage}/tenants/${guid}/google-translation`;
}

/** Enter the keys one write put into `entry`. A key already in the book is REWRITTEN: the act, the
 *  run and the time are the latest write's. */
export function recordSecretWrites(db: Db, write: { entry: string; keys: readonly string[]; act: SecretWriteAct; runId: string }): void {
  for (const key of write.keys) {
    const row = { act: write.act, runId: write.runId };
    db.insert(secretWrites)
      .values({ id: newId("secw"), entry: write.entry, key, ...row })
      .onConflictDoUpdate({ target: [secretWrites.entry, secretWrites.key], targetWhere: sql`deleted IS NULL`, set: row })
      .run();
  }
}

/** Every key the book carries for `entry`. */
export function listSecretWrites(db: Db, entry: string): SecretWrite[] {
  return db
    .select({ entry: secretWrites.entry, key: secretWrites.key, act: secretWrites.act, runId: secretWrites.runId, writtenAt: secretWrites.modified })
    .from(secretWrites)
    .where(liveEntry(entry))
    .all();
}

/** Take the entry out of the book, beside its deletion in Vault: its rows are marked deleted, and no
 *  read returns them. An entry the book never carried is the idempotent no-op, as the deletion of an
 *  absent entry is. */
export function forgetSecretEntry(db: Db, entry: string): void {
  db.update(secretWrites).set(deletion()).where(liveEntry(entry)).run();
}

const liveEntry = (entry: string) => and(eq(secretWrites.entry, entry), isNull(secretWrites.deleted));
