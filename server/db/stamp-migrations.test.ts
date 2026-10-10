import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { openDb, type DbHandle } from "./client.ts";

// The migrations that put the stamp columns (schema/stamps.ts) on the tables a release before them
// held: each test stands a database at the migration before one, writes the rows that release could
// write, and reads what the boot carried into the stamps.

const MIGRATIONS_DIR = fileURLToPath(new URL("./migrations", import.meta.url));

describe("the stamp migrations carry every row with the times and actors it recorded", () => {
  const handles: DbHandle[] = [];
  const dirs: string[] = [];
  afterEach(() => {
    for (const h of handles.splice(0)) h.sqlite.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /** A database file migrated up to the migration before `tag`, open for the rows of that release. */
  function standingBefore(tag: string): { file: string; standing: Database.Database } {
    const dir = mkdtempSync(join(tmpdir(), "mgr-db-"));
    dirs.push(dir);
    const folder = join(dir, "before");
    mkdirSync(join(folder, "meta"), { recursive: true });
    const journal = JSON.parse(readFileSync(join(MIGRATIONS_DIR, "meta/_journal.json"), "utf8")) as { entries: { tag: string }[] };
    const before = journal.entries.slice(0, journal.entries.findIndex((e) => e.tag === tag));
    writeFileSync(join(folder, "meta/_journal.json"), JSON.stringify({ ...journal, entries: before }));
    for (const e of before) copyFileSync(join(MIGRATIONS_DIR, `${e.tag}.sql`), join(folder, `${e.tag}.sql`));
    const file = join(dir, "manager.db");
    const standing = new Database(file);
    migrate(drizzle(standing), { migrationsFolder: folder });
    return { file, standing };
  }

  // Before 0027 a run recorded its starter and its times in columns of its own, and the audit its
  // actor; 0027 carries each into the stamp columns, and names an actor nothing recorded `unrecorded`.
  it("carries the recorded times and actors of runs, steps, events, locks and audit into their stamps", () => {
    const { file, standing } = standingBefore("0027_stamp-runs-and-audit");
    const run = standing.prepare("INSERT INTO runs (id, kind, target_kind, target_id, params_json, plan_json, status, started_by, created_at, approved_at, started_at, finished_at, deleted_at) VALUES (?, 'noop', 'server', 'srv_1', '{}', '{}', ?, ?, ?, ?, ?, ?, ?)");
    run.run("run_done", "succeeded", "op_system", 1000, 2000, 3000, 4000, null);
    run.run("run_deleted", "planned", "op_emergency", 5000, null, null, null, 6000);
    run.run("run_deleted_unaudited", "failed", "op_system", 7000, null, 7500, 7600, 8000);
    run.run("run_untouched", "planned", "op_emergency", 9000, null, null, null, null);
    const audit = standing.prepare("INSERT INTO audit (id, ts, actor, action, run_id) VALUES (?, ?, ?, ?, ?)");
    audit.run("aud_approved", 2000, "op_emergency", "run.approved", "run_done");
    audit.run("aud_succeeded", 4000, "system", "run.succeeded", "run_done");
    audit.run("aud_deleted", 6000, "op_emergency", "run.deleted", "run_deleted");
    audit.run("aud_credential", 10, "system", "credential.created", null);
    const step = standing.prepare("INSERT INTO steps (id, run_id, ordinal, name, title, status, started_at, finished_at) VALUES (?, ?, 0, 'a', 'A', ?, ?, ?)");
    step.run("stp_done", "run_done", "succeeded", 3000, 3500);
    step.run("stp_pending", "run_deleted", "pending", null, null);
    standing.prepare("INSERT INTO events (id, run_id, step_id, ts, stream, seq, text) VALUES ('evt_1', 'run_done', 'stp_done', 3100, 'stdout', 0, 'hello')").run();
    standing.prepare("INSERT INTO run_locks (resource, key, run_id, acquired_at) VALUES ('master-kube', 'm', 'run_done', 2500)").run();
    standing.close();
    const h = openDb(file);
    handles.push(h);
    const q = (sql: string): unknown[] => h.sqlite.prepare(sql).all();
    expect(q("SELECT id, creation, modified, owner, modified_by, deleted, deleted_by FROM runs ORDER BY id")).toEqual([
      { id: "run_deleted", creation: 5000, modified: 6000, owner: "op_emergency", modified_by: "op_emergency", deleted: 6000, deleted_by: "op_emergency" },
      { id: "run_deleted_unaudited", creation: 7000, modified: 8000, owner: "op_system", modified_by: "unrecorded", deleted: 8000, deleted_by: "unrecorded" },
      { id: "run_done", creation: 1000, modified: 4000, owner: "op_system", modified_by: "op_system", deleted: null, deleted_by: null },
      { id: "run_untouched", creation: 9000, modified: 9000, owner: "op_emergency", modified_by: "op_emergency", deleted: null, deleted_by: null },
    ]);
    expect(q("SELECT id, creation, modified, owner, modified_by FROM steps ORDER BY id")).toEqual([
      { id: "stp_done", creation: 1000, modified: 3500, owner: "op_system", modified_by: "unrecorded" },
      { id: "stp_pending", creation: 5000, modified: 5000, owner: "op_emergency", modified_by: "op_emergency" },
    ]);
    expect(q("SELECT id, creation, modified, owner, modified_by FROM events")).toEqual([
      { id: "evt_1", creation: 3100, modified: 3100, owner: "op_system", modified_by: "op_system" },
    ]);
    expect(q("SELECT resource, key, run_id, creation, modified, owner, modified_by, deleted, deleted_by, id FROM run_locks")).toEqual([
      { resource: "master-kube", key: "m", run_id: "run_done", creation: 2500, modified: 2500, owner: "unrecorded", modified_by: "unrecorded", deleted: null, deleted_by: null, id: "lock_00000000000000000000000001" },
    ]);
    expect(q("SELECT id, creation, modified, owner, modified_by FROM audit ORDER BY id")).toEqual([
      { id: "aud_approved", creation: 2000, modified: 2000, owner: "op_emergency", modified_by: "op_emergency" },
      { id: "aud_credential", creation: 10, modified: 10, owner: "op_system", modified_by: "op_system" },
      { id: "aud_deleted", creation: 6000, modified: 6000, owner: "op_emergency", modified_by: "op_emergency" },
      { id: "aud_succeeded", creation: 4000, modified: 4000, owner: "op_system", modified_by: "op_system" },
    ]);
    // The rebuilds dropped the append-only triggers with their tables; 0027 creates them again.
    expect(() => h.sqlite.prepare("UPDATE events SET text = 'x' WHERE id = 'evt_1'").run()).toThrow(/append-only/);
    expect(() => h.sqlite.prepare("DELETE FROM audit WHERE id = 'aud_credential'").run()).toThrow(/append-only/);
    expect(h.sqlite.pragma("integrity_check", { simple: true })).toBe("ok");
  });

  // Before 0028 a server, a cluster, an app, a tenant and a tenant app recorded at most their times, and
  // a server or a master cluster its creator in the audit; 0028 carries each into the stamp columns.
  it("carries the recorded times and creators of servers, clusters, apps, tenants and tenant apps into their stamps", () => {
    const { file, standing } = standingBefore("0028_stamp-inventory");
    const server = standing.prepare("INSERT INTO servers (id, name, host, ssh_user, role, created_at, adopted_at) VALUES (?, ?, ?, 'root', ?, ?, ?)");
    server.run("srv_m", "m1", "10.0.0.1", "master", 1000, null);
    server.run("srv_1", "s1", "10.0.0.2", "slave", 2000, 2500);
    server.run("srv_2", "s2", "10.0.0.3", "slave", 3000, null);
    const cluster = standing.prepare("INSERT INTO clusters (id, server_id, stage, domain, name, provisioned_at) VALUES (?, ?, 'prod', ?, ?, ?)");
    cluster.run("cls_m", "srv_m", "m1.example", "m1", null);
    cluster.run("cls_1", "srv_1", "s1.example", "s1", 4000);
    cluster.run("cls_2", "srv_2", "s2.example", "s2", null);
    const audit = standing.prepare("INSERT INTO audit (id, action, target_kind, target_id, creation, modified, owner, modified_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    audit.run("aud_1", "server.master_seeded", "server", "srv_m", 1000, 1000, "op_system", "op_system");
    audit.run("aud_2", "cluster.master_seeded", "cluster", "cls_m", 1100, 1100, "op_system", "op_system");
    audit.run("aud_3", "server.created", "server", "srv_1", 2000, 2000, "op_emergency", "op_emergency");
    // A later change of the server names who changed it, never who created it.
    audit.run("aud_4", "server.machine_identity_restated", "server", "srv_1", 2600, 2600, "op_system", "op_system");
    standing.prepare("INSERT INTO apps (id, cluster_id, name, stage, host, created_at, updated_at) VALUES ('app_1', 'cls_1', 'post', 'prod', 'post.example', 5000, 6000)").run();
    standing.prepare("INSERT INTO tenants (id, cluster_id, guid, subdomain, stage, identity_provider, members, owner, created_at, updated_at) VALUES ('tnt_1', 'cls_1', 'abcdefghjkmn', 'acme', 'prod', 'idp', '[]', 'acme-org', 7000, 8000)").run();
    standing.prepare("INSERT INTO tenant_apps (id, tenant_id, name, created_at) VALUES ('tna_1', 'tnt_1', 'erp', 9000)").run();
    standing.close();
    const migratedFrom = Date.now();
    const h = openDb(file);
    handles.push(h);
    const q = (sql: string): unknown[] => h.sqlite.prepare(sql).all();
    expect(q("SELECT id, creation, modified, owner, modified_by, deleted, deleted_by FROM servers ORDER BY id")).toEqual([
      { id: "srv_1", creation: 2000, modified: 2500, owner: "op_emergency", modified_by: "unrecorded", deleted: null, deleted_by: null },
      { id: "srv_2", creation: 3000, modified: 3000, owner: "unrecorded", modified_by: "unrecorded", deleted: null, deleted_by: null },
      { id: "srv_m", creation: 1000, modified: 1000, owner: "op_system", modified_by: "unrecorded", deleted: null, deleted_by: null },
    ]);
    const clusters = q("SELECT id, creation, modified, owner, modified_by FROM clusters ORDER BY id") as { id: string; creation: number; modified: number }[];
    expect(clusters).toEqual([
      { id: "cls_1", creation: 4000, modified: 4000, owner: "unrecorded", modified_by: "unrecorded" },
      { id: "cls_2", creation: expect.any(Number), modified: expect.any(Number), owner: "unrecorded", modified_by: "unrecorded" },
      { id: "cls_m", creation: 1100, modified: 1100, owner: "op_system", modified_by: "unrecorded" },
    ]);
    // Nothing recorded when cls_2 was added, so the migration's time stands.
    const added = clusters.find((c) => c.id === "cls_2");
    expect(added?.creation).toBeGreaterThanOrEqual(migratedFrom);
    expect(added?.modified).toBe(added?.creation);
    expect(q("SELECT id, creation, modified, owner, modified_by FROM apps")).toEqual([{ id: "app_1", creation: 5000, modified: 6000, owner: "unrecorded", modified_by: "unrecorded" }]);
    expect(q("SELECT id, repo_owner, creation, modified, owner, modified_by FROM tenants")).toEqual([
      { id: "tnt_1", repo_owner: "acme-org", creation: 7000, modified: 8000, owner: "unrecorded", modified_by: "unrecorded" },
    ]);
    expect(q("SELECT id, creation, modified, owner, modified_by, deleted, deleted_by FROM tenant_apps")).toEqual([
      { id: "tna_1", creation: 9000, modified: 9000, owner: "unrecorded", modified_by: "unrecorded", deleted: null, deleted_by: null },
    ]);
    // The unique indexes now hold live rows only: a deleted row frees its name and address.
    const addServer = h.sqlite.prepare("INSERT INTO servers (id, name, host, ssh_user, owner, modified_by) VALUES ('srv_3', 's2', '10.0.0.3', 'root', 'op_system', 'op_system')");
    expect(() => addServer.run()).toThrow(/UNIQUE/);
    h.sqlite.prepare("UPDATE servers SET deleted = 1, deleted_by = 'op_system' WHERE id = 'srv_2'").run();
    addServer.run();
    const addApp = h.sqlite.prepare("INSERT INTO tenant_apps (id, tenant_id, name, owner, modified_by) VALUES ('tna_2', 'tnt_1', 'erp', 'op_system', 'op_system')");
    expect(() => addApp.run()).toThrow(/UNIQUE/);
    h.sqlite.prepare("UPDATE tenant_apps SET deleted = 1, deleted_by = 'op_system' WHERE id = 'tna_1'").run();
    addApp.run();
    expect(h.sqlite.pragma("foreign_key_check")).toEqual([]);
    expect(h.sqlite.pragma("integrity_check", { simple: true })).toBe("ok");
  });

  it("carries the recorded times and actors of operators, operator keys, meta, revoked sessions and credentials into their stamps", () => {
    const { file, standing } = standingBefore("0029_stamp-operators-and-credentials");
    const operator = standing.prepare("INSERT INTO operators (id, username, display_name, subject, created_at) VALUES (?, ?, ?, ?, ?)");
    operator.run("op_ada", "ada", "Ada", "sub-ada", 1000);
    operator.run("op_bob", "bob", "Bob", "sub-bob", 1100);
    const audit = standing.prepare("INSERT INTO audit (id, action, target_kind, target_id, detail_json, creation, modified, owner, modified_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    audit.run("aud_1", "operator.upserted", null, null, null, 1000, 1000, "op_ada", "op_ada");
    standing.prepare("INSERT INTO operator_keys (id, label, public_key, type, fingerprint, created_at, created_by) VALUES ('opk_1', 'ada', 'ssh-ed25519 AAAA', 'ssh-ed25519', 'SHA256:x', 2000, 'op_ada')").run();
    standing.prepare("INSERT INTO meta (key, value, updated_at) VALUES ('probe', 'v', 3000)").run();
    standing.prepare("INSERT INTO revoked_sessions (jti, expires_at) VALUES ('jti_1', 4000000000)").run();
    const credential = standing.prepare("INSERT INTO credentials (id, kind, label, subject_kind, subject_id, purpose, encrypted_blob, fingerprint, created_at, last_used_at, rotated_at, revoked_at) VALUES (?, 'pat', ?, 'owner', 'acme', 'repository-pat', ?, 'f', ?, ?, ?, ?)");
    credential.run("cred_a", "untouched", "plain:v0:YQ==", 4000, null, null, null);
    credential.run("cred_b", "used", "plain:v0:Yg==", 4100, 4500, null, null);
    credential.run("cred_c", "rotated", "plain:v0:Yw==", 4200, null, 4800, null);
    credential.run("cred_d", "successor", "plain:v0:ZA==", 4800, null, null, null);
    credential.run("cred_e", "revoked", "plain:v0:ZQ==", 4300, null, null, 4400);
    audit.run("aud_2", "credential.created", "credential", "cred_a", null, 4000, 4000, "op_ada", "op_ada");
    audit.run("aud_3", "credential.created", "credential", "cred_b", null, 4100, 4100, "op_ada", "op_ada");
    audit.run("aud_4", "credential.used", "credential", "cred_b", null, 4500, 4500, "op_bob", "op_bob");
    audit.run("aud_5", "credential.created", "credential", "cred_c", null, 4200, 4200, "op_ada", "op_ada");
    audit.run("aud_6", "credential.created", "credential", "cred_d", null, 4800, 4800, "op_system", "op_system");
    // A rotation is audited on the new credential; the old one is named only under `supersedes`.
    audit.run("aud_7", "credential.rotated", "credential", "cred_d", JSON.stringify({ supersedes: "cred_c", fingerprint: "f" }), 4800, 4800, "op_system", "op_system");
    standing.close();
    const migratedFrom = Date.now();
    const h = openDb(file);
    handles.push(h);
    const q = (sql: string): unknown[] => h.sqlite.prepare(sql).all();
    // The two seeded operators were written by nobody recorded; a signed-in operator wrote its own row.
    expect(q("SELECT id, owner, modified_by FROM operators ORDER BY id")).toEqual([
      { id: "op_ada", owner: "op_ada", modified_by: "op_ada" },
      { id: "op_bob", owner: "unrecorded", modified_by: "unrecorded" },
      { id: "op_emergency", owner: "unrecorded", modified_by: "unrecorded" },
      { id: "op_system", owner: "unrecorded", modified_by: "unrecorded" },
    ]);
    expect(q("SELECT creation, modified FROM operators WHERE id = 'op_ada'")).toEqual([{ creation: 1000, modified: 1000 }]);
    expect(q("SELECT id, creation, modified, owner, modified_by, deleted, deleted_by FROM operator_keys")).toEqual([
      { id: "opk_1", creation: 2000, modified: 2000, owner: "op_ada", modified_by: "op_ada", deleted: null, deleted_by: null },
    ]);
    expect(q("SELECT key, creation, modified, owner, modified_by FROM meta WHERE key = 'probe'")).toEqual([
      { key: "probe", creation: 3000, modified: 3000, owner: "unrecorded", modified_by: "unrecorded" },
    ]);
    // Nothing recorded when the session was revoked, so the migration's time stands.
    const revoked = q("SELECT creation, modified, owner, modified_by FROM revoked_sessions") as { creation: number; modified: number }[];
    expect(revoked).toEqual([{ creation: expect.any(Number), modified: expect.any(Number), owner: "unrecorded", modified_by: "unrecorded" }]);
    expect(revoked[0]?.creation).toBeGreaterThanOrEqual(migratedFrom);
    expect(revoked[0]?.modified).toBe(revoked[0]?.creation);
    expect(q("SELECT id, encrypted_blob, creation, modified, owner, modified_by, deleted, deleted_by FROM credentials ORDER BY id")).toEqual([
      { id: "cred_a", encrypted_blob: "plain:v0:YQ==", creation: 4000, modified: 4000, owner: "op_ada", modified_by: "op_ada", deleted: null, deleted_by: null },
      { id: "cred_b", encrypted_blob: "plain:v0:Yg==", creation: 4100, modified: 4500, owner: "op_ada", modified_by: "op_bob", deleted: null, deleted_by: null },
      { id: "cred_c", encrypted_blob: "plain:v0:Yw==", creation: 4200, modified: 4800, owner: "op_ada", modified_by: "op_system", deleted: null, deleted_by: null },
      { id: "cred_d", encrypted_blob: "plain:v0:ZA==", creation: 4800, modified: 4800, owner: "op_system", modified_by: "op_system", deleted: null, deleted_by: null },
      { id: "cred_e", encrypted_blob: "plain:v0:ZQ==", creation: 4300, modified: 4400, owner: "unrecorded", modified_by: "unrecorded", deleted: null, deleted_by: null },
    ]);
    // The key's unique indexes now hold live rows only: a deleted key frees its label and fingerprint.
    const addKey = h.sqlite.prepare("INSERT INTO operator_keys (id, label, public_key, type, fingerprint, owner, modified_by) VALUES ('opk_2', 'ada', 'ssh-ed25519 AAAA', 'ssh-ed25519', 'SHA256:x', 'op_system', 'op_system')");
    expect(() => addKey.run()).toThrow(/UNIQUE/);
    h.sqlite.prepare("UPDATE operator_keys SET deleted = 1, deleted_by = 'op_system' WHERE id = 'opk_1'").run();
    addKey.run();
    expect(h.sqlite.pragma("foreign_key_check")).toEqual([]);
    expect(h.sqlite.pragma("integrity_check", { simple: true })).toBe("ok");
  });

  it("carries the recorded times and the run's operator of the DNS, secret and backup books into their stamps", () => {
    const { file, standing } = standingBefore("0030_stamp-dns-secret-and-backup-books");
    standing.prepare("INSERT INTO operators (id, username, display_name, owner, modified_by) VALUES ('op_ada', 'ada', 'Ada', 'op_ada', 'op_ada')").run();
    standing.prepare("INSERT INTO runs (id, kind, target_kind, target_id, params_json, plan_json, status, owner, modified_by) VALUES ('run_a', 'noop', 'server', 'srv_1', '{}', '{}', 'succeeded', 'op_ada', 'op_ada')").run();
    // run_gone stands for a run the book names and the runs table does not hold.
    const dns = standing.prepare("INSERT INTO dns_writes (name, type, content, act, owner_kind, owner_name, run_id, written_at) VALUES (?, 'A', '203.0.113.9', 'inserted', 'consumer', 'post', ?, ?)");
    dns.run("post.example.com", "run_a", 5000);
    dns.run("shop.example.com", "run_gone", 5100);
    const secret = standing.prepare("INSERT INTO secret_writes (entry, key, act, run_id, written_at) VALUES ('prod/consumer/post/app', ?, 'seeded', ?, ?)");
    secret.run("A", "run_a", 6000);
    secret.run("B", "run_gone", 6100);
    const backup = standing.prepare("INSERT INTO unit_backups (kind, unit, stage, generation, folder, trigger, run_id, state, taken_at, finished_at) VALUES ('consumer', 'post', 'prod', ?, 'f', 'manual', ?, ?, ?, ?)");
    backup.run("20260101T000000Z", "run_a", "ok", 7000, 7200);
    backup.run("20260102T000000Z", "run_a", "pruned", 7300, 7400);
    backup.run("20260103T000000Z", null, "taking", 7500, null);
    standing.close();
    const h = openDb(file);
    handles.push(h);
    const q = (sql: string): unknown[] => h.sqlite.prepare(sql).all();
    const id = (prefix: string, rowid: number): string => `${prefix}_${String(rowid).padStart(26, "0")}`;
    expect(q("SELECT id, name, creation, modified, owner, modified_by, deleted, deleted_by FROM dns_writes ORDER BY id")).toEqual([
      { id: id("dnsw", 1), name: "post.example.com", creation: 5000, modified: 5000, owner: "op_ada", modified_by: "op_ada", deleted: null, deleted_by: null },
      { id: id("dnsw", 2), name: "shop.example.com", creation: 5100, modified: 5100, owner: "unrecorded", modified_by: "unrecorded", deleted: null, deleted_by: null },
    ]);
    expect(q("SELECT id, key, creation, modified, owner, modified_by, deleted, deleted_by FROM secret_writes ORDER BY id")).toEqual([
      { id: id("secw", 1), key: "A", creation: 6000, modified: 6000, owner: "op_ada", modified_by: "op_ada", deleted: null, deleted_by: null },
      { id: id("secw", 2), key: "B", creation: 6100, modified: 6100, owner: "unrecorded", modified_by: "unrecorded", deleted: null, deleted_by: null },
    ]);
    expect(q("SELECT generation, taken_at, finished_at, creation, modified, owner, modified_by FROM unit_backups ORDER BY generation")).toEqual([
      { generation: "20260101T000000Z", taken_at: 7000, finished_at: 7200, creation: 7000, modified: 7200, owner: "op_ada", modified_by: "op_ada" },
      { generation: "20260102T000000Z", taken_at: 7300, finished_at: 7400, creation: 7300, modified: 7400, owner: "op_ada", modified_by: "unrecorded" },
      { generation: "20260103T000000Z", taken_at: 7500, finished_at: null, creation: 7500, modified: 7500, owner: "unrecorded", modified_by: "unrecorded" },
    ]);
    // The books' unique indexes now hold live rows only: a deleted row frees its record for a new one.
    const rewrite = h.sqlite.prepare("INSERT INTO dns_writes (id, name, type, content, act, owner_kind, owner_name, run_id, owner, modified_by) VALUES ('dnsw_new', 'post.example.com', 'A', '203.0.113.20', 'inserted', 'consumer', 'post', 'run_a', 'op_ada', 'op_ada')");
    expect(() => rewrite.run()).toThrow(/UNIQUE/);
    h.sqlite.prepare(`UPDATE dns_writes SET deleted = 1, deleted_by = 'op_ada' WHERE id = '${id("dnsw", 1)}'`).run();
    rewrite.run();
    const rekey = h.sqlite.prepare("INSERT INTO secret_writes (id, entry, key, act, run_id, owner, modified_by) VALUES ('secw_new', 'prod/consumer/post/app', 'A', 'set', 'run_a', 'op_ada', 'op_ada')");
    expect(() => rekey.run()).toThrow(/UNIQUE/);
    h.sqlite.prepare(`UPDATE secret_writes SET deleted = 1, deleted_by = 'op_ada' WHERE id = '${id("secw", 1)}'`).run();
    rekey.run();
    expect(h.sqlite.pragma("foreign_key_check")).toEqual([]);
    expect(h.sqlite.pragma("integrity_check", { simple: true })).toBe("ok");
  });
});
