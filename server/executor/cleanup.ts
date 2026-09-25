// cleanup.ts — the STEP BOOKKEEPING of abort-with-cleanup, split out of executor.ts
// the way transitions/locks/guards/secrets/plan-hash already are: the Executor keeps the policy (which
// runs may be aborted, which definition supplies the compensations, when to re-enter the run loop) and
// this module owns the persisted-row mechanics that make the compensation VISIBLE as ordinary steps.
//
// Two rules are encoded here and nowhere else, because getting either wrong strands a run:
//   1. RUN ORDER. A run's registered cleanups are collected step-by-step from the LAST step backwards,
//      so a later step's compensation undoes its mutation before an earlier step's does. Within ONE
//      step the names keep their registration order — which is how a run that arms a whole ordered
//      teardown from a single step (create-tenant) gets that teardown back in the
//      order it was written.
//   2. NOTHING PENDING SURVIVES. Every step that did not complete is abandoned first, so the appended
//      cleanup rows are the only pending work the executor's ordinal walk can find.
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { runs, steps } from "../db/schema/runs.ts";
import { stepId as genStepId } from "../kernel/ids.ts";
import type { StepStatus } from "../../shared/enums.ts";
import type { Cleanup } from "./types.ts";
import { setStepStatus, setStepStatusIn } from "./step-status.ts";

/** A persisted step row as the abort path reads it — its checkpoint carries the registered names. */
export interface AbortStepRow {
  id: string;
  name: string;
  status: StepStatus;
  ordinal: number;
  checkpoint: unknown;
}

/** Abandon every step that has not completed. Runs FIRST in both paths below: the steps AFTER the
 *  failure are still `pending`, and execute() walks the persisted rows in ORDINAL order, so leaving
 *  them pending re-runs them BEFORE the appended cleanups — on create-tenant, `smoke` would re-check
 *  the very namespace whose fan-out just failed to converge, fail again, and the compensation would
 *  never be reached. It is also the invariant a TERMINAL run must satisfy: no step left pending. */
function abandonUnfinished(tx: Db, runId: string): void {
  // Every state BUT ok, named explicitly rather than as `ne(status, "ok")`: the guard asserts each
  // one reaches skipped, and the same list becomes the WHERE, so an ok row is not merely skipped
  // by a negation — it is outside the statement.
  setStepStatusIn(tx, runId, ["pending", "running", "failed", "skipped"], "skipped", { skipReason: "aborted" });
}

/** The cleanup names this run REGISTERED, in the order they must RUN: reverse REGISTRATION order, which
 *  is reverse STEP order with each step's own names kept as registered (see rule 1 in the header). */
export function registeredCleanupNames(all: readonly AbortStepRow[]): string[] {
  const names: string[] = [];
  for (const s of [...all].reverse()) {
    const cp = s.checkpoint as { __cleanups?: string[] } | null;
    for (const name of cp?.__cleanups ?? []) names.push(name);
  }
  return names;
}

/** Nothing was ever registered, so there is nothing to compensate: abandon the unfinished steps and
 *  settle the run cancelled straight away. */
export function settleAbortWithoutCleanup(db: Db, runId: string): void {
  db.transaction((tx) => {
    abandonUnfinished(tx, runId);
    tx.update(runs).set({ status: "cancelled", finishedAt: new Date() }).where(eq(runs.id, runId)).run();
  });
}

/** Append the compensations as visible pending steps after the run's last ordinal and hand the run back
 *  to the executor loop (status `running`). `byName` resolves each persisted name to its live
 *  implementation for the TITLE only — a name the definition no longer supplies still gets a row, so the
 *  operator sees that a compensation was registered and could not be resolved, rather than nothing.
 *
 *  Idempotent by design: a SECOND abort must REUSE the row the first one wrote (and which
 *  abandonUnfinished just marked). Inserting it again violates steps_run_name_uq, throws out of the
 *  transaction into the route, and leaves the run permanently un-abortable. */
export function scheduleCleanupSteps(
  db: Db,
  runId: string,
  all: readonly AbortStepRow[],
  names: readonly string[],
  byName: ReadonlyMap<string, Cleanup>,
): void {
  const existingByName = new Map(all.map((s) => [s.name, s]));
  const maxOrdinal = Math.max(...all.map((s) => s.ordinal));
  db.transaction((tx) => {
    abandonUnfinished(tx, runId);
    names.forEach((name, i) => {
      const c = byName.get(name);
      const stepName = `cleanup:${name}`;
      const existing = existingByName.get(stepName);
      if (existing) {
        // The ONE place a step leaves ok, and the transition table names this site as the reason:
        // between two aborts the run was retried and did NEW work, so a compensation that already
        // succeeded has something to clean up again. Cleanups are built idempotent for this.
        setStepStatus(tx, existing.id, existing.status, "pending", { error: null, skipReason: null, startedAt: null, finishedAt: null });
        return;
      }
      tx.insert(steps).values({ id: genStepId(), runId, ordinal: maxOrdinal + 1 + i, name: stepName, title: c ? `Cleanup: ${c.title}` : `Cleanup: ${name}`, status: "pending" }).run();
    });
    tx.update(runs).set({ status: "running", error: null, finishedAt: null }).where(eq(runs.id, runId)).run();
  });
}
