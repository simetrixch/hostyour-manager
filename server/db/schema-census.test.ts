import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb, type DbHandle } from "./client.ts";

// A census over the drizzle schema: every declared column must have a writer. A column nobody ever
// writes is a promise the schema makes and the code never keeps — it reads as live data, ships in
// every migration, and every reader that touches it gets NULL forever.
//
// A column counts as written when EITHER the declaration carries its own default (.default /
// .$defaultFn — the database supplies the value), OR a shipped writer names it, OR a migration
// INSERTs/UPDATEs it.
//
// Writers are found TABLE-SCOPED: only the payload of a `.insert(<table>)` / `.update(<table>)` call
// counts, with `...spread` and bare-identifier payloads resolved against the const they name in the
// same file. Scoping is what gives the census its teeth — `resetNonce` is a live field on the tenant
// POINTER file (domains/onboarding/tenant-registry.ts) while the same-named tenants column has no
// writer at all, and an unscoped grep would call that green.
//
// One payload shape cannot be resolved statically: a helper that takes the row as a PARAMETER
// (upsertAppRow does `.set(values)`), where the keys live at the call site. When a payload name
// resolves to no const in the file, the census falls back to every object key in that file — the one
// place it trades precision for not crying wolf.
//
// The schema is read as SOURCE, not imported: the boundary law gives runs/credentials/operators/audit
// exactly one importer each, and a census that imported them would break it.

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SCHEMA_DIR = "server/db/schema";
const MIGRATIONS_DIR = "server/db/migrations";
const COLUMN_BUILDERS = "text|integer|real|blob|numeric";

interface Journal {
  entries: { idx: number; tag: string }[];
}

function readJournal(): Journal {
  return JSON.parse(readFileSync(join(ROOT, MIGRATIONS_DIR, "meta/_journal.json"), "utf8")) as Journal;
}

/** The head snapshot as drizzle-kit writes it. Every object a CREATE TABLE can carry is in here —
 *  which is why it, and not the regex over server/db/schema, is what the executed SQL is measured
 *  against below. */
interface SnapshotColumn { name: string; notNull: boolean; primaryKey: boolean; default?: unknown }
interface SnapshotIndex { name: string; columns: string[]; isUnique: boolean; where?: string }
interface SnapshotForeignKey {
  columnsFrom: string[]; tableTo: string; columnsTo: string[]; onDelete?: string; onUpdate?: string;
}
interface SnapshotTable {
  columns: Record<string, SnapshotColumn>;
  indexes: Record<string, SnapshotIndex>;
  foreignKeys: Record<string, SnapshotForeignKey>;
  compositePrimaryKeys: Record<string, { columns: string[] }>;
  checkConstraints: Record<string, { value: string }>;
}

/** The journal's HEAD entry — the snapshot drizzle-kit diffs the schema against on the next
 *  `db:generate`, and therefore the one that has to state the truth. */
const HEAD = readJournal().entries.reduce((a, b) => (b.idx > a.idx ? b : a));

function readHeadSnapshot(): { tables: Record<string, SnapshotTable> } {
  const file = join(ROOT, MIGRATIONS_DIR, `meta/${String(HEAD.idx).padStart(4, "0")}_snapshot.json`);
  return JSON.parse(readFileSync(file, "utf8")) as { tables: Record<string, SnapshotTable> };
}

/** The pragma rows the built-database census reads. better-sqlite3 hands them back untyped, and the
 *  booleans arrive as 0/1. */
interface TableInfoRow { name: string; notnull: 0 | 1; dflt_value: string | null; pk: number }
interface IndexListRow { name: string; unique: 0 | 1; origin: string; partial: 0 | 1 }
interface IndexColumnRow { name: string | null; seqno: number; key: 0 | 1 }
interface ForeignKeyRow { id: number; seq: number; table: string; from: string; to: string; on_update: string; on_delete: string }

/** SQLite echoes a DEFAULT back without the parentheses drizzle-kit records it with, and always as
 *  text (`22`, `false`) where the snapshot keeps the JSON value — so the two only compare once both
 *  are reduced to the same string. */
