import type { DbHandle } from "../db/client.ts";
import { runs, steps } from "../db/schema/runs.ts";
import type { RunKind } from "../../shared/enums.ts";

// The tests' access to the run and step rows: seeding them for a test that drives a RunContext
// directly instead of going through the Executor, and reading back one column of one step a real
// run left behind.
//
// It lives here rather than beside the tests that use it because the boundary law gives the runs
// schema exactly one owner: `only-executor-touches-runs-schema` (.dependency-cruiser.cjs) forbids
// every module outside server/executor from importing it, tests included. A test under
// server/domains that seeded these rows itself would be the second writer that rule exists to
// prevent, and one that read them itself would put a second reader of the column layout where
// nothing keeps it in step with the schema.
//
// Why the seeded rows are needed at all: events.run_id and events.step_id are foreign keys, so the
// moment a context logs anything — and it logs the address of every session it opens — a context
// without them fails on the constraint. In production the Executor has written both before it
// builds one.

/** Seed one running run plus one step row per id, so a RunContext built on `runId` can log.
 *  `op_system` is the seeded actor for a run no human started (db/migrations/0000_baseline.sql). */
export function seedRunRows(
  db: DbHandle,
  o: { runId: string; kind?: RunKind; targetId?: string; steps: readonly { id: string; name: string }[] },
): void {
  db.db.insert(runs).values({
    id: o.runId,
    kind: o.kind ?? "noop",
    targetKind: "server",
    targetId: o.targetId ?? "srv_seed",
    paramsJson: {},
    planJson: {},
    status: "running",
    startedBy: "op_system",
  }).run();
  o.steps.forEach((s, ordinal) => {
    db.db.insert(steps).values({ id: s.id, runId: o.runId, ordinal, name: s.name, title: s.name }).run();
  });
}

/** ONE column of ONE named step of a run, as the column holds it — `null` where the run has no step
 *  by that name, which a caller must read as "the run never got that far", never as "the step left
 *  nothing". The stored TEXT and not a parsed value: `checkpoint_json` is what the step wrote, and a
 *  test that asserts on it is asserting on the record an operator and the cleanup pass both read. */
export function stepColumn(db: DbHandle, runId: string, name: string, column: "error" | "checkpoint_json"): string | null {
  const row = db.sqlite
    .prepare(`SELECT ${column} AS v FROM steps WHERE run_id = ? AND name = ?`)
    .get(runId, name) as { v: string | null } | undefined;
  return row?.v ?? null;
}
