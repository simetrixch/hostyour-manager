import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type DbHandle } from "./client.ts";
import { writeAudit } from "./audit-writer.ts";
import { wipeManagerDb, rehearseManagerDbWipe, countLiveRuns, backupManagerDb, KEPT_TABLES } from "./reset.ts";

// Populate a representative slice of the cluster state — one row down each FK chain — so the wipe's
// order + the KEEP set are both exercised.
function seedClusters(db: DbHandle): void {
  const s = db.sqlite;
  s.prepare("INSERT INTO servers (id, name, host, ssh_user, role, status) VALUES ('srv_s','s1','5.6.7.8','root','slave','ready')").run();
  s.prepare("INSERT INTO clusters (id, server_id, stage, domain, status) VALUES ('cl_s','srv_s','prod','s1.example.com','active')").run();
  s.prepare("INSERT INTO credentials (id, kind, label, server_id, encrypted_blob, fingerprint) VALUES ('cred_s','ssh_key','k','srv_s','plain:v0:AA==','fp')").run();
  s.prepare("INSERT INTO runs (id, kind, target_kind, target_id, params_json, plan_json, status, started_by) VALUES ('run_1','deploy-slave','server','srv_s','{}','{}','succeeded','op_system')").run();
  s.prepare("INSERT INTO steps (id, run_id, ordinal, name, title, status) VALUES ('st_1','run_1',0,'x','X','ok')").run();
  s.prepare("INSERT INTO events (id, run_id, stream, seq, text) VALUES ('ev_1','run_1','stdout',0,'hi')").run();
  s.prepare("INSERT INTO run_locks (resource, key, run_id) VALUES ('server','s1','run_1')").run();
  s.prepare("INSERT INTO meta (key, value) VALUES ('keystore.mode','plaintext')").run();
  writeAudit(db.db, { actor: "op_system", action: "credential.created", targetKind: "credential", targetId: "cred_s" });
}

// A tenant on the seeded cluster; `withApp` adds the tenant_apps row hanging off it. The two rows sit
// on different FK edges — tenants RESTRICTs clusters, tenant_apps RESTRICTs tenants — so each one
// stops the wipe at a different DELETE and they are seeded separately.
function seedTenant(db: DbHandle, withApp: boolean): void {
  const s = db.sqlite;
  s.prepare("INSERT INTO tenants (id, cluster_id, guid, subdomain, stage, identity_provider, members) VALUES ('tnt_s','cl_s','zsjs023ctne0','acme.example.com','prod','auth','[\"auth\",\"jobs\",\"report\"]')").run();
  if (withApp) s.prepare("INSERT INTO tenant_apps (id, tenant_id, name) VALUES ('tna_s','tnt_s','web')").run();
}

const rowCount = (db: DbHandle, table: string): number =>
  (db.sqlite.prepare(`SELECT count(*) AS c FROM ${table}`).get() as { c: number }).c;

const tableNames = (db: DbHandle): string[] =>
  (db.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name);

