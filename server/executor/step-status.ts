// THE writer of steps.status. Every status change goes through one of the two functions here, and
// each asserts the transition table (transitions.ts) before the UPDATE — so the table is a guard
// rather than a description, and a new call site cannot forget it by writing the column directly.
//
// TWO SHAPES, because the executor writes in two shapes.
//
// setStepStatus is the single-row case: the caller has READ the row and therefore knows its status,
// so the assertion is exact.
//
// setStepStatusIn is the BULK case — abandon-unfinished, crash recovery, retry — where one UPDATE
// touches many rows at once. It cannot read each row and stay one statement, so it inverts the
// problem: the caller names the states the write is legal FROM, every one of them is asserted, and
// the same list becomes the WHERE. A row in any other state is then not matched at all, which is the
// same outcome as a per-row refusal without the read. And because it stays ONE statement, no row can
// change state between the check and the write.
import { and, eq, inArray } from "drizzle-orm";
import { steps } from "../db/schema/runs.ts";
import type { StepStatus } from "../../shared/enums.ts";
import { assertStepTransition } from "./transitions.ts";
import type { Db } from "../db/client.ts";

/** The columns a status change may carry with it. Everything here is bookkeeping ABOUT the change —
 *  never the status itself, which is the one thing these functions own. */
type StepFields = Partial<{
  error: string | null;
  skipReason: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
}>;

/** One row whose current status the caller has read. */
export function setStepStatus(tx: Db, stepId: string, from: StepStatus, to: StepStatus, fields: StepFields = {}): void {
  assertStepTransition(from, to);
  tx.update(steps).set({ status: to, ...fields }).where(eq(steps.id, stepId)).run();
}

/** Every row of one run whose status is in `from`. Each listed state must legally reach `to`, and the
 *  WHERE admits exactly those — so the guard holds for every row the statement touches. */
export function setStepStatusIn(tx: Db, runId: string, from: readonly StepStatus[], to: StepStatus, fields: StepFields = {}): void {
  for (const f of from) assertStepTransition(f, to);
  tx.update(steps).set({ status: to, ...fields }).where(and(eq(steps.runId, runId), inArray(steps.status, from))).run();
}
