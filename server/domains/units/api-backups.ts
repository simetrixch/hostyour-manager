// The generations of a unit's backup, read off the book of backups — what the Restore dialog offers.
import type { Hono } from "hono";
import type { AppEnv } from "../../http/app-env.ts";
import type { Db } from "../../db/client.ts";
import { listBackups, type UnitBackup } from "../../db/unit-backups.ts";
import type { UnitBackupView } from "../../../shared/api-types-backups.ts";
import { loadAppCluster, loadTenantCluster } from "./lifecycle.ts";

export interface BackupApiDeps {
  db: Db;
}

const view = (b: UnitBackup): UnitBackupView => ({
  generation: b.generation,
  trigger: b.trigger,
  state: b.state,
  takenAt: b.takenAt.getTime(),
  finishedAt: b.finishedAt?.getTime() ?? null,
  detail: b.detail,
});

export function registerBackupRoutes(app: Hono<AppEnv>, deps: BackupApiDeps): void {
  const { db } = deps;
  app.get("/api/consumers/:appId/backups", (c) => {
    const ac = loadAppCluster(db, c.req.param("appId"));
    return c.json(listBackups(db, { kind: "consumer", unit: ac.name, stage: ac.stage }).map(view));
  });
  app.get("/api/tenants/:id/backups", (c) => {
    const tc = loadTenantCluster(db, c.req.param("id"));
    return c.json(listBackups(db, { kind: "tenant", unit: tc.guid, stage: tc.stage }).map(view));
  });
}
