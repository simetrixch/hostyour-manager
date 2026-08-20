import { ulid } from "ulid";
import type { Db } from "./client.ts";
import { audit } from "./schema/audit.ts";
import type { TargetKind } from "../../shared/enums.ts";

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
      id: `aud_${ulid()}`,
      actor: entry.actor,
      action: entry.action,
      targetKind: entry.targetKind ?? null,
      targetId: entry.targetId ?? null,
      runId: entry.runId ?? null,
      detailJson: entry.detail ?? null,
    })
    .run();
}
