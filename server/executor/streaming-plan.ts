import { eq } from "drizzle-orm";
import { runs, steps } from "../db/schema/runs.ts";
import { writeAudit } from "../db/audit-writer.ts";
import { runId as genRunId, stepId as genStepId } from "../kernel/ids.ts";
import { AppError, errValidation } from "../kernel/errors.ts";
import { redact } from "../security/redact.ts";
import type { RunKind } from "../../shared/enums.ts";
import { RunSecretsMap } from "./secrets.ts";
import { RunContext } from "./context.ts";
import { hashPlan } from "./plan-hash.ts";
import { runGuards } from "./guards.ts";
import type { ExecutorDeps } from "./executor.ts";
import type { AnyRunDefinition, PlanSnapshot } from "./types.ts";

/** Streaming plan entrypoint (onboard), called by Executor.planStreamed. Records the run in
 *  `planning` (plan_json NULL is allowed by the runs check), fires the long-running validation
 *  (runStreamingPlan) which settles the run planned/failed, and tracks it in the inflight map so
 *  settle()/cancel() see it. targetId is a placeholder (the run's own id) until the planner
 *  resolves the real target on success. Returns immediately; SSE streams the gate lines. */
export function beginStreamingPlan(
  deps: ExecutorDeps,
  active: Map<string, AbortController>,
  inflight: Map<string, Promise<void>>,
  kind: RunKind,
  rawParams: unknown,
): { runId: string } {
  const def = deps.registry.get(kind);
  if (!def) throw errValidation(`unknown run kind: ${kind}`);
  if (!def.planStream) throw errValidation(`run kind ${kind} has no streaming planner`);
  const id = genRunId();
  const actor = deps.actor();
  deps.db.transaction((tx) =>
    tx.insert(runs).values({ id, kind, targetKind: "cluster", targetId: id, paramsJson: (rawParams ?? {}) as Record<string, unknown>, planJson: null, status: "planning", startedBy: actor }).run(),
  );
  writeAudit(deps.db, { actor, action: "run.planning", targetKind: "cluster", targetId: id, runId: id, detail: { kind } });
  // ONE promise, as in Executor.fireExecute: the bookkeeping is chained on and the same object goes
  // into the map, so settle() and the map hold the same thing. `.finally()` attached and then discarded
  // makes a second promise no caller can reach, which is what surfaces as an unhandled rejection.
  const p = runStreamingPlan({ deps, active, runId: id, def, rawParams }).finally(() => inflight.delete(id));
  inflight.set(id, p);
  return { runId: id };
}

// The body of the streaming plan path (Executor.planStreamed): run the def's streaming planner
// while the run sits in `planning`, streaming its gate lines as events, then settle the run to
// `planned` (validation passed — a plan awaits approval) or `failed` (rejected, with the full
// report frozen into plan_json so the operator keeps the full report on a settled run). Extracted from executor.ts to keep that file
// within the size budget; the Executor owns the run row + the active/inflight bookkeeping and
// delegates the long-running validation here.

export interface StreamingPlanArgs {
  deps: ExecutorDeps;
  active: Map<string, AbortController>;
  runId: string;
  def: AnyRunDefinition;
  rawParams: unknown;
}

