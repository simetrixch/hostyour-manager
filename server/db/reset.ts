import Database from "better-sqlite3";

// The reset's one database read, as raw SQL beside the migrator: the reset domain writes nothing
// here and imports no schema.

/** Runs that make a reset unsafe: a live run may push to an install branch the reset deletes. A
 *  `planned` run is parked and pushes nothing until it is approved; `planning/queued/approved/running`
 *  are live. */
export function countLiveRuns(sqlite: Database.Database): number {
  const row = sqlite.prepare("SELECT count(*) AS c FROM runs WHERE status IN ('planning','queued','approved','running')").get() as { c: number };
  return row.c;
}
