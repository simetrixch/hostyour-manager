import Database from "better-sqlite3";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

// The reset wipe (Reset feature): raw SQL on purpose — no schema imports, so the one-writer
// boundary rules (.dependency-cruiser.cjs) stay machine-true; this module is the single
// sanctioned "wipe writer", same layer as the migrator. Order is FK-law — every reference below is
// ON DELETE restrict unless noted, so a child left standing makes its parent's DELETE throw and
// rolls the whole wipe back:
//   events → steps → run_locks → runs   (events/steps cascade off runs, run_locks RESTRICTs runs)
//   credentials → tenant_apps → tenants → apps → clusters → servers
//     (tenant_apps hangs off tenants, tenants and apps both hang off clusters, clusters and
//      credentials off servers)
//   audit last (no FKs; its delete-trigger is dropped for the duration and recreated before commit).
// slaveId ordinals restart at 1 after a wipe — "never reused" is per-epoch; no consumer of old
// ordinals survives a full reset, so the restart is coherent.
const WIPE_ORDER = [
  "events", "steps", "run_locks", "runs",
  "credentials", "tenant_apps", "tenants", "apps", "clusters", "servers",
  // operator_keys references nothing and nothing references it, so its place in the order is free.
  // It is WIPED and not kept: a reset takes the manager back to a fresh install, and a list of
  // human public keys it would go on offering to place on machines it no longer knows is exactly the
  // kind of standing access a reset exists to end. Re-adding one is a paste.
  "operator_keys",
  "audit",
] as const;

// The tables a wipe deliberately leaves standing:
//   operators — op_system/op_emergency are seeded by the BASELINE MIGRATION only and runs.started_by
//     references them, so a wipe would leave every later run without a startable actor.
//   meta — meta.session.key IS the resetting operator's live session, and keystore.mode is what the
//     executor's slaveCryptoGate reads; wiping either signs the operator out mid-reset and makes the
//     gate read "plaintext" whatever mode the keystore is really in.
//   __drizzle_migrations — the migrator's own ledger. Emptied, the next openDb replays the baseline
//     against tables that already exist and the Manager stops booting.
//   unit_sizes — EDITED data, not derived data. The boot seed would refill it, which is exactly the
//     problem: the three rows would come back carrying the SHIPPED figures, silently replacing the
//     ones this installation sells. Nothing could restore them — the registrations in git carry
//     resolved numbers, not the table they came from, so after a wipe the table and the units
//     standing on it would disagree with no record of which was right. A reset ends what the
//     manager KNOWS (its servers, clusters and units); what it SELLS outlives that.
// This list and WIPE_ORDER together must name EVERY table in the database. reset.test.ts checks both
// against sqlite_master, so a table a later migration adds falls into neither list and goes red
// instead of quietly surviving every wipe.
export const KEPT_TABLES = ["operators", "meta", "unit_sizes", "__drizzle_migrations"] as const;

const EVENTS_TRIGGER = "CREATE TRIGGER events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'events is append-only'); END";
const AUDIT_TRIGGER = "CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END";

/** Runs that make a wipe unsafe: an in-flight executor holds in-memory state for them. A
 *  `planned` run is parked and safe to wipe; `planning/approved/running` are live. */
export function countLiveRuns(sqlite: Database.Database): number {
  const row = sqlite.prepare("SELECT count(*) AS c FROM runs WHERE status IN ('planning','approved','running')").get() as { c: number };
  return row.c;
}

/** Snapshot the DB IMMEDIATELY before the wipe (VACUUM INTO cannot run inside a transaction). Keeps
 *  the last 5 backups. Makes wipeDb on a surviving master fully reversible — which holds only while
 *  nothing is awaited between this call and the wipe: a row that lands in that gap is destroyed by a
 *  wipe the snapshot cannot undo. Returns the backup path. */
export function backupManagerDb(sqlite: Database.Database, dataDir: string): string {
  const dir = join(dataDir, "backups");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `pre-reset-${new Date().toISOString().replaceAll(/[:.]/g, "-")}.db`);
  sqlite.exec(`VACUUM INTO '${file.replaceAll("'", "''")}'`);
  const old = readdirSync(dir).filter((f) => f.startsWith("pre-reset-")).sort();
  for (const f of old.slice(0, -5)) rmSync(join(dir, f));
  return file;
}

// The wipe itself, inside whatever transaction the caller opened. Shared by the real wipe and the
// rehearsal below so the two can never run different statements — a rehearsal that exercises
// anything but the wipe proves nothing about the wipe.
function wipeInFkOrder(sqlite: Database.Database): Record<string, number> {
  const rows: Record<string, number> = {};
  sqlite.exec("DROP TRIGGER events_no_delete");
  sqlite.exec("DROP TRIGGER audit_no_delete");
  for (const table of WIPE_ORDER) rows[table] = sqlite.prepare(`DELETE FROM ${table}`).run().changes;
  sqlite.exec(EVENTS_TRIGGER);
  sqlite.exec(AUDIT_TRIGGER);
  return rows;
}

/** ONE immediate transaction: drop the two append-only DELETE triggers, wipe in FK order, recreate
 *  the triggers with text identical to the baseline migration's. DDL is transactional in SQLite, so
 *  a failure anywhere rolls back the triggers too. Returns rows deleted per table. */
export function wipeManagerDb(sqlite: Database.Database): Record<string, number> {
  let rows: Record<string, number> = {};
  sqlite.transaction(() => {
    rows = wipeInFkOrder(sqlite);
  }).immediate();
  return rows;
}

/** Run the whole wipe and throw the result away: BEGIN IMMEDIATE, the statements above, ROLLBACK.
 *  Every way the wipe can fail surfaces here instead of there — a child row held down by a table
 *  missing from WIPE_ORDER, a trigger whose name has moved, a database that cannot be written — and
 *  the caller can still refuse without having destroyed anything. Throws what the wipe would throw.
 *
 *  BEGIN/ROLLBACK by hand rather than better-sqlite3's transaction(): that helper COMMITS when its
 *  function returns and rolls back only by throwing, so discarding a SUCCESSFUL rehearsal through it
 *  means throwing an error the caller then has to tell apart from a real one. */
export function rehearseManagerDbWipe(sqlite: Database.Database): void {
  sqlite.exec("BEGIN IMMEDIATE");
  try {
    wipeInFkOrder(sqlite);
  } finally {
    // Some statement errors roll the transaction back themselves; ROLLBACK then throws "cannot
    // rollback - no transaction is active" out of the finally block and replaces the failure that is
    // worth reporting with a meaningless one.
    if (sqlite.inTransaction) sqlite.exec("ROLLBACK");
  }
}
