import { describe, it, expect, afterEach } from "vitest";
import { Hono } from "hono";
import { openDb, type DbHandle } from "../../db/client.ts";
import { servers, clusters, apps, tenants } from "../../db/schema/inventory.ts";
import type { AppEnv } from "../../http/app-env.ts";
import { recordBackupFinished, recordBackupStarted } from "../../db/unit-backups.ts";
import type { UnitBackupView } from "../../../shared/api-types-backups.ts";
import { registerBackupRoutes } from "./api-backups.ts";

// The Restore dialog's source: the generations of ONE unit, by its own kind, name and stage.

describe("GET the generations of a unit's backup", () => {
  let h: DbHandle;
  afterEach(() => h.sqlite.close());

  function app(): Hono<AppEnv> {
    h = openDb(":memory:");
    h.db.insert(servers).values({ id: "srv_1", name: "m1", host: "1.2.3.4", sshUser: "root", role: "master", status: "healthy" }).run();
    h.db.insert(clusters).values({ id: "cls_1", serverId: "srv_1", stage: "prod", domain: "s1.example", name: "s1", status: "active" }).run();
    h.db.insert(apps).values({ id: "app_1", clusterId: "cls_1", name: "acme", stage: "prod", host: "acme", repoUrl: "https://github.com/x/acme.git", chartPath: "deploy/chart", provenance: "manager", status: "offboarded" }).run();
    h.db.insert(tenants).values({ id: "tnt_1", clusterId: "cls_1", guid: "zsjs023ctne0", subdomain: "acme", stage: "prod", members: ["auth"], identityProvider: "auth", status: "active" }).run();
    const g = { kind: "consumer" as const, unit: "acme", stage: "prod" as const, generation: "20260928T030000Z" };
    recordBackupStarted(h.db, { ...g, folder: "master.example/prod/consumers/acme/20260928T030000Z", trigger: "nightly", runId: null });
    recordBackupFinished(h.db, g, { state: "ok" });
    const a = new Hono<AppEnv>();
    registerBackupRoutes(a, { db: h.db });
    return a;
  }

  it("answers an offboarded consumer's generations, and a tenant with none an empty list", async () => {
    const a = app();
    const consumer = (await (await a.request("/api/consumers/app_1/backups")).json()) as UnitBackupView[];
    expect(consumer).toEqual([{ generation: "20260928T030000Z", trigger: "nightly", state: "ok", takenAt: expect.any(Number), finishedAt: expect.any(Number), detail: null }]);
    expect(await (await a.request("/api/tenants/tnt_1/backups")).json()).toEqual([]);
  });
});
