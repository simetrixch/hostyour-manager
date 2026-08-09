import { eq, gt, and, desc, isNull } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { runs, steps, events } from "../db/schema/runs.ts";
import type { RunKind, StepStatus } from "../../shared/enums.ts";
import type { RunView, StepView, RunEventView } from "../../shared/api-types.ts";

// The sanctioned read path for runs/steps/events. Routes read runs
// ONLY through here — the dep-cruiser rule `only-executor-touches-runs-schema` makes any
// other reader a lint failure.

const ms = (d: Date | null): number | null => (d ? d.getTime() : null);

function summaryOf(r: typeof runs.$inferSelect): string {
  const plan = r.planJson as { summary?: string } | null;
  return plan?.summary ?? `${r.kind} ${r.targetId}`;
}

function stepsFor(db: Db, runId: string): StepView[] {
  return db
    .select()
    .from(steps)
    .where(eq(steps.runId, runId))
    .orderBy(steps.ordinal)
    .all()
    .map((s) => ({ name: s.name, title: s.title, status: s.status, startedAt: ms(s.startedAt), endedAt: ms(s.finishedAt) }));
}

function toRunView(db: Db, r: typeof runs.$inferSelect): RunView {
  return {
    id: r.id,
    kind: r.kind,
    targetKind: r.targetKind,
    targetId: r.targetId,
    status: r.status,
    summary: summaryOf(r),
    steps: stepsFor(db, r.id),
    requiredSecrets: (r.planJson as { requiredSecrets?: string[] } | null)?.requiredSecrets ?? [],
    requiredInputs: (r.planJson as { requiredInputs?: { field: string; label: string }[] } | null)?.requiredInputs ?? [],
    createdAt: r.createdAt.getTime(),
    startedAt: ms(r.startedAt),
    endedAt: ms(r.finishedAt),
    deletedAt: ms(r.deletedAt),
  };
}

/** The operator's list — soft-deleted runs are honestly gone from it ("Delete run" means
 *  the run leaves your view). Their rows + logs stay in the DB; see getRun. */
export function listRuns(db: Db, limit = 100): RunView[] {
  return db.select().from(runs).where(isNull(runs.deletedAt)).orderBy(desc(runs.createdAt)).limit(limit).all().map((r) => toRunView(db, r));
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
export function getRunParams(db: Db, id: string): { kind: RunKind; params: Record<string, unknown> } | undefined {
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
export function getRunStepStatus(db: Db, runId: string, stepName: string): StepStatus | undefined {
  return db.select({ status: steps.status }).from(steps).where(and(eq(steps.runId, runId), eq(steps.name, stepName))).get()?.status;
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
