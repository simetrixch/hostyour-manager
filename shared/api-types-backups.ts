import type { BackupState, BackupTrigger } from "./enums.ts";

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