function unparen(value: string): string {
  const t = value.trim();
  return t.startsWith("(") && t.endsWith(")") ? t.slice(1, -1).trim() : t;
}

/** One foreign key as the fact that governs a delete. The referential ACTIONS default to "no action"
 *  on both sides, which is what SQLite reports where drizzle-kit records nothing. */
function fkTuple(from: string[], to: string, toColumns: string[], onDelete?: string, onUpdate?: string): string {
  return `${from.join(",")} -> ${to}(${toColumns.join(",")}) ` +
    `on delete ${(onDelete ?? "no action").toLowerCase()} on update ${(onUpdate ?? "no action").toLowerCase()}`;
}

interface Column {
  table: string; // the drizzle export, e.g. tenantApps
  sqlTable: string; // the SQL name, e.g. tenant_apps
  prop: string; // the JS property writers use, e.g. lastRunId
  sqlName: string; // the SQL column name, e.g. last_run_id
  hasDefault: boolean;
}

/** The `{...}` starting at `open`, brace-balanced, braces included. */
function balanced(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === "{") depth += 1;
    else if (text[i] === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(open, i + 1);
    }
  }
  throw new Error(`unbalanced { at index ${open}`);
}

function schemaColumns(): Column[] {
  const columns: Column[] = [];
  for (const file of readdirSync(join(ROOT, SCHEMA_DIR)).filter((f) => f.endsWith(".ts"))) {
    const text = readFileSync(join(ROOT, SCHEMA_DIR, file), "utf8");
    for (const table of text.matchAll(/export const (\w+) = sqliteTable\(\s*"([^"]+)",\s*\{/g)) {
      const block = balanced(text, text.indexOf("{", table.index + table[0].length - 1));
      for (const line of block.split(/\r?\n/)) {
        const col = new RegExp(`^ {2}(\\w+): (?:${COLUMN_BUILDERS})\\(\\s*"([^"]+)"(.*)$`).exec(line);
        if (!col) continue;
        columns.push({
          table: table[1] as string,
          sqlTable: table[2] as string,
          prop: col[1] as string,
          sqlName: col[2] as string,
          hasDefault: /\.\$?default(Fn)?\(/.test(col[3] as string),
        });
      }
    }
  }
  return columns;
}

/** Every shipped .ts under server/ that could hold a write — tests, the schema itself and the
 *  adapter fakes are not writers. */
function writerSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const path = relative(ROOT, full).replaceAll("\\", "/");
      if (entry.isDirectory()) {
        if (path !== SCHEMA_DIR && !/^server\/adapters\/[^/]+\/testing$/.test(path)) walk(full);
        continue;
      }
      if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;
      out.push(readFileSync(full, "utf8"));
    }
  };
  walk(join(ROOT, "server"));
  return out;
}

