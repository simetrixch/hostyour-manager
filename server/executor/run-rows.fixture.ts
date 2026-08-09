import type { DbHandle } from "../db/client.ts";
import { runs, steps } from "../db/schema/runs.ts";
import type { RunKind } from "../../shared/enums.ts";

// The run and step rows a RunContext writes its log against, for tests that drive a context
// directly instead of going through the Executor.
//
// It lives here rather than beside the tests that use it because the boundary law gives the runs
// schema exactly one owner: `only-executor-touches-runs-schema` (.dependency-cruiser.cjs) forbids
// every module outside server/executor from importing it, tests included. A test under
// server/domains that seeded these rows itself would be the second writer that rule exists to
// prevent.
//
// Why the rows are needed at all: events.run_id and events.step_id are foreign keys, so the moment
// a context logs anything — and it logs the address of every session it opens — a context without
// them fails on the constraint. In production the Executor has written both before it builds one.

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
