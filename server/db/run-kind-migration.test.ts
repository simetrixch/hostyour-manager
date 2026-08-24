import { describe, it, expect, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RUN_KIND } from "../../shared/enums.ts";

// The run-kind rename is a STORED-VALUE change: `runs.kind` is a plain text column with no CHECK
// (server/db/schema/runs.ts), so every RUN_KIND literal is a value already written into rows, and
// 0001_run_kind_families.sql is what carries those rows across. This proves it on a database, not on
// the SQL's shape: a row is planted under each old spelling, the migration runs, and the row is read
// back under the new one — and beside it a row the migration must not touch, read back unchanged.
//
// The migrations are applied the way the migrator applies them — the entries of meta/_journal.json in
// idx order, each file split on the `--> statement-breakpoint` marker drizzle writes. Nothing here
// hard-codes a file name or an order, so a migration added after this one is picked up rather than
// silently skipped.

const MIGRATIONS = fileURLToPath(new URL("./migrations", import.meta.url));

interface JournalEntry { idx: number; tag: string; when: number }

function journal(): JournalEntry[] {
  const raw = JSON.parse(readFileSync(join(MIGRATIONS, "meta/_journal.json"), "utf8")) as { entries: JournalEntry[] };
  return [...raw.entries].sort((a, b) => a.idx - b.idx);
}

const THIS_MIGRATION = "0001_run_kind_families";

function migrationSql(tag: string): string {
  return readFileSync(join(MIGRATIONS, `${tag}.sql`), "utf8");
}

/** Execute one migration file exactly as the migrator does: statement by statement. */
function apply(sqlite: Database.Database, tag: string): void {
  for (const statement of migrationSql(tag).split("--> statement-breakpoint")) {
    if (statement.trim().length > 0) sqlite.exec(statement);
  }
}

/** A database standing at every migration STRICTLY BEFORE this one — the state a row carrying an old
 *  spelling was written in. */
function beforeThisMigration(sqlite: Database.Database): void {
  for (const entry of journal()) {
    if (entry.tag === THIS_MIGRATION) return;
    apply(sqlite, entry.tag);
  }
  throw new Error(`${THIS_MIGRATION} is not registered in meta/_journal.json`);
}

/** The (old, new) pairs the migration is driven by, read out of the migration's own VALUES table. */
function renames(): { old: string; next: string }[] {
  const body = migrationSql(THIS_MIGRATION);
  const values = body.slice(body.indexOf("WITH renamed(old_kind, new_kind) AS (VALUES"), body.indexOf("UPDATE runs"));
  return [...values.matchAll(/\('([a-z-]+)', '([a-z-]+)'\)/g)].map((m) => ({ old: m[1] as string, next: m[2] as string }));
}

interface SeededRun {
  id: string;
  kind: string;
  planJson: string | null;
  status: string;
}

function seed(sqlite: Database.Database, rows: SeededRun[]): void {
  const insert = sqlite.prepare(
    "INSERT INTO runs (id, kind, target_kind, target_id, params_json, plan_json, status, started_by) VALUES (?,?,?,?,?,?,?,?)",
  );
  for (const r of rows) insert.run(r.id, r.kind, "server", "srv_x", "{}", r.planJson, r.status, "op_system");
}

function readRun(sqlite: Database.Database, id: string): { kind: string; plan_json: string | null } {
  return sqlite.prepare("SELECT kind, plan_json FROM runs WHERE id = ?").get(id) as { kind: string; plan_json: string | null };
}

