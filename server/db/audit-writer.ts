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
 * resolution and cannot break that tie either. An operator asking
 * `SELECT ... FROM audit WHERE action = '...' ORDER BY id` would then be shown two events in an
 * order that is not the order they happened in, with nothing on the row saying so.
 *
 * THE TABLE DOES CARRY AN ORDINAL, AND IT IS NOT THIS ID. `audit` is a plain rowid table
 * (db/migrations/0000_baseline.sql:39 — `id` is TEXT, not an INTEGER PRIMARY KEY alias), so SQLite
 * keeps its own insert counter for it and `audit_ts_ix` is keyed (ts, rowid); ORDER BY ts therefore
 * comes back in insertion order. `security/store.ts:262` reads an identically shaped table exactly
 * that way. What rowid does not do is TRAVEL: it is not selected onto the row a caller is handed,
 * so an operator typing ORDER BY id, a caller sorting rows it already holds, or an export cannot
 * reach it. That is what this factory is for, and it leaves the platform with two answers to one
 * question — hostyour-manager#43 is where that is decided.
 *
 * `monotonicFactory()` keeps the millisecond prefix and increments the random part instead of
 * redrawing it whenever the clock has not moved, so ids from one factory rise with every call.
 * The factory is created once per process, which is the scope of that guarantee. A SECOND process
 * writing this file would draw from its own: jobs/registry-reaper.ts:79 opens `config.dbFile` and
 * builds a CredentialStore on it, which writes `credential.used` rows. It reaches a different file
 * only because that job runs with an emptyDir DATA_DIR, which is a property of the deployment and
 * not something this repository holds.
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