export async function runStreamingPlan(args: StreamingPlanArgs): Promise<void> {
  const { deps, active, runId, def, rawParams } = args;
  const controller = new AbortController();
  active.set(runId, controller);
  const ctx = new RunContext({
    runId,
    db: deps.db,
    creds: deps.creds,
    bus: deps.bus,
    logger: deps.logger,
    params: (rawParams ?? {}) as Record<string, unknown>,
    secrets: new RunSecretsMap(runId),
    signal: controller.signal,
    sshFactory: deps.sshFactory,
    targetServerId: undefined,
    declaredTargets: [],
  });
  ctx.emitMeta("Validating the repository in the sandbox…");
  /** Write down how a validation ENDED BADLY, then release the run's in-memory bookkeeping.
   *
   *  Every line of the recording is a database write, and the database is exactly what can be gone by
   *  the time a validation ends: it runs for minutes against a sandbox, and a shutdown that closed the
   *  handle, a full disk or SQLITE_BUSY all land here. So the recording is allowed to fail and the
   *  reason goes to the process log — the only surface left once the run log and the audit table are
   *  unreachable. `reason` is passed in because it is precisely what is lost otherwise: no operator
   *  will read it off the run row.
   *
   *  An escalation here costs the whole controller rather than one plan: nothing holds this promise —
   *  beginStreamingPlan returns the run id as soon as the row exists, its caller answers, and SSE takes
   *  over — so the rejection reaches the process, and Node's answer to an unhandled rejection is to
   *  terminate, killing every other run in flight over one validation whose end could not be recorded.
   *
   *  The row is then left reading `planning`. resumeOnBoot fails every run it finds in that state, so
   *  the next start settles it instead of leaving a ghost the operator can neither approve nor delete.
   *
   *  Only the two FAILURE recordings go through here. The `planned` write below deliberately does not:
   *  a plan that could not be frozen did not succeed, and the catch is its recovery — swallowing there
   *  would leave a run reading `planning` that nobody ever tried to settle. */
  const recordOutcome = (record: () => void, reason: string): void => {
    try {
      record();
    } catch (err) {
      deps.logger.error({ err, runId, planError: reason }, "could not record the plan's outcome — the run row still reads `planning`, and why the validation ended now exists only in this line");
    }
    // Reached whether or not the recording landed, because the catch above swallows deliberately.
    active.delete(runId);
    ctx.close();
  };
  try {
    const result = await def.planStream!(rawParams, { db: deps.db, log: (l) => ctx.emitMeta(l), signal: controller.signal });
    if (result.outcome === "rejected") {
      recordOutcome(() => {
        // Freeze the full report into plan_json so the operator reads every expected/found/reason,
        // and the failed run stays soft-deletable. No steps: nothing was planned.
        deps.db.transaction((tx) => tx.update(runs).set({ status: "failed", planJson: result.planJson, error: result.summary, finishedAt: new Date() }).where(eq(runs.id, runId)).run());
        ctx.emitMeta(`✗ ${result.summary}`);
        writeAudit(deps.db, { actor: "system", action: "run.failed", runId, detail: { rejected: true } });
      }, result.summary);
      return;
    }
    const params = def.paramsSchema.parse(result.params);
    // Security gate parity with executor.plan(): run the kind's KIND_GUARDS against the RESOLVED
    // params before the plan is frozen. Without this the crypto gate is dead on the streaming path —
    // a create-tenant/add-app (or onboard) planned via planStream would skip its plaintext-keystore
    // refusal, since only executor.plan() ran runGuards. A refusal throws here and the catch below
    // settles the run failed, exactly like a rejected validation.
    await runGuards(def.kind, params, { db: deps.db });
    const impls = def.steps(params);
    if (impls.map((s) => s.name).join(",") !== result.plan.steps.map((s) => s.name).join(",")) {
      throw new AppError("INTERNAL", `planner/steps name mismatch for ${def.kind}`);
    }
    const snapshot: PlanSnapshot = { ...result.plan, planHash: hashPlan(result.plan, params), plannedAt: Date.now() };
    deps.db.transaction((tx) => {
      tx.update(runs).set({ status: "planned", targetKind: result.plan.targetKind, targetId: result.plan.targetId, paramsJson: params, planJson: snapshot }).where(eq(runs.id, runId)).run();
      impls.forEach((s, i) => tx.insert(steps).values({ id: genStepId(), runId, ordinal: i, name: s.name, title: s.title, status: "pending" }).run());
    });
    ctx.emitMeta("✓ Validation passed — the plan is ready for approval");
    writeAudit(deps.db, { actor: "system", action: "run.planned", runId, detail: { kind: def.kind, summary: result.plan.summary } });
    active.delete(runId);
    ctx.close();
  } catch (err) {
    const aborted = controller.signal.aborted || (err instanceof Error && err.name === "AbortError");
    const message = redact(err instanceof Error ? err.message : String(err));
    recordOutcome(() => {
      deps.db.transaction((tx) => tx.update(runs).set({ status: aborted ? "cancelled" : "failed", error: message, finishedAt: new Date() }).where(eq(runs.id, runId)).run());
      ctx.emitMeta(aborted ? "✕ cancelled during validation" : `✗ validation failed: ${message}`);
      writeAudit(deps.db, { actor: "system", action: aborted ? "run.cancelled" : "run.failed", runId, detail: { duringPlanning: true } });
    }, message);
  }
}
