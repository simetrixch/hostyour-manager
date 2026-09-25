import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type DbHandle } from "./client.ts";
import { compiledPlugins } from "../plugins.ts";
import { inDependencyOrder } from "../boot/plugin-set.ts";

const CORE_MIGRATIONS = fileURLToPath(new URL("./migrations", import.meta.url));

// A plugin's first migration ADOPTS a table the core already created — written `CREATE TABLE IF NOT
// EXISTS`, so it creates nothing where the table stands and its rows stay — and adds one of its own.
// That is the shape each plugin's first migration takes when a table moves out of the core; `meta`
// stands in here for the moved table.
const ADOPTING_MIGRATION = [
  "CREATE TABLE IF NOT EXISTS `meta` (`key` text PRIMARY KEY NOT NULL, `value` text NOT NULL, `updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL);",
  "CREATE TABLE IF NOT EXISTS `probe_notes` (`id` text PRIMARY KEY NOT NULL, `note` text NOT NULL);",
].join("\n--> statement-breakpoint\n");

/** A migrations folder as drizzle-kit writes one: a journal and the SQL it names. */
function migrationsFolder(dir: string): string {
  const folder = join(dir, "probe-migrations");
  mkdirSync(join(folder, "meta"), { recursive: true });
  const journal = { version: "7", dialect: "sqlite", entries: [{ idx: 0, version: "6", when: 1758700000000, tag: "0000_adopt", breakpoints: true }] };
  writeFileSync(join(folder, "meta/_journal.json"), JSON.stringify(journal));
  writeFileSync(join(folder, "0000_adopt.sql"), ADOPTING_MIGRATION);
  return folder;
}

