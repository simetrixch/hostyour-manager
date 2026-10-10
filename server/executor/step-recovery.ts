import { eq, and, gte } from "drizzle-orm";
import { runs, steps } from "../db/schema/runs.ts";
import { writeAudit } from "../db/audit-writer.ts";
import { errValidation } from "../kernel/errors.ts";
import type { StepStatus } from "../../shared/enums.ts";
import { assertRecoverable, stepToResume } from "./recover.ts";
import { acquireLocks, releaseLocks } from "./locks.ts";
import { planClaims } from "./queue.ts";
import { isMutatingPrecondition } from "./guards.ts";
import { registeredCleanupNames, settleAbortWithoutCleanup, scheduleCleanupSteps } from "./cleanup.ts";
import { setStepStatus } from "./step-status.ts";
import { appendRunMeta } from "./run-meta.ts";
import type { ExecutorDeps, LoadedRun } from "./executor.ts";
import { runActor } from "../kernel/actor.ts";

export interface RecoveryHost {
  readonly deps: ExecutorDeps;
  loadRun(runId: string): LoadedRun;
  stepRowFull(runId: string, name: string): { id: string; name: string; status: StepStatus; ordinal: number };
  allStepRows(runId: string): { id: string; name: string; title: string; status: StepStatus; ordinal: number; checkpoint: unknown }[];
  storeSecrets(runId: string, secrets?: Record<string, Buffer>): void;
  fireExecute(runId: string): Promise<void>;
  dispatchQueue(): void;
}

/** Retry a failed run from a step. Resets that step and everything after
 *  it that is not already ok to pending (keeping checkpoints), then re-executes.
 *
 *  It needs no counterpart to skipStep's precondition refusal below, and the reason is structural, not
 *  an oversight: a retry NEVER marks a step ok or skipped, and execute()'s loop re-runs every persisted
 *  row that is not one of those two, in ordinal order. So a mutating run's attest-target that FAILED is
 *  re-asked on the next execute whichever step the retry names — even a retry aimed at a later step
 *  (`stepName`) leaves the failed precondition row untouched at ordinal 0 and the loop walks into it
 *  first. Skipping was the only way to walk past a precondition without asking it. */
export async function retryFromStep(
  host: RecoveryHost,
  runId: string,
  stepName?: string,
  secrets?: Record<string, Buffer>,
): Promise<void> {
  const run = host.loadRun(runId);
  assertRecoverable(run, "retry");
  const target = stepName ? host.stepRowFull(runId, stepName) : stepToResume(host.deps.db, runId, run.status);
  if (target.status !== "failed" && target.status !== "skipped" && target.status !== "pending") {
    throw errValidation(`cannot retry from step ${target.name} (status ${target.status})`);
  }
  acquireLocks(host.deps.db, runId, planClaims(run.plan));
  host.deps.db.transaction((tx) => {
    const later = tx.select().from(steps).where(and(eq(steps.runId, runId), gte(steps.ordinal, target.ordinal))).all();
    for (const s of later) {
      if (s.status !== "ok") {
        setStepStatus(tx, s.id, s.status, "pending", { error: null, startedAt: null, finishedAt: null });
      }
    }
    tx.update(runs).set({ status: "running", error: null, finishedAt: null }).where(eq(runs.id, runId)).run();
  });
  writeAudit(host.deps.db, { action: "run.step_retried", runId, detail: { step: target.name } });
  host.storeSecrets(runId, secrets);
  host.fireExecute(runId);
}

/** Skip the failed step and continue with the next pending one. A run
 *  that finishes with skipped steps still ends succeeded — EXCEPT on the one step no operator may
 *  wave through: a MUTATING run's fail-closed precondition (step 0, attest-target).
 *
 *  WHY that step is not ordinary work. A precondition is not a task that can be "handled manually on
 *  the box" (the skip's own example reason) — it is the run re-asking, against the world AS IT IS NOW,
 *  whether it may mutate at all. tenant-purge's attest-target re-asks the live-tenant refusal
 *  (tenant-live-guard.ts) precisely because the plan-time refusal on the route answers a question about
 *  PLAN time only: a purge legitimately planned against a "provisioning" row stays approvable while a
 *  create-tenant retry settles that row to "active", and approve re-validates nothing. Letting the step
 *  it refuses in be skipped turns that whole belt into two clicks — the run screen feeds its skip dialog
 *  exactly the failed steps, so the operator who was just refused marks the refusal skipped, execute()'s
 *  loop passes over skipped rows, and the run walks into the pointer removal, delete-tenant-cr and
 *  delete-namespace against the live, serving tenant the gate refused. There is no legitimate override:
 *  a precondition that refuses states something about the WORLD, so the way past it is to change the
 *  world and retry the step, or to abandon the run (abort, or delete it) — never to declare it done.
 *
 *  WHY THIS SHAPE. The alternative was to re-ask the definition here, the way abortWithCleanup asks
 *  assertAbortable. Refusing outright is the one that GENERALISES: it rests on that invariant alone
 *  (guards.assertGuardsArmed pins step 0 of every mutating def to attest-target, at boot), so every
 *  mutating kind — including the next one somebody registers, whose author never thought about this
 *  path — is fail-closed on day one, with no per-definition hook to remember. A second hook would have
 *  closed it for tenant-purge and left the same two clicks open everywhere else. It also removes the
 *  asymmetry that made this a defect: the SAME live-tenant rule on the abort path is asserted by the
 *  executor BEFORE any step row exists (assertAbortable) and was therefore always unskippable. */
