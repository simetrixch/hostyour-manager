import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { fileURLToPath } from "node:url";

export type Db = BetterSQLite3Database;
export interface DbHandle {
  db: Db;
  sqlite: Database.Database;
}

const MIGRATIONS_DIR = fileURLToPath(new URL("./migrations", import.meta.url));

/**
 * Open the controller DB and run the explicit migration phase:
 * pragmas → foreign_keys OFF (outside any tx) → migrate() → foreign_keys ON →
 * assert foreign_key_check empty + integrity_check ok. Future rebuild migrations
 * (table copy/drop/recreate) are therefore true by construction.
 *
 * `drizzle(sqlite)` is created WITHOUT a central schema object on purpose: each module
 * imports only the tables it is allowed to touch (the boundary law), so there is no
 * schema barrel and no way to reach `runs` from outside the executor.
 */
export function openDb(file: string): DbHandle {
  const sqlite = new Database(file);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("busy_timeout = 5000");
  sqlite.pragma("synchronous = NORMAL");

  sqlite.pragma("foreign_keys = OFF"); // must be outside any transaction
  const db = drizzle(sqlite);
  migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  sqlite.pragma("foreign_keys = ON");

  const fkViolations = sqlite.pragma("foreign_key_check") as unknown[];
  if (fkViolations.length > 0) {
    throw new Error(`foreign_key_check failed after migrate: ${JSON.stringify(fkViolations)}`);
  }
  const integrity = sqlite.pragma("integrity_check", { simple: true });
  if (integrity !== "ok") {
    throw new Error(`integrity_check failed after migrate: ${String(integrity)}`);
  }
  return { db, sqlite };
}
