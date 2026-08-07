import { eq } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { operators } from "../../db/schema/operators.ts";
import { writeAudit } from "../../db/audit-writer.ts";
import { opId } from "../../kernel/ids.ts";

/**
 * Map an OIDC identity to a local operator. Keyed on the stable IdP subject.
 * Only the Access domain writes operators (dep-cruiser only-access-writes-operators). Group
 * membership is NOT stored — it is re-read from the IdP into each session.
 */
export function upsertOperator(db: Db, identity: { subject: string; email?: string }): string {
  const existing = db.select().from(operators).where(eq(operators.subject, identity.subject)).get();
  if (existing) {
    if (identity.email !== undefined && identity.email !== existing.email) {
      db.update(operators).set({ email: identity.email }).where(eq(operators.id, existing.id)).run();
    }
    return existing.id;
  }
  const local = identity.email?.split("@")[0]?.trim();
  const base = local && local.length > 0 ? local : identity.subject;
  const clash = db.select({ id: operators.id }).from(operators).where(eq(operators.username, base)).get();
  const id = opId();
  const username = clash ? `${base}-${id.slice(-6)}` : base;
  db.insert(operators)
    .values({ id, subject: identity.subject, email: identity.email ?? null, username, displayName: base })
    .run();
  writeAudit(db, { actor: id, action: "operator.upserted", detail: { subject: identity.subject } });
  return id;
}
