import { monotonicFactory } from "ulid";
import type { Db } from "./client.ts";
import { audit } from "./schema/audit.ts";
import type { TargetKind } from "../../shared/enums.ts";

/**
 * The audit id is what orders the trail, so it must be strictly increasing per write.
 *
 * A plain `ulid()` is not. Its first 10 characters encode the millisecond and the remaining 16 are
 * fresh randomness on every call, so two rows written inside one millisecond sort by a coin toss —
 * measured at 50% inversion over 196,604 same-millisecond pairs. `ts` has the same millisecond
 * resolution and cannot break that tie either, and the table carries no ordinal column. An operator
 * asking `SELECT ... FROM audit WHERE action = '...' ORDER BY id` would then be shown two events in
 * an order that is not the order they happened in, with nothing on the row saying so.
 *
 * `monotonicFactory()` keeps the millisecond prefix and increments the random part instead of
 * redrawing it whenever the clock has not moved, so ids from one factory rise with every call.
 * The factory is created once per process because that is the scope the guarantee has: this
 * manager is the only process writing this SQLite file.
 */
const auditUlid = monotonicFactory();

export interface AuditEntry {
  actor: string; // operator id, or "system" (resume-on-boot)
  action: string; // dot-namespaced action name
  targetKind?: TargetKind;
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
      id: `aud_${auditUlid()}`,
      actor: entry.actor,
      action: entry.action,
      targetKind: entry.targetKind ?? null,
      targetId: entry.targetId ?? null,
      runId: entry.runId ?? null,
      detailJson: entry.detail ?? null,
    })
    .run();
}