/** The comma-separated entries of a `{...}`, at its own brace depth only. */
function topLevelEntries(block: string): string[] {
  const inner = block.slice(1, -1);
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (ch === "{" || ch === "(" || ch === "[") depth += 1;
    else if (ch === "}" || ch === ")" || ch === "]") depth -= 1;
    else if (ch === "," && depth === 0) {
      parts.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(inner.slice(start));
  return parts.map((p) => p.replace(/\/\/[^\n]*/g, "").replace(/\s+/g, " ").trim()).filter((p) => p.length > 0);
}

/** The column names a payload sets, plus the names it spreads in. Handles `key: value`, the
 *  shorthand `{ id, kind }` and `...spread`. */
function payloadParts(block: string): { keys: string[]; spreads: string[] } {
  const keys: string[] = [];
  const spreads: string[] = [];
  for (const entry of topLevelEntries(block)) {
    const spread = /^\.\.\.([A-Za-z_$][\w$]*)$/.exec(entry);
    if (spread) {
      spreads.push(spread[1] as string);
      continue;
    }
    const named = /^([A-Za-z_$][\w$]*)\s*:/.exec(entry);
    if (named) {
      keys.push(named[1] as string);
      continue;
    }
    if (/^[A-Za-z_$][\w$]*$/.test(entry)) {
      keys.push(entry);
      continue;
    }
    // A conditional entry such as `...(settle ? lifecycle : {})` — take everything it could set.
    for (const m of entry.matchAll(/([A-Za-z_$][\w$]*)\s*:/g)) keys.push(m[1] as string);
    for (const m of entry.matchAll(/\{\s*([A-Za-z_$][\w$]*)\s*\}/g)) keys.push(m[1] as string);
    for (const m of entry.matchAll(/\.\.\.([A-Za-z_$][\w$]*)/g)) spreads.push(m[1] as string);
  }
  return { keys, spreads };
}

/** Every object key in a file — the fallback for a payload the census cannot resolve. */
function everyObjectKey(file: string): string[] {
  return [...file.matchAll(/([A-Za-z_$][\w$]*)\s*:/g)].map((m) => m[1] as string);
}

/** The props each file writes, per table. */
function writtenProps(file: string, tables: Set<string>): Map<string, Set<string>> {
  const written = new Map<string, Set<string>>();
  const record = (table: string, props: string[]): void => {
    const set = written.get(table) ?? new Set<string>();
    for (const p of props) set.add(p);
    written.set(table, set);
  };
  // null = the name is a parameter, not a const in this file: its keys live at the call site.
  const resolve = (name: string, seen: Set<string>): string[] | null => {
    if (seen.has(name)) return [];
    seen.add(name);
    const decl = new RegExp(`\\b(?:const|let)\\s+${name}\\s*(?::[^=]+)?=\\s*\\{`).exec(file);
    if (!decl) return null;
    const parts = payloadParts(balanced(file, decl.index + decl[0].length - 1));
    const nested = parts.spreads.map((s) => resolve(s, seen));
    if (nested.includes(null)) return null;
    return [...parts.keys, ...nested.flat().filter((k): k is string => k !== null)];
  };

  for (const call of file.matchAll(/\.(?:insert|update)\(\s*(\w+)\s*\)/g)) {
    const table = call[1] as string;
    if (!tables.has(table)) continue;
    // Everything up to the next write call belongs to this statement.
    const from = call.index + call[0].length;
    const next = /\.(?:insert|update)\(\s*\w+\s*\)/.exec(file.slice(from));
    const window = file.slice(from, next ? from + next.index : from + 2000);
    for (const marker of window.matchAll(/\.values\(|\.set\(|\bset:\s*/g)) {
      const at = marker.index + marker[0].length;
      const start = window.slice(at).search(/\S/) + at;
      if (window[start] === "{") {
        const parts = payloadParts(balanced(window, start));
        const spread = parts.spreads.map((s) => resolve(s, new Set()));
        record(table, spread.includes(null) ? everyObjectKey(file) : [...parts.keys, ...spread.flat().filter((k): k is string => k !== null)]);
        continue;
      }
      const ident = /^([A-Za-z_$][\w$]*)/.exec(window.slice(start));
      if (ident) record(table, resolve(ident[1] as string, new Set()) ?? everyObjectKey(file));
    }
  }
  return written;
}

/** SQL column names a migration writes, per SQL table. */
function migrationWrites(): Map<string, Set<string>> {
  const written = new Map<string, Set<string>>();
  const add = (table: string, names: string[]): void => {
    const set = written.get(table) ?? new Set<string>();
    for (const n of names) set.add(n);
    written.set(table, set);
  };
  for (const file of readdirSync(join(ROOT, MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql"))) {
    const text = readFileSync(join(ROOT, MIGRATIONS_DIR, file), "utf8");
    for (const ins of text.matchAll(/INSERT\s+INTO\s+[`"]?(\w+)[`"]?\s*\(([^)]*)\)/gi)) {
      add(ins[1] as string, (ins[2] as string).split(",").map((c) => c.trim().replace(/[`"]/g, "")));
    }
    for (const upd of text.matchAll(/UPDATE\s+[`"]?(\w+)[`"]?\s+SET\s+([^;]*)/gi)) {
      add(upd[1] as string, [...(upd[2] as string).matchAll(/[`"]?(\w+)[`"]?\s*=/g)].map((m) => m[1] as string));
    }
  }
  return written;
}

describe("schema census: every column has a writer", () => {
  const columns = schemaColumns();
  const tables = new Set(columns.map((c) => c.table));

  it("parses the schema (the census has something to check)", () => {
    expect(tables.size).toBeGreaterThanOrEqual(10);
    expect(columns.some((c) => c.table === "runs" && c.prop === "planJson")).toBe(true);
    expect(columns.find((c) => c.table === "tenantApps" && c.prop === "createdAt")?.hasDefault).toBe(true);
  });

  it("names every column no shipped writer ever sets", () => {
    const byTable = new Map<string, Set<string>>();
    for (const source of writerSources()) {
      for (const [table, props] of writtenProps(source, tables)) {
        const set = byTable.get(table) ?? new Set<string>();
        for (const p of props) set.add(p);
        byTable.set(table, set);
      }
    }
    const sqlWrites = migrationWrites();

    const writerless = columns
      .filter((c) => !c.hasDefault)
      .filter((c) => !byTable.get(c.table)?.has(c.prop))
      .filter((c) => !sqlWrites.get(c.sqlTable)?.has(c.sqlName))
      .map((c) => `${c.sqlTable}.${c.sqlName}`);

    expect(writerless, `columns with no writer: ${writerless.join(", ")}`).toEqual([]);
  });
});

// The drizzle-kit META SNAPSHOTS are the second declaration of the same schema, and nothing else in
// this tree reads them — so drift between them and server/db/schema is invisible until the next
// `npm run db:generate`, which diffs the schema against the HEAD snapshot and writes whatever is
// missing into a new migration. A column dropped from the schema and from the baseline but left
// standing in the head snapshot therefore comes back as `ALTER TABLE ... DROP COLUMN` against a
// database created from the edited baseline, which never had it — and boot dies inside migrate().
describe("schema census: the head migration snapshot declares the same schema", () => {
  const snapshot = readHeadSnapshot();

  it(`${HEAD.tag} is the snapshot drizzle-kit would diff against`, () => {
    expect(Object.keys(snapshot.tables).length).toBeGreaterThanOrEqual(10);
  });

  it("declares exactly the tables and columns the drizzle schema does", () => {
    const columns = schemaColumns();
    const schemaTables = new Set(columns.map((c) => c.sqlTable));
    expect([...Object.keys(snapshot.tables)].filter((t) => !schemaTables.has(t))).toEqual([]);
    expect([...schemaTables].filter((t) => !snapshot.tables[t])).toEqual([]);

    const drift: string[] = [];
    for (const table of schemaTables) {
      const declared = new Set(columns.filter((c) => c.sqlTable === table).map((c) => c.sqlName));
      const stored = new Set(Object.keys(snapshot.tables[table]?.columns ?? {}));
      for (const c of declared) if (!stored.has(c)) drift.push(`${table}.${c} is in the schema and not in the snapshot`);
      for (const c of stored) if (!declared.has(c)) drift.push(`${table}.${c} is in the snapshot and not in the schema`);
    }
    expect(drift, drift.join("; ")).toEqual([]);
  });
});

// The journal is the migrator's whole index: it reads one .sql per ENTRY, by tag, and never lists the
// folder — so a file the journal does not name is never executed, never diffed, and still reads as
// live schema to the next person who opens the directory. Folding migrations back into the baseline is
// where such a file gets left: the entries go in one edit to the journal, while the .sql files and the
// snapshots beside them have to be deleted by hand. A leftover snapshot is the worse half, because
// `npm run db:generate` picks the snapshot to diff against by the journal's head index — leave a
// higher-numbered one and the next generate silently diffs against a schema nobody declares.
describe("schema census: the migration folder holds exactly what the journal names", () => {
  const journal = readJournal();

  it("one SQL file and one snapshot per entry, and nothing besides", () => {
    expect(journal.entries.length).toBeGreaterThan(0);
    const sql = readdirSync(join(ROOT, MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql"));
    expect(sql.sort()).toEqual(journal.entries.map((e) => `${e.tag}.sql`).sort());

    const snapshots = journal.entries.map((e) => `${String(e.idx).padStart(4, "0")}_snapshot.json`);
    expect(readdirSync(join(ROOT, MIGRATIONS_DIR, "meta")).sort()).toEqual(["_journal.json", ...snapshots].sort());
  });
});

// The .sql files are what actually build a database, and neither census above reads them as SQL. The
// snapshot is a SECOND declaration written beside them, so the snapshot and the schema can agree with
// each other while the CREATE TABLE disagrees with both — and the baseline is edited by hand every
// time it moves, because drizzle-kit splits the servers expression index on its comma and has to be
// corrected afterwards. Executing the folder is the only witness for what it really creates.
describe("schema census: the database the migrations build declares the same schema", () => {
  let handle: DbHandle | undefined;
  let dir: string | undefined;
  afterEach(() => {
    handle?.sqlite.close();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  });

  it("creates exactly the tables and columns the drizzle schema declares", () => {
    dir = mkdtempSync(join(tmpdir(), "ctrl-census-"));
    handle = openDb(join(dir, "controller.db")); // the whole folder applied, exactly as boot applies it
    const { sqlite } = handle;
    const columns = schemaColumns();
    const schemaTables = new Set(columns.map((c) => c.sqlTable));
    expect(schemaTables.size).toBeGreaterThanOrEqual(10); // the census has something to check

    // __drizzle_migrations is the migrator's own ledger and sqlite_* is SQLite's; neither is declared.
    const created = (sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[])
      .map((r) => r.name)
      .filter((n) => n !== "__drizzle_migrations" && !n.startsWith("sqlite_"));

    const drift: string[] = [];
    for (const t of created) if (!schemaTables.has(t)) drift.push(`table ${t} is in the database and not in the schema`);
    for (const table of schemaTables) {
      if (!created.includes(table)) {
        drift.push(`table ${table} is in the schema and not in the database`);
        continue;
      }
      const declared = new Set(columns.filter((c) => c.sqlTable === table).map((c) => c.sqlName));
      const present = new Set((sqlite.pragma(`table_info('${table}')`) as { name: string }[]).map((c) => c.name));
      for (const c of declared) if (!present.has(c)) drift.push(`${table}.${c} is in the schema and not in the database`);
      for (const c of present) if (!declared.has(c)) drift.push(`${table}.${c} is in the database and not in the schema`);
    }
    expect(drift, drift.join("; ")).toEqual([]);
  });

  // The census above reads NAMES only, because the drizzle schema is read as source and a regex over
  // it cannot see an index, a foreign-key action or a NOT NULL. Those are exactly what a hand-edited
  // CREATE TABLE loses without a trace, and each loss is silent in a different way: without
  // `clusters_slave_id_uq` two clusters rows carry one slave_id and the never-reused ordinal
  // (schema/inventory.ts) is gone; with credentials.server_id on ON DELETE cascade instead of
  // restrict, deleting a server takes its sealed keys with it where the wipe order (db/reset.ts)
  // assumes it is refused; without operator_keys_label_uq two rows share one label and the removal
  // that keys on that label matches two lines. The snapshot is the ONE declaration in the tree that
  // carries all of it, and drizzle-kit writes it — so it is what the executed SQL is measured against.
  it("carries the indexes, keys, defaults and NOT NULLs the head snapshot declares", () => {
    dir = mkdtempSync(join(tmpdir(), "ctrl-census-"));
    handle = openDb(join(dir, "controller.db"));
    const { sqlite } = handle;
    const { tables } = readHeadSnapshot();
    const drift: string[] = [];

    for (const [table, declared] of Object.entries(tables)) {
      const info = sqlite.pragma(`table_info('${table}')`) as TableInfoRow[];
      const columnNames = new Set(info.map((c) => c.name));
      const compositePk = new Set(Object.values(declared.compositePrimaryKeys).flatMap((p) => p.columns));

      for (const got of info) {
        const want = declared.columns[got.name];
        if (!want) continue; // a column the snapshot does not declare — the census above names it
        if ((got.notnull === 1) !== want.notNull) {
          drift.push(`${table}.${got.name} is NOT NULL=${got.notnull === 1} in the database and ${want.notNull} in the snapshot`);
        }
        if ((got.pk > 0) !== (want.primaryKey || compositePk.has(got.name))) {
          drift.push(`${table}.${got.name} is part of the PRIMARY KEY=${got.pk > 0} in the database and ${!(got.pk > 0)} in the snapshot`);
        }
        const wantDefault = want.default === undefined ? null : unparen(String(want.default));
        const gotDefault = got.dflt_value === null ? null : unparen(got.dflt_value);
        if (gotDefault !== wantDefault) {
          drift.push(`${table}.${got.name} DEFAULT is ${String(gotDefault)} in the database and ${String(wantDefault)} in the snapshot`);
        }
      }

      // Only `origin: "c"` — an explicit CREATE INDEX. "pk" and "u" are the indexes SQLite builds for
      // a PRIMARY KEY / UNIQUE column, which the loop above already accounts for.
      const built = new Map((sqlite.pragma(`index_list('${table}')`) as IndexListRow[])
        .filter((i) => i.origin === "c").map((i) => [i.name, i]));
      for (const want of Object.values(declared.indexes)) {
        const got = built.get(want.name);
        if (!got) {
          drift.push(`index ${want.name} on ${table} is in the snapshot and not in the database`);
          continue;
        }
        if ((got.unique === 1) !== want.isUnique) drift.push(`index ${want.name} is UNIQUE=${got.unique === 1} in the database and ${want.isUnique} in the snapshot`);
        if ((got.partial === 1) !== (want.where !== undefined)) {
          drift.push(`index ${want.name} is partial=${got.partial === 1} in the database and ${want.where !== undefined} in the snapshot`);
        }
        // An index over an EXPRESSION reports a null column name, and the snapshot carries the
        // expression text in that slot — so a snapshot entry that names no column of the table is
        // exactly the entry the database must report as null.
        const wantColumns = want.columns.map((c) => (columnNames.has(c) ? c : null));
        const gotColumns = (sqlite.pragma(`index_xinfo('${want.name}')`) as IndexColumnRow[])
          .filter((r) => r.key === 1).sort((a, b) => a.seqno - b.seqno).map((r) => r.name);
        if (JSON.stringify(gotColumns) !== JSON.stringify(wantColumns)) {
          drift.push(`index ${want.name} covers ${JSON.stringify(gotColumns)} in the database and ${JSON.stringify(wantColumns)} in the snapshot`);
        }
      }
      for (const name of built.keys()) if (!declared.indexes[name]) drift.push(`index ${name} on ${table} is in the database and not in the snapshot`);

      // foreign_key_list carries no constraint NAME, so both sides are reduced to the tuple that
      // actually governs a delete: which columns point where, and what happens to the child row.
      const grouped = new Map<number, ForeignKeyRow[]>();
      for (const r of sqlite.pragma(`foreign_key_list('${table}')`) as ForeignKeyRow[]) {
        grouped.set(r.id, [...(grouped.get(r.id) ?? []), r]);
      }
      const gotFks = new Set([...grouped.values()].map((g) => {
        const cols = [...g].sort((a, b) => a.seq - b.seq);
        const first = cols[0] as ForeignKeyRow;
        return fkTuple(cols.map((r) => r.from), first.table, cols.map((r) => r.to), first.on_delete, first.on_update);
      }));
      const wantFks = new Set(Object.values(declared.foreignKeys)
        .map((f) => fkTuple(f.columnsFrom, f.tableTo, f.columnsTo, f.onDelete, f.onUpdate)));
      for (const f of wantFks) if (!gotFks.has(f)) drift.push(`foreign key ${table}.${f} is in the snapshot and not in the database`);
      for (const f of gotFks) if (!wantFks.has(f)) drift.push(`foreign key ${table}.${f} is in the database and not in the snapshot`);

      // No pragma reports CHECK constraints; the table's own CREATE text is the only place they show.
      const row = sqlite.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table) as { sql: string } | undefined;
      for (const name of Object.keys(declared.checkConstraints)) {
        if (!(row?.sql ?? "").includes(name)) drift.push(`CHECK constraint ${name} on ${table} is in the snapshot and not in the database`);
      }
    }
    expect(drift, drift.join("; ")).toEqual([]);
  });
});