describe("openDb over the migration trees of the compiled plugins", () => {
  const handles: DbHandle[] = [];
  const dirs: string[] = [];
  afterEach(() => {
    for (const h of handles.splice(0)) if (h.sqlite.open) h.sqlite.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("migrates a plugin's folder under its own ledger over a database the core migrated and rows stand in, and a second open changes nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "mgr-trees-"));
    dirs.push(dir);
    const file = join(dir, "manager.db");
    const count = (h: DbHandle, table: string): number => (h.sqlite.prepare(`SELECT count(*) AS c FROM "${table}"`).get() as { c: number }).c;
    const shape = (h: DbHandle): unknown[] => h.sqlite.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all();
    const probeRows = (h: DbHandle): unknown[] => h.sqlite.prepare("SELECT key, value FROM meta WHERE key IN ('probe', 'other') ORDER BY key").all();

    const coreOnly = openDb(file);
    handles.push(coreOnly);
    coreOnly.sqlite.prepare("INSERT INTO meta (key, value) VALUES ('probe', 'kept'), ('other', 'kept too')").run();
    const coreLedger = count(coreOnly, "__drizzle_migrations");
    coreOnly.sqlite.close();

    const trees = [{ name: "probe", migrations: migrationsFolder(dir) }];
    const first = openDb(file, trees);
    handles.push(first);
    expect(count(first, "__drizzle_migrations_probe")).toBe(1);
    expect(count(first, "__drizzle_migrations")).toBe(coreLedger);
    expect(probeRows(first)).toEqual([{ key: "other", value: "kept too" }, { key: "probe", value: "kept" }]);
    expect(count(first, "probe_notes")).toBe(0);
    const afterFirst = shape(first);
    first.sqlite.close();

    const second = openDb(file, trees);
    handles.push(second);
    expect(shape(second)).toEqual(afterFirst);
    expect(count(second, "__drizzle_migrations_probe")).toBe(1);
    expect(count(second, "__drizzle_migrations")).toBe(coreLedger);
    expect(probeRows(second)).toEqual([{ key: "other", value: "kept too" }, { key: "probe", value: "kept" }]);
  });
});

// THE PRODUCT'S OWN TREES over the database the release before the unit plugin leaves behind: the
// core's migrations up to 0012, and a row in EVERY table (the lesson of #229: an empty table hides what
// SQLite refuses). Boot then applies the core's 0013, which changes nothing, and the unit plugin's
// first migration, which adopts unit_sizes; twice, and neither pass may change a row or the shape of
// the file, while both ledgers stand.
const PREVIOUS_HEAD = "0012_tenants-approved-tags";
const ROW_IN_EVERY_TABLE = [
  "INSERT INTO servers (id, name, host, ssh_user) VALUES ('srv_1', 's1', '10.0.0.1', 'm1')",
  "INSERT INTO clusters (id, server_id, stage, domain, name) VALUES ('cl_1', 'srv_1', 'prod', 's1.example.com', 's1')",
  "INSERT INTO credentials (id, kind, label, subject_kind, subject_id, purpose, encrypted_blob, fingerprint) VALUES ('cred_1', 'ssh_key', 'k', 'server', 'srv_1', 'ssh-key', 'plain:v0:AA==', 'fp')",
  "INSERT INTO apps (id, cluster_id, name, stage, host) VALUES ('app_1', 'cl_1', 'post', 'prod', 'post')",
  "INSERT INTO tenants (id, cluster_id, guid, subdomain, stage, identity_provider, members) VALUES ('tnt_1', 'cl_1', 'abcdefghjkmn', 'acme', 'prod', 'idp', '[\"idp\"]')",
  "INSERT INTO tenant_apps (id, tenant_id, name) VALUES ('tna_1', 'tnt_1', 'web')",
  "INSERT INTO unit_sizes (component, name, requests_cpu, requests_memory, limits_cpu, limits_memory, pods, persistent_volume_claims) VALUES ('base', 'small', '900m', '1Gi', '2', '2Gi', 10, 5)",
  "INSERT INTO runs (id, kind, target_kind, target_id, params_json, status, started_by) VALUES ('run_1', 'noop', 'self', 'manager', '{}', 'failed', 'op_system')",
  "INSERT INTO steps (id, run_id, ordinal, name, title) VALUES ('st_1', 'run_1', 0, 'x', 'X')",
  "INSERT INTO events (id, run_id, stream, seq, text) VALUES ('ev_1', 'run_1', 'stdout', 0, 'hi')",
  "INSERT INTO run_locks (resource, key, run_id) VALUES ('server', 's1', 'run_1')",
  "INSERT INTO audit (id, actor, action) VALUES ('aud_1', 'op_system', 'run.started')",
  "INSERT INTO meta (key, value) VALUES ('keystore.mode', 'plaintext')",
  "INSERT INTO operator_keys (id, label, public_key, type, fingerprint, created_by) VALUES ('okey_1', 'ada', 'ssh-ed25519 AAAA ada', 'ssh-ed25519', 'SHA256:x', 'op_system')",
  "INSERT INTO dns_writes (name, type, content, act, owner_kind, owner_name, run_id) VALUES ('post.example.com', 'CNAME', 's1.example.com', 'insert', 'consumer', 'post', 'run_1')",
];

describe("openDb over the trees of the plugins this product compiles", () => {
  const handles: DbHandle[] = [];
  const dirs: string[] = [];
  afterEach(() => {
    for (const h of handles.splice(0)) if (h.sqlite.open) h.sqlite.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("carries the previous release's database with a row in every table over every tree, twice, rows and schema kept, both ledgers standing", () => {
    const dir = mkdtempSync(join(tmpdir(), "mgr-compiled-"));
    dirs.push(dir);
    const file = join(dir, "manager.db");
    const tables = (s: Database.Database): string[] => (s.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle_migrations%' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
    const rows = (s: Database.Database): Record<string, unknown[]> => Object.fromEntries(tables(s).map((tb) => [tb, s.prepare(`SELECT * FROM "${tb}" ORDER BY rowid`).all()]));
    const shape = (s: Database.Database): unknown[] => s.prepare("SELECT type, name, sql FROM sqlite_master WHERE tbl_name NOT LIKE '__drizzle_migrations%' ORDER BY type, name").all();
    const ledger = (s: Database.Database, name: string): number => (s.prepare(`SELECT count(*) AS c FROM "${name}"`).get() as { c: number }).c;

    // The core's folder up to the previous release's head, as a folder of its own.
    const previous = join(dir, "previous");
    mkdirSync(join(previous, "meta"), { recursive: true });
    const journal = JSON.parse(readFileSync(join(CORE_MIGRATIONS, "meta/_journal.json"), "utf8")) as { entries: { tag: string }[] };
    const upTo = journal.entries.findIndex((e) => e.tag === PREVIOUS_HEAD);
    expect(upTo, `${PREVIOUS_HEAD} in the core's journal`).toBeGreaterThan(0);
    expect(journal.entries.length, "the core carries a migration after the previous head").toBeGreaterThan(upTo + 1);
    writeFileSync(join(previous, "meta/_journal.json"), JSON.stringify({ ...journal, entries: journal.entries.slice(0, upTo + 1) }));
    for (const e of journal.entries.slice(0, upTo + 1)) copyFileSync(join(CORE_MIGRATIONS, `${e.tag}.sql`), join(previous, `${e.tag}.sql`));

    const standing = new Database(file);
    migrate(drizzle(standing), { migrationsFolder: previous });
    for (const insert of ROW_IN_EVERY_TABLE) standing.prepare(insert).run();
    const empty = Object.entries(rows(standing)).filter(([, r]) => r.length === 0).map(([tb]) => tb);
    expect(empty, `tables the proof seeds no row in: ${empty.join(", ")}`).toEqual([]);
    const before = { rows: rows(standing), shape: shape(standing) };
    standing.close();

    const trees = inDependencyOrder(compiledPlugins);
    expect(trees.map((tr) => tr.name)).toContain("unit");
    for (let pass = 1; pass <= 2; pass += 1) {
      const opened = openDb(file, trees);
      handles.push(opened);
      expect(rows(opened.sqlite), `pass ${pass}`).toEqual(before.rows);
      expect(shape(opened.sqlite), `pass ${pass}`).toEqual(before.shape);
      expect(ledger(opened.sqlite, "__drizzle_migrations"), `pass ${pass}`).toBe(journal.entries.length);
      for (const tr of trees) {
        const own = JSON.parse(readFileSync(join(tr.migrations, "meta/_journal.json"), "utf8")) as { entries: unknown[] };
        expect(ledger(opened.sqlite, `__drizzle_migrations_${tr.name}`), `pass ${pass}: ${tr.name}`).toBe(own.entries.length);
      }
      opened.sqlite.close();
    }
  });
});
