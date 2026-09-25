// WHICH RUN MAY BE RETRIED, SKIPPED OR ABORTED, and from which step — the executor's recovery
// gate, pulled out of executor.ts so it can be read and tested as the rule it is.
//
// A failed run recovers from its failed step. A run CANCELLED after it started recovers the same way
// (hostyour-manager#203): a cancel interrupts a step (it then stands failed, error "aborted") or
// lands in the gap before one (it stands pending, with "✕ cancelled before" in the log), so the step
// such a run resumes from is the first that is neither ok nor skipped. A plan discarded before its
// approve ran nothing and holds no secrets — it is planned again, not resumed. Before #203 a
// cancelled run was terminal: a deploy-slave cancelled in its machine layer had moved the master's
// marking and could be neither finished nor taken back.
import { eq, and, inArray } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { steps } from "../db/schema/runs.ts";
import type { RunStatus, StepStatus } from "../../shared/enums.ts";
import { errValidation } from "../kernel/errors.ts";

export type StepRef = { id: string; name: string; status: StepStatus; ordinal: number };

/** Whether a run may be retried, skipped or aborted: failed, or cancelled AFTER it started. */
export function assertRecoverable(run: { id: string; status: RunStatus; startedAt: Date | null }, act: string): void {
  if (run.status === "failed") return;
  if (run.status === "cancelled" && run.startedAt !== null) return;
  throw errValidation(run.status === "cancelled"
    ? `run ${run.id} was discarded before it started — nothing to ${act}; plan it again`
    : `run ${run.id} is not failed/cancelled`);
}

/** The step a run resumes from when none is named: a failed run's first failed step; a cancelled
 *  run's first step that is neither ok nor skipped. A cancelled run whose every step is ok or skipped
 *  is a finished cleanup run (execute's isCleanupRun end), and there is nothing of it to resume. */
export function stepToResume(db: Db, runId: string, status: RunStatus): StepRef {
  const wanted: StepStatus[] = status === "cancelled" ? ["failed", "pending"] : ["failed"];
  const row = db.select().from(steps).where(and(eq(steps.runId, runId), inArray(steps.status, wanted))).orderBy(steps.ordinal).get();
  if (!row) {
    throw errValidation(status === "cancelled"
      ? `run ${runId} has no step left to resume — every step of it is ok or skipped`
      : `run ${runId} has no failed step to retry`);
  }
  return { id: row.id, name: row.name, status: row.status, ordinal: row.ordinal };
}
