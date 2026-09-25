import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type DbHandle } from "./client.ts";

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