export async function skipStep(host: RecoveryHost, runId: string, stepName: string, reason: string): Promise<void> {
  const run = host.loadRun(runId);
  assertRecoverable(run, "skip");
  if (!reason.trim()) throw errValidation("a skip reason is required");
  const step = host.stepRowFull(runId, stepName);
  if (step.status !== "failed") throw errValidation(`step ${stepName} is not the failed step`);
  // Asked on the DEFINITION's mutating flag + the step name (guards.isMutatingPrecondition), never on
  // the kind: the executor stays domain-agnostic and learns nothing about tenants, consumers or slaves.
  if (isMutatingPrecondition(host.deps.runDefinitions.get(run.kind), step.name)) {
    throw errValidation(
      `step ${stepName} is the fail-closed precondition of this ${run.kind} run — it cannot be skipped. ` +
        "It refused because of what it found in the world, not because of anything this run did, and every step after it mutates. " +
        "Fix what it refused and retry the step, or abort/delete the run.",
    );
  }
  acquireLocks(host.deps.db, runId, planClaims(run.plan));
  host.deps.db.transaction((tx) => {
    setStepStatus(tx, step.id, step.status, "skipped", { skipReason: reason });
    tx.update(runs).set({ status: "running", error: null, finishedAt: null }).where(eq(runs.id, runId)).run();
  });
  writeAudit(host.deps.db, { action: "run.step_skipped", runId, detail: { step: stepName, reason } });
  appendRunMeta(host.deps.db, host.deps.bus, runId, `⏭ skipped by ${runActor()}: ${reason}`);
  host.fireExecute(runId);
}

/** Turn registered cleanups into visible steps that run in reverse registration order, ending the run
 *  cancelled. The POLICY lives here — only a failed/cancelled run may be aborted, and
 *  the run's own definition supplies the compensations; the persisted-row mechanics (run order,
 *  abandoning the unfinished steps, the idempotent re-abort) live in cleanup.ts.
 *
 *  Two things are deliberately ordered around the "nothing was ever registered" early return.
 *
 *  (1) THE DEFINITION'S OWN PRECONDITION. A cleanup is a MUTATION, so the run STATUS is not the whole
 *  question: it says the run stopped, never what undoing it would take off the cluster. The executor is
 *  domain-agnostic and must not learn that, so it asks the definition (assertAbortable) and a refusal
 *  throws out to the caller before a single cleanup row is written — for every caller of the abort, not
 *  for one route. It is asked only on the path that HAS compensations, because that is the only path
 *  that mutates anything.
 *
 *  (2) PARAMS ARE PARSED ONLY WHERE THEY ARE NEEDED. paramsSchema.parse as the FIRST thing this
 *  method does would make a run that never got a usable plan un-abortable: a run that failed while still
 *  `planning` carries only the operator's RAW request (beginStreamingPlan persists it verbatim and only
 *  the settled plan overwrites it) and has no step rows at all, so the parse throws a ZodError at the
 *  operator instead of settling the run cancelled — a guaranteed-failing button on a run that has
 *  nothing to clean up in the first place. The params feed the definition's cleanups + precondition, so
 *  they are parsed there and nowhere else.
 *
 *  `secrets` is retryFromStep's re-entry surface on the abort path: a terminal run's secrets were
 *  wiped with the run (finishRun), and a cleanup that drives the machine's programs needs the
 *  elevation password again — re-supplied here, held in memory, wiped with the cleanup run like
 *  any other. Stored only on the path that schedules cleanups, because the other path runs nothing. */
export async function abortWithCleanup(host: RecoveryHost, runId: string, secrets?: Record<string, Buffer>): Promise<void> {
  const run = host.loadRun(runId);
  if (run.status !== "failed" && run.status !== "cancelled") throw errValidation(`run ${runId} is not failed/cancelled`);
  const def = host.deps.runDefinitions.get(run.kind);
  const all = host.allStepRows(runId);
  const names = registeredCleanupNames(all);
  if (names.length === 0) {
    settleAbortWithoutCleanup(host.deps.db, runId);
    // Said on the run itself: an abort that settles without a cleanup step to show would otherwise
    // leave the log exactly as it was, and the operator guessing whether anything happened.
    appendRunMeta(host.deps.db, host.deps.bus, runId, "\u2715 cancelled \u2014 nothing to clean up: no completed step registered a compensation");
    writeAudit(host.deps.db, { action: "run.cancelled", runId, detail: { cleanedUp: false } });
    releaseLocks(host.deps.db, runId);
    host.dispatchQueue();
    return;
  }
  const params = def ? def.paramsSchema.parse(run.params) : {};
  await def?.assertAbortable?.(params, { db: host.deps.db });
  acquireLocks(host.deps.db, runId, planClaims(run.plan));
  scheduleCleanupSteps(host.deps.db, runId, all, names, new Map((def?.cleanups?.(params) ?? []).map((c) => [c.name, c])));
  if (secrets) host.storeSecrets(runId, secrets);
  writeAudit(host.deps.db, { action: "run.cleanup_started", runId });
  host.fireExecute(runId);
}
