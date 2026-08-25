import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type DbHandle } from "./client.ts";
import { servers, clusters, tenants, tenantApps } from "./schema/inventory.ts";
import { tenantId, tenantAppId } from "../kernel/ids.ts";

// Exercises the tenants / tenant_apps tables (migration applied by openDb) end to end:
// the schema imports, the FK chain server -> cluster -> tenant -> tenant_app, the seedUsers/suspended
// booleans, the defaults, and the two unique indexes. Mirrors client.test.ts's temp-file db setup.
//
// Lives in server/db/ (NOT server/db/schema/) on purpose: drizzle-kit's schema glob is
// ./server/db/schema/*.ts, so a *.test.ts under schema/ pulls vitest into drizzle-kit generate and
// poisons migration generation. Keeping the test one directory up keeps the glob pure code-only.
describe("inventory tenants + tenant_apps", () => {
  const handles: DbHandle[] = [];
  const dirs: string[] = [];
  function fresh(): DbHandle {
    const dir = mkdtempSync(join(tmpdir(), "mgr-tnt-"));
    dirs.push(dir);
    const h = openDb(join(dir, "manager.db"));
    handles.push(h);
    return h;
  }
  afterEach(() => {
    for (const h of handles.splice(0)) h.sqlite.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function seedCluster(db: DbHandle): void {
    db.db.insert(servers).values({ id: "srv_1", name: "m1", host: "1.2.3.4", sshUser: "root", role: "master", status: "healthy" }).run();
    db.db.insert(clusters).values({ id: "cls_1", serverId: "srv_1", stage: "prod", domain: "s1.example", status: "active" }).run();
  }

  it("inserts a tenant + a tenant_app row and reads them back (booleans, defaults, ULID ids)", () => {
    const db = fresh();
    seedCluster(db);

    const tId = tenantId();
    const taId = tenantAppId();
    expect(tId).toMatch(/^tnt_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(taId).toMatch(/^tna_[0-9A-HJKMNP-TV-Z]{26}$/);

    db.db.insert(tenants).values({
      id: tId,
      clusterId: "cls_1",
      guid: "zsjs023ctne0",
      subdomain: "simetrix.example",
      stage: "prod", members: ["auth", "jobs", "report"], identityProvider: "auth",
      seedUsers: true,
      lastRunId: "run_1",
    }).run();
    db.db.insert(tenantApps).values({ id: taId, tenantId: tId, name: "web" }).run();

    const [t] = db.db.select().from(tenants).where(eq(tenants.id, tId)).all();
    expect(t).toBeDefined();
    expect(t?.guid).toBe("zsjs023ctne0");
    // Explicit booleans round-trip as booleans (integer mode:"boolean").
    expect(t?.seedUsers).toBe(true);
    // Default: suspended is false; provenance/status take their defaults.
    expect(t?.suspended).toBe(false);
    expect(t?.provenance).toBe("manager");
    expect(t?.status).toBe("active");
    // Nullable columns default to null; timestamps are populated by the DB default.
    expect(t?.owner).toBeNull();
    expect(t?.createdAt).toBeInstanceOf(Date);
    expect(t?.updatedAt).toBeInstanceOf(Date);

    const apps = db.db.select().from(tenantApps).where(eq(tenantApps.tenantId, tId)).all();
    expect(apps.map((a) => a.name)).toEqual(["web"]);
    expect(apps[0]?.status).toBe("active");
  });

  it("enforces UNIQUE(clusterId, guid) on tenants and UNIQUE(tenantId, name) on tenant_apps", () => {
    const db = fresh();
    seedCluster(db);
    const base = { clusterId: "cls_1", guid: "e2e8ymj86dk8", subdomain: "acme.example", stage: "prod" as const, members: ["auth", "jobs", "report"], identityProvider: "auth" };
    const first = tenantId();
    db.db.insert(tenants).values({ id: first, ...base }).run();
    // Same (clusterId, guid) -> unique-index violation.
    expect(() => db.db.insert(tenants).values({ id: tenantId(), ...base }).run()).toThrow(/UNIQUE/i);

    const a1 = tenantAppId();
    db.db.insert(tenantApps).values({ id: a1, tenantId: first, name: "web" }).run();
    // Same (tenantId, name) -> unique-index violation.
    expect(() => db.db.insert(tenantApps).values({ id: tenantAppId(), tenantId: first, name: "web" }).run()).toThrow(/UNIQUE/i);
  });

  it("enforces the tenant_apps -> tenants foreign key (restrict)", () => {
    const db = fresh();
    seedCluster(db);
    expect(() => db.db.insert(tenantApps).values({ id: tenantAppId(), tenantId: "tnt_missing", name: "web" }).run()).toThrow(/FOREIGN KEY/i);
  });
});

// apps.stage carries the upsert key, and the CREATE TABLE is the only place its NOT NULL actually
// holds — the drizzle declaration narrows the TypeScript type and nothing more, so the insert is made
// in raw SQL here, the shape a hand-fixed database takes. What a null would cost: SQLite treats NULLs
// in a unique index as DISTINCT, so such a row sits outside apps_cluster_name_stage_uq entirely, while
// the table's one writer (upsertAppRow, domains/units/onboard-steps.ts) looks the existing row up
// with `stage = ?`, which never matches a NULL — every run would insert a second row beside the first
// instead of updating it.
describe("apps.stage", () => {
  const handles: DbHandle[] = [];
  const dirs: string[] = [];
  function fresh(): DbHandle {
    const dir = mkdtempSync(join(tmpdir(), "mgr-app-"));
    dirs.push(dir);
    const h = openDb(join(dir, "manager.db"));
    handles.push(h);
    return h;
  }
  afterEach(() => {
    for (const h of handles.splice(0)) h.sqlite.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function seedCluster(db: DbHandle): void {
    db.db.insert(servers).values({ id: "srv_1", name: "m1", host: "1.2.3.4", sshUser: "root", role: "master", status: "healthy" }).run();
    db.db.insert(clusters).values({ id: "cls_1", serverId: "srv_1", stage: "prod", domain: "s1.example", status: "active" }).run();
  }

  const insert = (db: DbHandle, id: string, stage: string | null): void => {
    db.sqlite.prepare("INSERT INTO apps (id, cluster_id, name, stage) VALUES (?, 'cls_1', 'acme', ?)").run(id, stage);
  };

  it("refuses a row that names no stage", () => {
    const db = fresh();
    seedCluster(db);
    expect(() => insert(db, "app_1", null)).toThrow(/NOT NULL/i);
    expect(() => db.sqlite.prepare("INSERT INTO apps (id, cluster_id, name) VALUES ('app_2','cls_1','acme')").run()).toThrow(/NOT NULL/i);
  });

  it("holds UNIQUE(clusterId, name, stage) — the upsert key finds one row or none", () => {
    const db = fresh();
    seedCluster(db);
    insert(db, "app_1", "prod");
    expect(() => insert(db, "app_2", "prod")).toThrow(/UNIQUE/i);
  });

  // The provenance DEFAULT as the DATABASE holds it, on both tables that carry it. Inserted through
  // raw SQL naming no provenance, because drizzle fills a static .default() into the INSERT it
  // builds — so a row written through db.insert() proves the TypeScript literal and never reaches
  // the DDL. Only a statement that omits the column can say what the migration actually wrote, and
  // that is the value every row created by anything other than this code gets.
  it("defaults provenance to the product's name in the DDL, on apps and on tenants", () => {
    const db = fresh();
    seedCluster(db);
    db.sqlite.prepare("INSERT INTO apps (id, cluster_id, name, stage) VALUES ('app_d','cls_1','acme','prod')").run();
    expect(db.sqlite.prepare("SELECT provenance FROM apps WHERE id='app_d'").get()).toEqual({ provenance: "manager" });

    db.sqlite
      .prepare(
        "INSERT INTO tenants (id, cluster_id, guid, subdomain, stage, identity_provider, members) " +
          "VALUES ('tnt_d','cls_1','zsjs023ctne0','acme','prod','auth','[\"auth\"]')",
      )
      .run();
    expect(db.sqlite.prepare("SELECT provenance FROM tenants WHERE id='tnt_d'").get()).toEqual({ provenance: "manager" });
  });
});

// The one-master invariant as an EXPRESSION index. Its whole point is that it is indexed on the
// predicate rather than on the role column: an index on the column is unique per distinct VALUE, so
// "master" and "master+slave" would sit side by side and the platform would carry two management
// planes. drizzle-kit cannot generate the expression correctly (it splits it on the comma), so the
// baseline SQL is hand-corrected and this suite is what catches a regenerate that undoes the fix.
describe("servers_one_master_uq", () => {
  const handles: DbHandle[] = [];
  const dirs: string[] = [];
  function fresh(): DbHandle {
    const dir = mkdtempSync(join(tmpdir(), "mgr-mst-"));
    dirs.push(dir);
    const h = openDb(join(dir, "manager.db"));
    handles.push(h);
    return h;
  }
  afterEach(() => {
    for (const h of handles.splice(0)) h.sqlite.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  const add = (db: DbHandle, id: string, role: "master" | "slave" | "master+slave"): void => {
    db.db.insert(servers).values({ id, name: id, host: `${id}.example`, sshUser: "root", role, status: "healthy" }).run();
  };

  it("refuses a master+slave beside a master — at most ONE server carries the master part", () => {
    const db = fresh();
    add(db, "srv_m", "master");
    expect(() => add(db, "srv_ms", "master+slave")).toThrow(/UNIQUE/i);
  });

  it("refuses a second master, and a second master+slave", () => {
    const db = fresh();
    add(db, "srv_m", "master");
    expect(() => add(db, "srv_m2", "master")).toThrow(/UNIQUE/i);
    const db2 = fresh();
    add(db2, "srv_ms", "master+slave");
    expect(() => add(db2, "srv_ms2", "master+slave")).toThrow(/UNIQUE/i);
  });

  it("admits a master and TWO slaves — the slaves are outside the index entirely", () => {
    const db = fresh();
    add(db, "srv_m", "master");
    add(db, "srv_s1", "slave");
    add(db, "srv_s2", "slave");
    expect(db.db.select().from(servers).all()).toHaveLength(3);
  });
});