describe("0001_run_kind_families — the rows written under the old spellings", () => {
  const dirs: string[] = [];
  const open: Database.Database[] = [];
  afterEach(() => {
    for (const s of open.splice(0)) s.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function fresh(): Database.Database {
    const dir = mkdtempSync(join(tmpdir(), "ctrl-runkind-"));
    dirs.push(dir);
    const sqlite = new Database(join(dir, "manager.db"));
    open.push(sqlite);
    beforeThisMigration(sqlite);
    return sqlite;
  }

  it("is registered in the journal after the entry before it, and carries a head snapshot", () => {
    const entries = journal();
    const at = entries.findIndex((e) => e.tag === THIS_MIGRATION);
    expect(at, `${THIS_MIGRATION} is not in meta/_journal.json`).toBeGreaterThan(0);
    // The migrator's ONLY gate is `when` against the newest applied entry, so an entry stamped no
    // later than the one before it is an entry an existing database silently skips.
    expect((entries[at] as JournalEntry).when).toBeGreaterThan((entries[at - 1] as JournalEntry).when);
    // schema-census.test.ts diffs the schema against the HEAD snapshot, named for the head idx.
    const head = entries.reduce((a, b) => (b.idx > a.idx ? b : a));
    expect(() => readFileSync(join(MIGRATIONS, `meta/${String(head.idx).padStart(4, "0")}_snapshot.json`), "utf8")).not.toThrow();
  });

  it("maps only spellings the code has dropped, and only onto spellings it now has", () => {
    const pairs = renames();
    expect(pairs.length).toBeGreaterThan(20);
    const members = new Set<string>(RUN_KIND);
    for (const { old, next } of pairs) {
      expect(members.has(next), `${next} is not a RUN_KIND literal — the migration would file a row under a kind nothing can run`).toBe(true);
      expect(members.has(old), `${old} is still a RUN_KIND literal — the migration would rewrite a live kind away`).toBe(false);
    }
    expect(new Set(pairs.map((p) => p.old)).size, "an old spelling is mapped twice").toBe(pairs.length);
    expect(new Set(pairs.map((p) => p.next)).size, "two old spellings land on one new one").toBe(pairs.length);
  });

  it("PLANTED DEFECT: a row under each old spelling arrives under the new one, in the column AND in the frozen plan", () => {
    const sqlite = fresh();
    const pairs = renames();
    seed(sqlite, pairs.map(({ old }, i) => ({
      id: `run_${i}`,
      kind: old,
      planJson: JSON.stringify({ kind: old, targetId: "srv_x", summary: `a ${old} run`, planHash: "sha", plannedAt: 1 }),
      status: "succeeded",
    })));

    // RED FIRST: as planted, not one of these rows names a run kind this code can run.
    const members = new Set<string>(RUN_KIND);
    const planted = sqlite.prepare("SELECT kind FROM runs").all() as { kind: string }[];
    expect(planted.filter((r) => members.has(r.kind)), "the planted rows already carry new spellings — the probe proves nothing").toEqual([]);

    apply(sqlite, THIS_MIGRATION);

    for (const [i, { old, next }] of pairs.entries()) {
      const row = readRun(sqlite, `run_${i}`);
      expect(row.kind, `${old} did not arrive`).toBe(next);
      expect(JSON.parse(row.plan_json as string), `${old}'s frozen plan did not arrive`).toMatchObject({ kind: next, summary: `a ${old} run` });
    }
  });

  it("INNOCENT CASE: a row the migration must not touch comes back byte-identical", () => {
    const sqlite = fresh();
    const untouched: SeededRun[] = [
      // Belongs to no family and is spelled bare on purpose.
      { id: "run_noop", kind: "noop", planJson: JSON.stringify({ kind: "noop", summary: "fixture" }), status: "succeeded" },
      // Already carried its family before this change — nothing may rewrite it a second time.
      { id: "run_tenant", kind: "tenant-suspend", planJson: JSON.stringify({ kind: "tenant-suspend", summary: "hold" }), status: "succeeded" },
      // A streaming plan that failed validation: plan_json holds the report, which carries no kind.
      { id: "run_report", kind: "tenant-suspend", planJson: JSON.stringify({ findings: ["nope"] }), status: "failed" },
      // A run still planning has no plan at all.
      { id: "run_planning", kind: "tenant-suspend", planJson: null, status: "planning" },
      // A column is text: whatever is in it that is not JSON must not make the migration throw.
      { id: "run_garbage", kind: "noop", planJson: "not json at all", status: "failed" },
    ];
    seed(sqlite, untouched);
    const before = untouched.map((r) => readRun(sqlite, r.id));

    apply(sqlite, THIS_MIGRATION);

    for (const [i, r] of untouched.entries()) expect(readRun(sqlite, r.id), r.id).toEqual(before[i]);
  });

  it("is idempotent and loses no row: a second application changes nothing", () => {
    const sqlite = fresh();
    const pairs = renames();
    seed(sqlite, [
      ...pairs.map(({ old }, i) => ({ id: `run_${i}`, kind: old, planJson: JSON.stringify({ kind: old }), status: "succeeded" })),
      { id: "run_noop", kind: "noop", planJson: JSON.stringify({ kind: "noop" }), status: "succeeded" },
    ]);
    const count = (): number => (sqlite.prepare("SELECT count(*) AS n FROM runs").get() as { n: number }).n;
    const planted = count();

    apply(sqlite, THIS_MIGRATION);
    const once = sqlite.prepare("SELECT id, kind, plan_json FROM runs ORDER BY id").all();
    apply(sqlite, THIS_MIGRATION);

    expect(sqlite.prepare("SELECT id, kind, plan_json FROM runs ORDER BY id").all()).toEqual(once);
    expect(count()).toBe(planted);
  });

  it("leaves the append-only audit record alone — it says what was true when it was written", () => {
    const sqlite = fresh();
    sqlite
      .prepare("INSERT INTO audit (id, actor, action, detail_json) VALUES (?,?,?,?)")
      .run("aud_1", "op_1", "run.planned", JSON.stringify({ kind: "backup", summary: "a backup run" }));
    seed(sqlite, [{ id: "run_b", kind: "backup", planJson: JSON.stringify({ kind: "backup" }), status: "succeeded" }]);

    apply(sqlite, THIS_MIGRATION);

    // The run moved; the record of the moment it was planned did not — and could not: the
    // audit_no_update trigger aborts any UPDATE reaching that table.
    expect(readRun(sqlite, "run_b").kind).toBe("consumer-backup");
    const audit = sqlite.prepare("SELECT detail_json FROM audit WHERE id = 'aud_1'").get() as { detail_json: string };
    expect(JSON.parse(audit.detail_json)).toEqual({ kind: "backup", summary: "a backup run" });
  });
});
