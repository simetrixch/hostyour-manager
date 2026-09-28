import type { BackupState, BackupTrigger, Stage } from "./enums.ts";

/** GET /api/consumers/:appId/backups and GET /api/tenants/:id/backups — one generation of the unit's
 *  backup on the Storage Box, as the book of backups records it, newest first. Only an `ok` one can
 *  be restored. */
export interface UnitBackupView {
  generation: string;
  trigger: BackupTrigger;
  state: BackupState;
  takenAt: number;
  finishedAt: number | null;
  detail: string | null;
}

/** GET /api/backups/latest — each unit's most recent generation that is not pruned, so the unit pages
 *  can say when it was last backed up. `wired` is false on a manager without a Storage Box, where no
 *  backup can be taken at all. */
export interface LatestBackupsView {
  wired: boolean;
  latest: (UnitBackupView & { kind: "tenant" | "consumer"; unit: string; stage: Stage })[];
}
