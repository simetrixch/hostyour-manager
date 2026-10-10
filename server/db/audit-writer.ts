import type { Db } from "./client.ts";
import { audit } from "./schema/audit.ts";
import { newId } from "../kernel/ids.ts";

/**
 * The audit id is what orders the trail: `creation` has millisecond resolution, so an operator asking
 * `SELECT ... FROM audit WHERE action = '...' ORDER BY creation` sees two events written inside one
 * millisecond in an order that is not the order they happened in, with nothing on the row saying
 * so. `ORDER BY id` is exact instead, because kernel/ids.ts mints ids that rise with every write —
 * the platform's one answer for a tied timestamp, and the reason this file mints no id of its own.
 */

/** Who acted is not part of the entry: the stamp columns record the actor of the call chain
 *  (kernel/actor.ts runActor). A write on behalf of an operator outside a request, such as a login,
 *  runs inside runAsActor(that operator). */
export interface AuditEntry {
  action: string; // dot-namespaced action name
  targetKind?: string;
  targetId?: string;
  runId?: string;
  detail?: Record<string, unknown>;
}

/**
 * The single writer of the append-only `audit` table. The dependency-cruiser
 * rule `only-audit-writer` forbids any other module from importing schema/audit.
 */
export function writeAudit(db: Db, entry: AuditEntry): void {
  db.insert(audit)
    .values({
      id: newId("aud"),
      action: entry.action,
      targetKind: entry.targetKind ?? null,
      targetId: entry.targetId ?? null,
      runId: entry.runId ?? null,
      detailJson: entry.detail ?? null,
    })
    .run();
}
