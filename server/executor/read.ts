import { eq, gt, and, or, desc, inArray, isNull } from "drizzle-orm";
import type { PreflightCheck } from "../../shared/preflight.ts";
import type { Db } from "../db/client.ts";
import { runs, steps, events, runLocks } from "../db/schema/runs.ts";
import type { RunStatus, StepStatus } from "../../shared/enums.ts";
import type { RunView, RunEventView, RunDurationView } from "../../shared/api-types.ts";
import { getOperatorDisplayName } from "../db/operator-names.ts";

// The sanctioned read path for runs/steps/events. Routes read runs
// ONLY through here — the dep-cruiser rule `only-executor-touches-runs-schema` makes any
// other reader a lint failure.

/** The statuses of a run that has not ended. */
const OPEN_RUN_STATUSES: RunStatus[] = ["planning", "planned", "approved", "running"];

const ms = (d: Date | null): number | null => (d ? d.getTime() : null);

function summaryOf(r: typeof runs.$inferSelect): string {
  const plan = r.planJson as { summary?: string } | null;
  return plan?.summary ?? `${r.kind} ${r.targetId}`;
}

function toRunView(db: Db, r: typeof runs.$inferSelect): RunView {
  const rows = db.select().from(steps).where(eq(steps.runId, r.id)).orderBy(steps.ordinal).all();
  // What "Abort (cleanup)" would run: the compensations completed steps registered (executor/cleanup.ts
  // registeredCleanupNames reads the same field). A run that ended by an abort has nothing left to
  // resume — every step is ok or skipped — which is what tells it from a run interrupted mid-flight (#236).
  const cleanupsRegistered = rows.some((s) => ((s.checkpointJson as { __cleanups?: string[] } | null)?.__cleanups?.length ?? 0) > 0);
  const aborted = r.status === "cancelled" && r.startedAt !== null && rows.every((s) => s.status === "ok" || s.status === "skipped");
  return {
    id: r.id,
    kind: r.kind,
    targetKind: r.targetKind,
    targetId: r.targetId,
    status: r.status,
    summary: summaryOf(r),
    startedBy: getOperatorDisplayName(db, r.startedBy),
    steps: rows.map((s) => ({ name: s.name, title: s.title, status: s.status, startedAt: ms(s.startedAt), endedAt: ms(s.finishedAt) })),
    requiredSecrets: (r.planJson as { requiredSecrets?: string[] } | null)?.requiredSecrets ?? [],
    secretHints: (r.planJson as { secretHints?: Record<string, string> } | null)?.secretHints ?? {},
    optionalSecrets: (r.planJson as { optionalSecrets?: string[] } | null)?.optionalSecrets ?? [],
    findings: (r.planJson as { findings?: PreflightCheck[] } | null)?.findings ?? [],
    requiredInputs: (r.planJson as { requiredInputs?: { field: string; label: string }[] } | null)?.requiredInputs ?? [],
    createdAt: r.createdAt.getTime(),
    startedAt: ms(r.startedAt),
    endedAt: ms(r.finishedAt),
    deletedAt: ms(r.deletedAt),
    cleanupsRegistered,
    aborted,
  };
}

/** The operator's list — soft-deleted runs are honestly gone from it ("Delete run" means
 *  the run leaves your view). Their rows + logs stay in the DB; see getRun. The newest `limit`
 *  runs, plus every run that has not ended or still holds a lock, whatever its age: a failed run
 *  that keeps its locks is what blocks every later approve, and it must not fall out of the list
 *  behind newer runs. */
export function listRuns(db: Db, limit = 100): RunView[] {
  const holders = db.select({ runId: runLocks.runId }).from(runLocks).all().map((l) => l.runId);
  const rows = [
    ...db.select().from(runs).where(isNull(runs.deletedAt)).orderBy(desc(runs.createdAt)).limit(limit).all(),
    ...db.select().from(runs).where(and(isNull(runs.deletedAt), holders.length > 0 ? or(inArray(runs.status, OPEN_RUN_STATUSES), inArray(runs.id, holders)) : inArray(runs.status, OPEN_RUN_STATUSES))).all(),
  ];
  const unique = [...new Map(rows.map((r) => [r.id, r])).values()].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  return unique.map((r) => toRunView(db, r));
}

/** How long the last runs of each kind took, from start to end. Only succeeded runs count: a failed
 *  or cancelled run stopped early, so it would make the usual time look shorter than it is. The
 *  window is the newest `window` runs of a kind, so a change that makes a kind faster or slower shows
 *  within that many runs. */
