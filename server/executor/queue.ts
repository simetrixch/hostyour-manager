import { and, asc, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { runs, runLocks, steps } from "../db/schema/runs.ts";
import type { QueuedRunView } from "../../shared/api-types.ts";
import { dedupeClaims, deriveServerLocks, insertLock, lockConflicts, type TakenClaim } from "./locks.ts";
import { defaultTargets } from "./run-targets.ts";
import type { LockClaim, PlanSnapshot } from "./types.ts";

// The run queue. An approved run waits here, in `queued`, until every lock it claims is free; the
// queue IS the runs table (status `queued`, ordered by approved_at), so a restart loses nothing of it.
// Only the typed secrets are not in the database: whether a queued run still holds them is asked of
// the executor's memory through `hasSecrets`.

/** Whether the executor still holds the secrets typed at the run's approve. */
export type HasSecrets = (runId: string) => boolean;

export function planClaims(plan: PlanSnapshot): LockClaim[] {
  return dedupeClaims([...deriveServerLocks(plan.targets ?? defaultTargets(plan)), ...(plan.locks ?? [])]);
}

interface QueueSlot { view: QueuedRunView; claims: LockClaim[] }

/** The queue in line order. A run that waits for its password again is passed over: it reserves no
 *  lock, so it holds back nobody behind it. Every other run reserves its claims, whether it can start
 *  or not, so a later run never overtakes it on a shared lock, and one that shares nothing with it
 *  never waits for it. `taken` ends as the held locks plus every reservation. */
function walkQueue(db: Db, hasSecrets: HasSecrets): { slots: QueueSlot[]; taken: TakenClaim[] } {
  const taken: TakenClaim[] = db.select().from(runLocks).where(isNull(runLocks.deleted)).all();
  const queued = db
    .select({ id: runs.id, kind: runs.kind, targetKind: runs.targetKind, targetId: runs.targetId, approvedAt: runs.approvedAt, planJson: runs.planJson })
    .from(runs)
    .where(and(eq(runs.status, "queued"), isNull(runs.deleted)))
    .orderBy(asc(runs.approvedAt), asc(runs.id))
    .all();
  const slots = queued.map((r, i): QueueSlot => {
    const plan = r.planJson as PlanSnapshot;
    const claims = planClaims(plan);
    const needsSecrets = plan.requiredSecrets.length > 0 && !hasSecrets(r.id);
    const waitsFor = needsSecrets ? [] : lockConflicts(taken, claims).map((t) => ({ resource: t.resource, key: t.key, holderRunId: t.runId }));
    if (!needsSecrets) taken.push(...claims.map((c) => ({ ...c, runId: r.id })));
    return {
      view: { runId: r.id, kind: r.kind, targetKind: r.targetKind, targetId: r.targetId, place: i + 1, approvedAt: r.approvedAt?.getTime() ?? 0, needsSecrets, waitsFor },
      claims,
    };
  });
  return { slots, taken };
}

export function listQueuedRuns(db: Db, hasSecrets: HasSecrets): QueuedRunView[] {
  return walkQueue(db, hasSecrets).slots.map((s) => s.view);
}

/** A run that ended in the middle, failed or cancelled, and so keeps its locks until it is retried,
 *  aborted or deleted. `failedStep` is the step's title as the run page shows it, and null where no step
 *  failed (a run cancelled between two steps). */
export interface FailedHolder { runId: string; kind: string; status: "failed" | "cancelled"; failedStep: string | null; error: string | null }

/** The run `runId`, when it ended in the middle; nothing for a run that is still going. */
export function findFailedHolder(db: Db, runId: string): FailedHolder | undefined {
  const run = db.select({ kind: runs.kind, status: runs.status, error: runs.error }).from(runs).where(eq(runs.id, runId)).get();
  if (!run || (run.status !== "failed" && run.status !== "cancelled")) return undefined;
  const step = db.select({ title: steps.title }).from(steps).where(and(eq(steps.runId, runId), eq(steps.status, "failed"))).orderBy(asc(steps.ordinal)).get();
  return { runId, kind: run.kind, status: run.status, failedStep: step?.title ?? null, error: run.error };
}

/** What a run of `claims` would wait for if it joined the end of the line now. */
export function conflictsAtEndOfQueue(db: Db, claims: LockClaim[], hasSecrets: HasSecrets): TakenClaim[] {
  return lockConflicts(walkQueue(db, hasSecrets).taken, claims);
}

/** Start every queued run that waits for nothing: take its locks and move it to `approved`, in one
 *  IMMEDIATE transaction, so a second dispatcher (another connection to the same file) waits for this
 *  one and then finds nothing left to start. The `status = 'queued'` condition and the unique
 *  index over the live run_locks hold the same even without it: a run is never started twice, nor while a lock is held.
 *  Answers the runs it started. */
export function startQueuedRuns(db: Db, hasSecrets: HasSecrets): string[] {
  return db.transaction((tx) => {
    const started: string[] = [];
    for (const { view, claims } of walkQueue(tx, hasSecrets).slots) {
      if (view.needsSecrets || view.waitsFor.length > 0) continue;
      const moved = tx.update(runs).set({ status: "approved" }).where(and(eq(runs.id, view.runId), eq(runs.status, "queued"))).run();
      if (moved.changes !== 1) continue;
      for (const c of claims) insertLock(tx, c, view.runId);
      started.push(view.runId);
    }
    return started;
  }, { behavior: "immediate" });
}