describe("manager DB reset (db/reset.ts)", () => {
  const handles: DbHandle[] = [];
  const dirs: string[] = [];
  function make(): DbHandle {
    const dir = mkdtempSync(join(tmpdir(), "mgr-reset-"));
    dirs.push(dir);
    const db = openDb(join(dir, "manager.db"));
    handles.push(db);
    return db;
  }
  afterEach(() => {
    for (const h of handles.splice(0)) h.sqlite.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("wipes the cluster state, KEEPS operators/meta, leaves FKs intact", () => {
    const db = make();
    seedClusters(db);

    const rows = wipeManagerDb(db.sqlite);
    // every seeded table reported a deletion
    for (const t of ["servers", "clusters", "credentials", "runs", "steps", "events", "run_locks", "audit"]) {
      expect(rows[t]).toBeGreaterThanOrEqual(1);
    }
    // cluster state gone
    for (const t of ["servers", "clusters", "credentials", "runs", "steps", "events", "run_locks", "audit"]) {
      expect(rowCount(db, t)).toBe(0);
    }
    // KEEP set survives: op_system + op_emergency (seeded by the migrator), the meta row (keystore.mode),
    // and the migrator's ledger — an emptied one replays the baseline against live tables on the next boot.
    expect(rowCount(db, "operators")).toBe(2);
    expect(db.sqlite.prepare("SELECT value FROM meta WHERE key='keystore.mode'").get()).toEqual({ value: "plaintext" });
    expect(rowCount(db, "__drizzle_migrations")).toBeGreaterThanOrEqual(1);
    // FK integrity holds after the wipe
    expect((db.sqlite.pragma("foreign_key_check") as unknown[]).length).toBe(0);
  });

  it("wipes a cluster that carries a tenant (tenants RESTRICTs clusters)", () => {
    const db = make();
    seedClusters(db);
    seedTenant(db, false);

    const rows = wipeManagerDb(db.sqlite);
    expect(rows["tenants"]).toBe(1);
    expect(rowCount(db, "tenants")).toBe(0);
    expect(rowCount(db, "clusters")).toBe(0);
    expect((db.sqlite.pragma("foreign_key_check") as unknown[]).length).toBe(0);
  });

  it("wipes a tenant that carries a tenant app (tenant_apps RESTRICTs tenants)", () => {
    const db = make();
    seedClusters(db);
    seedTenant(db, true);

    const rows = wipeManagerDb(db.sqlite);
    expect(rows["tenant_apps"]).toBe(1);
    expect(rowCount(db, "tenant_apps")).toBe(0);
    expect(rowCount(db, "tenants")).toBe(0);
    expect(rowCount(db, "clusters")).toBe(0);
    expect((db.sqlite.pragma("foreign_key_check") as unknown[]).length).toBe(0);
  });

  // The census: a hand-ordered wipe list beside a schema that keeps growing is how tenants/tenant_apps
  // went missing in the first place. Every table the migrations actually create must be named by
  // WIPE_ORDER or by KEPT_TABLES — the wipe's own return value IS the wipe list, one entry per table
  // it deleted from, so nothing here restates the order by hand.
  it("wipes or keeps EVERY table the migrations create", () => {
    const db = make();
    const present = tableNames(db);
    expect(present).toContain("tenants"); // the census has something to check
    expect(present.length).toBeGreaterThanOrEqual(13);

    const accounted = new Set<string>([...Object.keys(wipeManagerDb(db.sqlite)), ...KEPT_TABLES]);
    const unaccounted = present.filter((t) => !accounted.has(t));
    expect(unaccounted, `tables in neither the wipe list nor KEPT_TABLES: ${unaccounted.join(", ")}`).toEqual([]);
    // and neither list names a table that no longer exists
    const gone = [...accounted].filter((t) => !present.includes(t));
    expect(gone, `tables reset.ts names but the migrations do not create: ${gone.join(", ")}`).toEqual([]);
  });

  it("recreates the append-only DELETE triggers (events + audit stay append-only after a wipe)", () => {
    const db = make();
    seedClusters(db);
    wipeManagerDb(db.sqlite);

    const triggers = db.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name IN ('events_no_delete','audit_no_delete')")
      .all() as { name: string }[];
    expect(triggers.map((t) => t.name).sort()).toEqual(["audit_no_delete", "events_no_delete"]);
    // and they actually bite again
    db.sqlite.prepare("INSERT INTO runs (id, kind, target_kind, target_id, params_json, plan_json, status, started_by) VALUES ('run_2','noop','self','c','{}','{}','succeeded','op_system')").run();
    db.sqlite.prepare("INSERT INTO events (id, run_id, stream, seq, text) VALUES ('ev_2','run_2','stdout',0,'x')").run();
    expect(() => db.sqlite.prepare("DELETE FROM events").run()).toThrow(/append-only/);
  });

  // A table with a RESTRICTing reference to servers and a row in it is exactly the shape that makes
  // the wipe throw after the install branches are already deleted: WIPE_ORDER not naming it means
  // DELETE FROM servers hits the child row.
  function seedUnnamedChildTable(db: DbHandle): void {
    db.sqlite.exec("CREATE TABLE stragglers (id TEXT PRIMARY KEY, server_id TEXT NOT NULL REFERENCES servers(id))");
    db.sqlite.prepare("INSERT INTO stragglers (id, server_id) VALUES ('str_1','srv_s')").run();
  }

  it("the rehearsal deletes nothing and leaves the triggers standing", () => {
    const db = make();
    seedClusters(db);
    seedTenant(db, true);

    rehearseManagerDbWipe(db.sqlite);

    for (const t of ["servers", "clusters", "credentials", "runs", "steps", "events", "run_locks", "audit", "tenants", "tenant_apps"]) {
      expect(rowCount(db, t), `${t} lost rows to the rehearsal`).toBeGreaterThanOrEqual(1);
    }
    // The rehearsal drops both append-only triggers and recreates them inside its transaction; the
    // rollback has to put back the originals, not leave the table deletable.
    expect(() => db.sqlite.prepare("DELETE FROM events").run()).toThrow(/append-only/);
    expect(() => db.sqlite.prepare("DELETE FROM audit").run()).toThrow(/append-only/);
    // and it left no transaction open for the real wipe that follows it
    expect(db.sqlite.inTransaction).toBe(false);
    expect(Object.keys(wipeManagerDb(db.sqlite)).length).toBeGreaterThan(0);
  });

  it("the rehearsal throws what the wipe would throw, and the wipe then throws the same", () => {
    const db = make();
    seedClusters(db);
    seedUnnamedChildTable(db);

    expect(() => rehearseManagerDbWipe(db.sqlite)).toThrow(/FOREIGN KEY/i);
    // the failed rehearsal is still a rollback: everything is where it was
    expect(rowCount(db, "servers")).toBe(1);
    expect(rowCount(db, "stragglers")).toBe(1);
    expect(db.sqlite.inTransaction).toBe(false);
    // the rehearsal predicted the real thing
    expect(() => wipeManagerDb(db.sqlite)).toThrow(/FOREIGN KEY/i);
    expect(rowCount(db, "servers")).toBe(1);
  });

  it("countLiveRuns counts only planning/approved/running", () => {
    const db = make();
    const ins = (id: string, status: string) =>
      db.sqlite.prepare(`INSERT INTO runs (id, kind, target_kind, target_id, params_json, plan_json, status, started_by) VALUES ('${id}','noop','self','c','{}','{}','${status}','op_system')`).run();
    ins("r_plan", "planned"); // parked — not live
    ins("r_done", "succeeded");
    expect(countLiveRuns(db.sqlite)).toBe(0);
    ins("r_run", "running");
    ins("r_appr", "approved");
    expect(countLiveRuns(db.sqlite)).toBe(2);
  });

  it("backupManagerDb snapshots the DB and prunes to the last 5", () => {
    const db = make();
    seedClusters(db);
    const dir = dirs[dirs.length - 1] as string;
    const first = backupManagerDb(db.sqlite, dir);
    expect(readdirSync(join(dir, "backups")).filter((f) => f.startsWith("pre-reset-"))).toHaveLength(1);
    // the backup is a real file with content
    expect(first).toContain("pre-reset-");
    // simulate 6 older backups → prune keeps 5
    for (let i = 0; i < 6; i++) writeFileSync(join(dir, "backups", `pre-reset-2020-01-0${i}.db`), "x");
    backupManagerDb(db.sqlite, dir);
    expect(readdirSync(join(dir, "backups")).filter((f) => f.startsWith("pre-reset-")).length).toBe(5);
  });
});
