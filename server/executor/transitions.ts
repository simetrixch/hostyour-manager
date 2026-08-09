import type { RunStatus, StepStatus } from "../../shared/enums.ts";
import { errIllegalTransition } from "../kernel/errors.ts";

// Exhaustive legal-transition tables: every RunStatus and every StepStatus lists the states it may
// move to, and anything not listed throws IllegalTransition. A missing entry does not loosen the
// machine, it closes it — a state whose successor is not written down can never be left, so a run
// would strand there. Implemented as tables, not ifs — unit-tested for every (from → to), legal and
// illegal.

const RUN_TRANSITIONS: Record<RunStatus, readonly RunStatus[]> = {
  planning: ["planned", "failed", "cancelled"], // async validation → plan | interrupted | discarded
  planned: ["approved", "cancelled"],
  approved: ["running"],
  running: ["succeeded", "failed", "cancelled"],
  failed: ["running"], // recovery: retry / skip / abort
  succeeded: [], // terminal
  cancelled: [], // terminal
};

// The step table's ONE invariant: `ok` is reachable ONLY from `running`. No path may declare a step
// done that was never started, and every other rule here is permissive by comparison.
//
// The reverse — that nothing ever LEAVES ok — is true of every path except one, and that exception is
// deliberate. A second abortWithCleanup resets the cleanup steps of the first one, ok included
// (cleanup.ts scheduleCleanupSteps): between the two aborts the run was retried and did NEW work, so
// the same compensation has something to clean up again. Cleanups are built idempotent for exactly
// this. Every OTHER path excludes ok by construction, and the guard is what keeps that difference
// visible instead of leaving it as a habit repeated in eight places.
//
// The rest is deliberately permissive, because the executor really does move steps that way and a
// table that forbids what the code does is not a guard, it is a bug waiting for the first retry:
//   · retry (executor.retryFrom) resets EVERY non-ok step from the target ordinal on — so pending,
//     running, failed and skipped all reach pending.
//   · skipStep is offered on a FAILED step (its own guard refuses anything else), so failed → skipped.
//   · abandon-unfinished (cleanup) skips every non-ok step of an aborted run.
//   · a step whose implementation is missing fails from whatever state the walk found it in.
const STEP_TRANSITIONS: Record<StepStatus, readonly StepStatus[]> = {
  pending: ["running", "skipped", "failed", "pending"],
  running: ["ok", "failed", "pending", "skipped"],
  ok: ["pending"], // ONLY for a second abort's cleanup reset — see the note above
  failed: ["pending", "running", "skipped", "failed"],
  skipped: ["pending", "skipped"],
};

export function canRunTransition(from: RunStatus, to: RunStatus): boolean {
  return RUN_TRANSITIONS[from].includes(to);
}

export function assertRunTransition(from: RunStatus, to: RunStatus): void {
  if (!canRunTransition(from, to)) throw errIllegalTransition(`run status ${from} → ${to}`);
}

export function canStepTransition(from: StepStatus, to: StepStatus): boolean {
  return STEP_TRANSITIONS[from].includes(to);
}

export function assertStepTransition(from: StepStatus, to: StepStatus): void {
  if (!canStepTransition(from, to)) throw errIllegalTransition(`step status ${from} → ${to}`);
}

export const isTerminalRun = (s: RunStatus): boolean => s === "succeeded" || s === "cancelled";

// Deletion is NOT a transition — it removes the run from the operator's view (SOFT
// delete: deleted_at set, row + full log retained in the DB). Any SETTLED run is
// deletable — planned (never executed), failed (stopped mid-way), cancelled/discarded, or
// succeeded (the owner may tidy the run list). Only an in-flight run (planning/approved/
// running) is refused; it must settle first. A run is NEVER hard-deleted, and soft-delete
// never tears anything down: a soft-deleted succeeded onboard/deploy leaves its inventory
// row + git pointer live (the deployed thing keeps running) — teardown is the separate
// offboard/remove run, never a side effect of hiding a run from the list.
export const isDeletableRun = (s: RunStatus): boolean =>
  s === "planned" || s === "failed" || s === "cancelled" || s === "succeeded";