export function listRunDurations(db: Db, window = 20): RunDurationView[] {
  const rows = db
    .select({ kind: runs.kind, startedAt: runs.startedAt, finishedAt: runs.finishedAt })
    .from(runs)
    .where(and(eq(runs.status, "succeeded"), isNull(runs.deletedAt)))
    .orderBy(desc(runs.finishedAt))
    .all();
  const byKind = new Map<string, number[]>();
  for (const r of rows) {
    if (!r.startedAt || !r.finishedAt) continue;
    const taken = byKind.get(r.kind) ?? [];
    if (taken.length < window) taken.push(r.finishedAt.getTime() - r.startedAt.getTime());
    byKind.set(r.kind, taken);
  }
  return [...byKind].map(([kind, taken]) => ({ kind, typicalMs: median(taken), sampleSize: taken.length }));
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

/** By-id STILL resolves a soft-deleted run (deletedAt set on the view): a direct or
 *  bookmarked link keeps working and the full log stays inspectable retroactively —
 *  the UI renders it clearly marked as deleted, with every action disabled. */
export function getRun(db: Db, id: string): RunView | undefined {
  const r = db.select().from(runs).where(eq(runs.id, id)).get();
  return r ? toRunView(db, r) : undefined;
}

/** A run's KIND + its FROZEN params — the sanctioned narrow accessor for a caller that must act on
 *  WHAT a run was planned with, not merely on how it went. Deliberately NOT folded into RunView:
 *  params are a run-INTERNAL record that can carry PII (create-tenant's adminEmail) and sealed
 *  credential references (onboard's repoCredentialId), so they must never ride the generic run
 *  payload out to the browser. A caller reads them HERE, server-side, and puts only the fields it
 *  needs on the wire — which is how the tenant purge derives its {guid, stage, clusterId} from a
 *  FAILED create-tenant run whose MINTED guid exists nowhere else (the failure
 *  window between apply-appproject and write-pointer leaves neither a pointer nor an inventory row).
 *  A run that never settled `planned` still carries only its RAW request params (streaming-plan.ts
 *  overwrites them when the plan settles), so the caller must treat a missing field as "not planned
 *  that far", never as an error. Soft-deleted runs still resolve, exactly like getRun. */
export function getRunParams(db: Db, id: string): { kind: string; params: Record<string, unknown> } | undefined {
  const r = db.select({ kind: runs.kind, paramsJson: runs.paramsJson }).from(runs).where(eq(runs.id, id)).get();
  return r ? { kind: r.kind, params: (r.paramsJson as Record<string, unknown> | null) ?? {} } : undefined;
}

/** ONE step's status on ONE run — the sanctioned narrow accessor for a caller that must know HOW FAR a
 *  run got, not merely how it ended. `undefined` when the run has no step by that name (a run that failed
 *  while still `planning` has no step rows at all), which a caller must treat as "cannot tell", never as
 *  "did not run". Deliberately narrower than RunView.steps, which carries the whole list for rendering:
 *  this exists for a DECISION, and a decision keyed on one named step says out loud which fact it rests
 *  on. That fact is what separates a create-tenant that failed AT its precondition — attest-target,
 *  step 0, which runs before record-provisional and therefore before ANY mutation — from one that mutated
 *  and left a tenant standing in GitOps with no inventory row (tenant-orphans.ts resolveRunTenantState):
 *  both end with no tenants row, and only the step rows tell them apart. */
/** How a run stands: its status and, where it failed, its error. */
export function getRunEnding(db: Db, id: string): { status: RunStatus; error: string | null } | undefined {
  return db.select({ status: runs.status, error: runs.error }).from(runs).where(eq(runs.id, id)).get();
}

export function getRunStepStatus(db: Db, runId: string, stepName: string): StepStatus | undefined {
  return db.select({ status: steps.status }).from(steps).where(and(eq(steps.runId, runId), eq(steps.name, stepName))).get()?.status;
}

export function getRunStepCheckpoint<T>(db: Db, runId: string, stepName: string): T | undefined {
  const row = db
    .select({ checkpointJson: steps.checkpointJson })
    .from(steps)
    .where(and(eq(steps.runId, runId), eq(steps.name, stepName)))
    .get();
  return (row?.checkpointJson as { data?: T } | null)?.data;
}

/** A run on ONE target that has started and not settled — approved, running, or failed (a failed
 *  run is retried or aborted, never left as it stands) — or undefined. The narrow read a run kind
 *  refuses its target with while another run is changing it. A deleted run has let its target go. */
export function findActiveRunOn(db: Db, target: { kind: string; id: string }): { id: string; kind: string; status: RunStatus } | undefined {
  return db
    .select({ id: runs.id, kind: runs.kind, status: runs.status })
    .from(runs)
    .where(and(eq(runs.targetKind, target.kind), eq(runs.targetId, target.id), inArray(runs.status, ["approved", "running", "failed"]), isNull(runs.deletedAt)))
    .get();
}

export function readEvents(db: Db, runId: string, afterSeq = -1): RunEventView[] {
  return db
    .select()
    .from(events)
    .where(and(eq(events.runId, runId), gt(events.seq, afterSeq)))
    .orderBy(events.seq)
    .all()
    .map((e) => ({ seq: e.seq, stream: e.stream, text: e.text, at: e.ts.getTime() }));
}
