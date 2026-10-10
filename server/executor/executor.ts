import { eq, and, inArray } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { runs, steps } from "../db/schema/runs.ts";
import { deletion } from "../db/schema/stamps.ts";
import { writeAudit } from "../db/audit-writer.ts";
import { runAsActor, runActor } from "../kernel/actor.ts";
import { runId as genRunId, stepId as genStepId } from "../kernel/ids.ts";
import { errValidation, errNotFound, errIllegalTransition, errInternal, errResourceBusy } from "../kernel/errors.ts";
import { redact } from "../security/redact.ts";
import type { CredentialStore } from "../security/store.ts";
import type { SshFactory } from "../adapters/ssh/port.ts";
import type { Logger } from "../kernel/logger.ts";
import type { RunStatus, StepStatus } from "../../shared/enums.ts";
import { assertApprovable } from "./approve.ts";
import { runProbes } from "./probe.ts";
import { assertRunTransition, isDeletableRun } from "./transitions.ts";
import { releaseLocks } from "./locks.ts";
import { conflictsAtEndOfQueue, planClaims } from "./queue.ts";
import type { QueuedRunView } from "../../shared/api-types.ts";
import { RunSecretsMap } from "./secrets.ts";
import { RunContext } from "./context.ts";
import { hashPlan } from "./plan-hash.ts";
import { beginStreamingPlan } from "./streaming-plan.ts";
import type { RunEventBus } from "./bus.ts";
import type { AnyRunDefinition, Plan, PlanSnapshot, Step } from "./types.ts";
import { setStepStatus, setStepStatusIn } from "./step-status.ts";
import { appendRunMeta, callOnTerminal } from "./run-meta.ts";
import { declaredTargets, targetServerId } from "./run-targets.ts";
import { retryFromStep, skipStep, abortWithCleanup, type RecoveryHost } from "./step-recovery.ts";
import { QueueDispatcher } from "./queue-dispatch.ts";

export interface ExecutorDeps {
  db: Db;
  creds: CredentialStore;
  bus: RunEventBus;
  logger: Logger;
  runDefinitions: Map<string, AnyRunDefinition>;
  sshFactory: SshFactory;
}

export interface LoadedRun {
  id: string;
  kind: string;
  targetKind: string;
  targetId: string;
  params: Record<string, unknown>;
  plan: PlanSnapshot;
  status: RunStatus;
  startedAt: Date | null;
}

/** How long a shutdown lets the steps in flight end before the process exits. It stays below the
 *  Manager pod's grace period (30 s, the Deployment's default) so the exit is the Manager's own and
 *  never a kill; a step still running then is resumed by the next Manager like one a crash cut off. */
const SHUTDOWN_DRAIN_MS = 20_000;

/**
 * The single write path for the world. Route handlers never touch
 * runs/steps/events directly — only this API. Every `db.transaction` is one atomic step,
 * so a crash between any two leaves a consistent, resumable picture.
 */
export class Executor {
  /** Set by shutdown(): no run starts another step, so the runs wait for the next Manager. */
  private stopping = false;
  private readonly active = new Map<string, AbortController>();
  private readonly runSecrets = new Map<string, RunSecretsMap>();
  private readonly inflight = new Map<string, Promise<void>>();
  private readonly hasSecrets = (runId: string): boolean => this.runSecrets.has(runId);
  private readonly queue: QueueDispatcher;
  private readonly recoveryHost: RecoveryHost;

  constructor(private readonly deps: ExecutorDeps) {
    this.queue = new QueueDispatcher({
      db: this.deps.db,
      bus: this.deps.bus,
      logger: this.deps.logger,
      hasSecrets: this.hasSecrets,
      isStopping: () => this.stopping,
      fireExecute: (runId) => { void this.fireExecute(runId); },
    });
    this.recoveryHost = {
      deps: this.deps,
      loadRun: (runId) => this.loadRun(runId),
      stepRowFull: (runId, name) => this.stepRowFull(runId, name),
      allStepRows: (runId) => this.allStepRows(runId),
      storeSecrets: (runId, secrets) => this.storeSecrets(runId, secrets),
      fireExecute: (runId) => this.fireExecute(runId),
      dispatchQueue: () => this.queue.dispatch(),
    };
  }

  async plan(kind: string, rawParams: unknown): Promise<{ runId: string; plan: PlanSnapshot }> {
    const def = this.deps.runDefinitions.get(kind);
    if (!def) throw errValidation(`unknown run kind: ${kind}`);
    const params = def.paramsSchema.parse(rawParams);
    const planned = await def.plan(params, { db: this.deps.db });
    const impls = def.steps(params);
    if (impls.map((s) => s.name).join(",") !== planned.steps.map((s) => s.name).join(",")) {
      throw errInternal(`planner/steps name mismatch for ${kind}`);
    }
    // The probes run here, on the synchronous path, with nowhere to stream to: their lines go to
    // the logger, their findings into the plan, and a hard failure refuses it like a guard would.
    const findings = await runProbes(impls, { db: this.deps.db, creds: this.deps.creds, params, signal: new AbortController().signal, log: (line) => this.deps.logger.info({ kind }, line) });
    const plan: Plan = { ...planned, findings };
    const snapshot: PlanSnapshot = { ...plan, planHash: hashPlan(plan, params), plannedAt: Date.now() };
    const id = genRunId();
    this.deps.db.transaction((tx) => {
      tx.insert(runs)
        .values({ id, kind, targetKind: plan.targetKind, targetId: plan.targetId, paramsJson: params, planJson: snapshot, status: "planned" })
        .run();
      impls.forEach((s, i) => {
        tx.insert(steps).values({ id: genStepId(), runId: id, ordinal: i, name: s.name, title: s.title, status: "pending" }).run();
      });
    });
    writeAudit(this.deps.db, { action: "run.planned", targetKind: plan.targetKind, targetId: plan.targetId, runId: id, detail: { kind, summary: plan.summary } });
    return { runId: id, plan: snapshot };
  }

  /** Streaming plan entrypoint (onboard). Records the run in `planning`, fires the def's streaming
   *  planner (the gate-runner validation) whose lines land as events, and settles the run to
   *  `planned` (validation passed — a plan awaits approval) or `failed` (rejected, with the full
   *  report frozen into plan_json so the operator keeps the full report on a settled run). Returns immediately; SSE streams the gate
   *  lines. Only defs that declare planStream() are eligible. */
  async planStreamed(kind: string, rawParams: unknown): Promise<{ runId: string }> {
    return beginStreamingPlan(this.deps, this.active, this.inflight, kind, rawParams);
  }

  /** Approve a planned run: it joins the queue, and starts at once when it waits for no lock. Answers
   *  whether it started or waits. `onlyIfFree` refuses with RESOURCE_BUSY instead, for a run that is
   *  worth nothing later (the night's backup). On a queued run that lost its typed secrets to a Manager
   *  restart, the approve hands them back, and the run keeps its place. */
  async approve(runId: string, secrets?: Record<string, Buffer>, opts: { onlyIfFree?: boolean } = {}): Promise<{ status: "approved" | "queued" }> {
    const run = this.loadRun(runId);
    if (run.status === "queued") return this.retypeQueuedSecrets(run, secrets);
    assertRunTransition(run.status, "queued");
    await assertApprovable(run, this.deps.runDefinitions.get(run.kind), this.deps.db, secrets);
    if (opts.onlyIfFree) {
      const held = conflictsAtEndOfQueue(this.deps.db, planClaims(run.plan), this.hasSecrets)[0];
      if (held) throw errResourceBusy("Resource busy", { resource: held.resource, key: held.key, holderRunId: held.runId });
    }
    const moved = this.deps.db.transaction((tx) => tx.update(runs).set({ status: "queued", approvedAt: new Date() }).where(and(eq(runs.id, runId), eq(runs.status, "planned"))).run());
    if (moved.changes !== 1) throw errIllegalTransition(`run ${runId} was approved or discarded while this approve was checked`);
    writeAudit(this.deps.db, { action: "run.approved", runId, detail: { planHash: run.plan.planHash } });
    this.storeSecrets(runId, secrets);
    this.queue.dispatch();
    return this.queue.startedOrQueued(runId);
  }

  /** The queue in line order, with what each run waits for. */
  listQueue(): QueuedRunView[] {
    return this.queue.list();
  }

  private async retypeQueuedSecrets(run: LoadedRun, secrets: Record<string, Buffer> | undefined): Promise<{ status: "approved" | "queued" }> {
    if (!this.queue.list().find((q) => q.runId === run.id)?.needsSecrets) throw errIllegalTransition(`run ${run.id} is already queued with everything it needs`);
    await assertApprovable(run, this.deps.runDefinitions.get(run.kind), this.deps.db, secrets);
    this.storeSecrets(run.id, secrets);
    writeAudit(this.deps.db, { action: "run.secrets_retyped", runId: run.id });
    appendRunMeta(this.deps.db, this.deps.bus, run.id, "its secrets were typed again, and it keeps its place in the queue");
    this.queue.dispatch();
    return this.queue.startedOrQueued(run.id);
  }

  /** Park a planned or queued run at `cancelled`. A queued run takes no lock and wipes its typed
   *  secrets, and the runs behind it in line move up. */
  async discard(runId: string): Promise<void> {
    const run = this.loadRun(runId);
    assertRunTransition(run.status, "cancelled");
    this.deps.db.transaction((tx) => tx.update(runs).set({ status: "cancelled", finishedAt: new Date() }).where(eq(runs.id, runId)).run());
    writeAudit(this.deps.db, { action: "run.cancelled", runId, detail: { discarded: true, queued: run.status === "queued" } });
    callOnTerminal(this.deps, this.deps.runDefinitions.get(run.kind), runId, run.params, "cancelled");
    this.runSecrets.get(runId)?.wipe();
    this.runSecrets.delete(runId);
    this.queue.leave(runId);
    if (run.status === "queued") this.queue.dispatch();
  }

  /** Soft-delete a run — gated purely on status (isDeletableRun): any SETTLED run
   *  (planned, failed, cancelled, OR succeeded) may be deleted so the owner can tidy the
   *  list; only an in-flight run (planning/approved/running) is refused and must settle
   *  first. A run is NEVER hard-deleted. "Deleted" means removed from the operator's view:
   *  `deleted` is set and listRuns hides the run, while the row and its
   *  complete steps + events log REMAIN in the DB for retroactive inspection — events stays
   *  append-only, no trigger juggling. Any held run_locks are cleared so a soft-deleted run
   *  can never pin a resource. Idempotent: deleting an already-deleted run is a no-op.
   *  Inventory rows are deliberately untouched — soft-delete never tears anything down: a
   *  soft-deleted succeeded onboard/deploy leaves its apps/cluster row + git pointer live,
   *  so the deployed consumer keeps running (removal is only ever the separate offboard/
   *  remove run). The kind's onTerminal choreography still owns those rows (e.g. a failed
   *  deploy-slave parks its cluster row so the slave ordinal is never recycled). */
  async deleteRun(runId: string): Promise<void> {
    const r = this.deps.db.select().from(runs).where(eq(runs.id, runId)).get();
    if (!r) throw errNotFound(`run ${runId}`);
    if (r.deleted) return; // already soft-deleted — idempotent, no second hook/audit
    if (!isDeletableRun(r.status)) {
      throw errIllegalTransition(
        `run ${runId} is ${r.status} — an in-flight run must settle before it can be deleted`,
      );
    }
    // A planned run never fired a terminal hook — unwind any plan-time choreography exactly
    // as discard would. A failed run already fired onTerminal("failed") when it failed, a
    // cancelled run onTerminal("cancelled") at cancel/discard time, and a succeeded run
    // onTerminal("succeeded") on completion — so only planned needs a nudge here.
    if (r.status === "planned") {
      callOnTerminal(this.deps, this.deps.runDefinitions.get(r.kind), runId, (r.paramsJson as Record<string, unknown> | null) ?? {}, "cancelled");
    }
    this.deps.db.transaction((tx) => {
      releaseLocks(tx, runId); // planned/failed normally hold none — defensive, a hidden run must never keep a lock
      tx.update(runs).set(deletion()).where(eq(runs.id, runId)).run();
    });
    this.runSecrets.delete(runId); // hygiene — a deletable run holds no secrets, but never leak
    this.queue.dispatch();
    writeAudit(this.deps.db, {
      action: "run.deleted",
      targetKind: r.targetKind,
      targetId: r.targetId,
      runId,
      detail: { kind: r.kind, statusAtDelete: r.status, soft: true },
    });
  }

  async cancel(runId: string): Promise<void> {
    if (this.deps.db.select({ status: runs.status }).from(runs).where(eq(runs.id, runId)).get()?.status === "queued") return this.discard(runId);
    const inFlight = this.active.get(runId);
    if (inFlight) inFlight.abort();
    else if (this.stopping) this.cancelPaused(runId);
    await this.settle(runId);
  }

  /** A run the shutdown paused has no step in flight, so a cancel during the drain ends it here, as
   *  the loop ends a run cancelled between two steps; the next Manager then finds nothing to resume. */
  private cancelPaused(runId: string): void {
    const r = this.deps.db.select().from(runs).where(eq(runs.id, runId)).get();
    if (r?.status !== "running") return;
    const next = this.allStepRows(runId).find((row) => row.status !== "ok" && row.status !== "skipped");
    this.deps.db.transaction((tx) => tx.update(runs).set({ status: "cancelled", finishedAt: new Date() }).where(eq(runs.id, runId)).run());
    appendRunMeta(this.deps.db, this.deps.bus, runId, `✕ cancelled before: ${next?.title ?? "its end"}`);
    writeAudit(this.deps.db, { action: "run.cancelled", runId, detail: { beforeStep: next?.name ?? null } });
    callOnTerminal(this.deps, this.deps.runDefinitions.get(r.kind), runId, (r.paramsJson as Record<string, unknown> | null) ?? {}, "cancelled");
  }

  /** Resume-on-boot. No locked boot while the keystore is plaintext, so this
   *  runs immediately. Normalizes crash artifacts, then continues every unfinished run
   *  CONCURRENTLY through the same inflight bookkeeping approve uses. execute() registers the
   *  run's AbortController synchronously (before its first await), so by the time the fire
   *  loop below has run, every resumed run is in `active`/`inflight`: a cancel on any of them
   *  aborts a real manager and settle() awaits a real promise — with a serial loop, a run
   *  still queued behind a slow resume was invisible to both, so its cancel was acknowledged
   *  and then every remaining step still executed. Resolves once every resumed run settled.
   *
   *  THE WHOLE RECOVERY IS ALLOWED TO FAIL, and boot-time recovery is the one place in the executor
   *  where swallowing is right rather than merely survivable. It holds nothing it can lose: what it
   *  works on are rows, the rows stay, and a boot that could not read or normalize them leaves them
   *  exactly as the crash did for the next boot to take. One try covers all three database statements:
   *  they share one fate — a busy database or a slow disk at start-up refuses them together — and the
   *  next boot retries each of them in full, so a finer guard would buy a partial recovery that costs
   *  the same restart. The reason goes to the process log, the only surface a boot has before it
   *  serves anything.
   *
   *  Escalating costs the installation rather than one recovery. Nobody can hold this promise: it
   *  resolves only once every resumed run has SETTLED, so boot.ts must not await it or the HTTP
   *  listener stays down for the length of the longest onboarding. A rejection therefore reaches the
   *  process, Node ends it, the supervisor restarts, and the same statement fails again — a transient
   *  SQLITE_BUSY or a slow disk at start-up turns into a restart loop that serves nothing, out of a
   *  condition that would have cleared on its own.
   *
   *  The fire stays INSIDE the try so that a normalization that failed fires nothing at all: execute()
   *  walks the persisted step rows, and a run still carrying a step that reads `running` — whose legal
   *  successors are ok/failed/pending/skipped, never `running` again — ends FAILED on `step status
   *  running → running`, an internal message an operator can answer only with a manual retry. Left
   *  untouched the run costs one more restart and nothing else.
   *
   *  So the catch guards exactly the three database statements: failRun records inside its own try and
   *  cannot throw, and fireExecute cannot reject. */
  async resumeOnBoot(): Promise<void> {
    try {
      // A run interrupted mid-`planning` cannot be resumed — the gate-runner job died with the old
      // process. Fail it (with the report absent) so it becomes a soft-deletable settled run instead
      // of a stuck "planning" ghost the operator can neither approve nor delete.
      const orphanedPlanning = this.deps.db.select({ id: runs.id }).from(runs).where(eq(runs.status, "planning")).all();
      for (const run of orphanedPlanning) this.failRun(run.id, "validation was interrupted by a manager restart — re-submit the onboarding");
      const pending = this.deps.db.select({ id: runs.id }).from(runs).where(inArray(runs.status, ["running", "approved"])).all();
      // Only the steps left RUNNING by the crash: pending ones are already where they belong, and
      // an ok one must never be reset. The state list IS the WHERE, so that holds in the statement.
      for (const run of pending) setStepStatusIn(this.deps.db, run.id, ["running"], "pending", { startedAt: null });
      const resumed = pending.map((run) => this.fireExecute(run.id, { afterRestart: true }));
      for (const q of this.queue.list().filter((v) => v.needsSecrets)) {
        appendRunMeta(this.deps.db, this.deps.bus, q.runId, "⏸ the Manager restarted while this run was queued, and typed secrets live only in memory: type them again on the run page, and the run keeps its place");
      }
      this.queue.dispatch();
      await Promise.all(resumed);
    } catch (err) { this.deps.logger.error({ err }, "boot-time recovery could not read or normalize the runs a crash left behind — nothing was resumed on this boot; they stay as the crash left them and the next boot takes them again"); }
  }

  /** A restart pauses the runs, it never cancels one: no run starts another step, the steps in flight
   *  get until `drainMs` to end, and every run stays `running` for resumeOnBoot on the next Manager.
   *  A step still running at the deadline is cut off with the process and run again there, which
   *  the Step contract allows (types.ts: idempotent, safe to re-run after a crash mid-step). */
  async shutdown(drainMs = SHUTDOWN_DRAIN_MS): Promise<void> {
    this.stopping = true;
    const deadline = Date.now() + drainMs;
    while (this.active.size > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  /** Resolves once the run's execution (if in flight) has settled; a queued run is waited for until it
   *  starts and then until it settles, or until it is discarded. */
  async settle(runId: string): Promise<void> {
    for (;;) {
      const execution = this.inflight.get(runId);
      if (execution) return execution;
      if (this.deps.db.select({ status: runs.status }).from(runs).where(eq(runs.id, runId)).get()?.status !== "queued") return;
      await this.queue.untilLeaves(runId);
    }
  }

  /** Retry a failed run from a step. */
  async retryFromStep(runId: string, stepName?: string, secrets?: Record<string, Buffer>): Promise<void> {
    return retryFromStep(this.recoveryHost, runId, stepName, secrets);
  }

  /** Skip the failed step and continue with the next pending one. */
  async skipStep(runId: string, stepName: string, reason: string): Promise<void> {
    return skipStep(this.recoveryHost, runId, stepName, reason);
  }

  /** Turn registered cleanups into visible steps that run in reverse registration order, ending the run cancelled. */
  async abortWithCleanup(runId: string, secrets?: Record<string, Buffer>): Promise<void> {
    return abortWithCleanup(this.recoveryHost, runId, secrets);
  }

  // ---- internals

  private async execute(runId: string, opts: { afterRestart?: boolean } = {}): Promise<void> {
    try {
      const run = this.loadRun(runId);
      const def = this.deps.runDefinitions.get(run.kind);
      if (!def) {
        this.failRun(runId, `unknown run kind ${run.kind}`);
        return;
      }
      const params = def.paramsSchema.parse(run.params);
      const impls = def.steps(params);
      if (impls.map((s) => s.name).join(",") !== run.plan.steps.map((s) => s.name).join(",")) {
        writeAudit(this.deps.db, { action: "run.plan_diverged", runId, detail: { expected: run.plan.steps.map((s) => s.name), actual: impls.map((s) => s.name) } });
        this.failRun(runId, "step list diverged from the approved plan — re-plan required");
        return;
      }
      // Resolve step implementations by name: the original steps + any cleanup steps
      // (code-is-truth). Cleanup steps are appended to the DB by abortWithCleanup and are
      // NOT in the frozen plan — so the loop iterates the persisted step rows, not def.steps().
      const implByName = new Map<string, Step>();
      for (const s of impls) implByName.set(s.name, s);
      for (const c of def.cleanups?.(params) ?? []) {
        implByName.set(`cleanup:${c.name}`, { name: `cleanup:${c.name}`, title: `Cleanup: ${c.title}`, run: c.run });
      }

      const manager = new AbortController();
      this.active.set(runId, manager);
      const resuming = run.startedAt !== null;
      this.deps.db.transaction((tx) => tx.update(runs).set({ status: "running", startedAt: run.startedAt ?? new Date() }).where(eq(runs.id, runId)).run());
      const secrets = this.runSecrets.get(runId) ?? new RunSecretsMap(runId);
      const ctx = new RunContext({
        runId,
        db: this.deps.db,
        creds: this.deps.creds,
        bus: this.deps.bus,
        logger: this.deps.logger,
        params,
        secrets,
        signal: manager.signal,
        sshFactory: this.deps.sshFactory,
        targetServerId: targetServerId(run),
        declaredTargets: declaredTargets(run),
      });
      // Log the run's sanitized inputs (run.params — never secret material) so the DB run log states WHAT it ran with, not just "Run started".
      const args = Object.entries(run.params).map(([k, v]) => `${k}=${v !== null && typeof v === "object" ? JSON.stringify(v) : String(v)}`).join("  ");
      ctx.emitMeta(opts.afterRestart ? "Run resumed after a Manager restart" : resuming ? "Run resumed" : `Run started${args ? `  ·  ${args}` : ""}`);
      writeAudit(this.deps.db, { action: resuming ? "run.resumed" : "run.started", runId });

      const stepRows = this.allStepRows(runId);
      const isCleanupRun = stepRows.some((r) => r.name.startsWith("cleanup:"));
      for (const row of stepRows) {
        if (row.status === "ok" || row.status === "skipped") continue;
        // The gap between two steps is the one reliable cancellation point: most step
        // implementations never consult ctx.signal, so an abort taken mid-step lets that step
        // finish and commit ok (its work happened). Without this check the loop would keep
        // walking — every remaining, often destructive, step would still run and the run would
        // settle "succeeded" after the operator was told it was cancelled. A step that never
        // started stays pending.
        if (manager.signal.aborted) {
          this.deps.db.transaction((tx) => tx.update(runs).set({ status: "cancelled", finishedAt: new Date() }).where(eq(runs.id, runId)).run());
          ctx.emitMeta(`✕ cancelled before: ${row.title}`);
          writeAudit(this.deps.db, { action: "run.cancelled", runId, detail: { beforeStep: row.name } });
          callOnTerminal(this.deps, def, runId, params, "cancelled");
          this.finishRun(runId, ctx, secrets, "keep");
          return;
        }
        // A shutdown pauses the run here, between two steps and after a cancel had its say: it stays
        // `running` with its locks, and the next Manager resumes it at this step.
        if (this.stopping) {
          const dropped = secrets.size > 0 ? "; the values typed at approve are not kept across a restart, so a step that reads them asks for them again" : "";
          ctx.emitMeta(`⏸ interrupted by a Manager restart before: ${row.title} — the next Manager resumes this run${dropped}`);
          secrets.wipe();
          ctx.close();
          this.active.delete(runId);
          this.runSecrets.delete(runId);
          return;
        }
        const impl = implByName.get(row.name);
        if (!impl) {
          const missing = `no implementation for step ${row.name}`;
          this.deps.db.transaction((tx) => {
            setStepStatus(tx, row.id, row.status, "failed", { error: missing, finishedAt: new Date() });
            tx.update(runs).set({ status: "failed", error: missing, finishedAt: new Date() }).where(eq(runs.id, runId)).run();
          });
          ctx.emitMeta(`✗ failed: ${row.name} — ${missing}`);
          writeAudit(this.deps.db, { action: "run.failed", runId, detail: { failedStep: row.name } });
          callOnTerminal(this.deps, def, runId, params, "failed");
          this.finishRun(runId, ctx, secrets, "keep");
          return;
        }
        this.deps.db.transaction((tx) => setStepStatus(tx, row.id, row.status, "running", { startedAt: new Date() }));
        ctx.emitMeta(`▶ ${impl.title}`);
        const stepCtx = ctx.forStep(row.name, row.id);
        try {
          await impl.run(stepCtx);
          this.deps.db.transaction((tx) => setStepStatus(tx, row.id, "running", "ok", { finishedAt: new Date() }));
          ctx.emitMeta(`✓ ${impl.title}`);
        } catch (err) {
          const abortError = err instanceof Error && err.name === "AbortError";
          const aborted = manager.signal.aborted || abortError;
          const answered = redact(err instanceof Error ? err.message : String(err));
          // After a cancel a step's own failure is the cancel seen from inside (a watch cut short reads
          // as a fan-out that did not converge): the run is told it was interrupted, and the answer is
          // kept as what came after. An AbortError already says what was interrupted.
          const message = aborted && !abortError ? `interrupted by a cancel while this step ran — it answered afterwards: ${answered}` : answered;
          this.deps.db.transaction((tx) => {
            setStepStatus(tx, row.id, "running", "failed", { error: message, finishedAt: new Date() });
            tx.update(runs).set({ status: aborted ? "cancelled" : "failed", error: message, finishedAt: new Date() }).where(eq(runs.id, runId)).run();
          });
          // Surface the failure REASON into the visible run log — the ✗ meta alone left the
          // operator blind (the live create-mgmt incident: steps.error held the cause, the
          // streamed log did not). Routed through stepCtx.log → RunContext.emit → redact(),
          // the SAME chokepoint every run-log line passes (and `message` is itself already
          // redacted above), so an error echoing command output can never leak a secret.
          stepCtx.log("stderr", `✗ ${message}`);
          ctx.emitMeta((aborted ? "✕ cancelled during: " : "✗ failed: ") + impl.title);
          writeAudit(this.deps.db, { action: aborted ? "run.cancelled" : "run.failed", runId, detail: { failedStep: row.name } });
          // Every failed run is one error line in the process log, the line master's log alarm reads.
          if (!aborted) this.deps.logger.error({ runId, kind: def.kind, runError: message }, "run failed");
          callOnTerminal(this.deps, def, runId, params, aborted ? "cancelled" : "failed");
          this.finishRun(runId, ctx, secrets, "keep");
          return;
        }
      }
      const finalStatus = isCleanupRun ? "cancelled" : "succeeded";
      this.deps.db.transaction((tx) => tx.update(runs).set({ status: finalStatus, finishedAt: new Date() }).where(eq(runs.id, runId)).run());
      ctx.emitMeta(isCleanupRun ? "Run cancelled — cleanup complete" : "Run succeeded");
      writeAudit(this.deps.db, { action: isCleanupRun ? "run.cancelled" : "run.succeeded", runId, ...(isCleanupRun ? { detail: { cleanedUp: true } } : {}) });
      callOnTerminal(this.deps, def, runId, params, finalStatus);
      this.finishRun(runId, ctx, secrets, "release");
    } catch (err) {
      // Unexpected executor error (not a step failure — those are handled above).
      this.failRun(runId, redact(err instanceof Error ? err.message : String(err)));
    }
  }

  /** A run that failed or was cancelled in the middle keeps its locks, so no other run starts on what
   *  it left half done: they are let go when the run is retried to its end, aborted or deleted. */
  private finishRun(runId: string, ctx: RunContext, secrets: RunSecretsMap, locks: "keep" | "release"): void {
    if (locks === "release") releaseLocks(this.deps.db, runId);
    secrets.wipe();
    ctx.close();
    this.active.delete(runId);
    this.runSecrets.delete(runId);
    this.queue.dispatch();
  }

  /** Record that a run failed. Every line of the recording is a database write, and the database is
   *  exactly what can be unavailable when this runs: execute()'s catch-all lands here, and "the
   *  database no longer answers" is one of the ways it gets there (a shutdown that closed the handle, a
   *  full disk, a file the OS took away). So the recording is allowed to fail and the reason goes to
   *  the process log — the only surface left once the run log and the audit table are unreachable —
   *  and execute() keeps its contract of never rejecting.
   *
   *  Letting it escalate is what made an unrecordable run an unhandled rejection: nothing holds
   *  execute()'s promise (approve() fires the run and the route answers 202 while SSE takes over), so
   *  the rejection reached the process, and Node's answer to that is to terminate — killing every other
   *  run in flight over one run whose failure could not be written down.
   *
   *  The in-memory bookkeeping is released either way. An AbortController left in `active` for a run
   *  that is gone makes shutdown() sit out its whole grace period waiting for it, and a RunSecretsMap
   *  left behind keeps a one-time secret in memory after the run that owned it ended. */
  private failRun(runId: string, message: string): void {
    try {
      this.deps.db.transaction((tx) => tx.update(runs).set({ status: "failed", error: message, finishedAt: new Date() }).where(eq(runs.id, runId)).run());
      // Same observability law as the step catch: every failure reason lands in the visible
      // run log (appendMeta redacts), never only in runs.error.
      appendRunMeta(this.deps.db, this.deps.bus, runId, `✗ run failed: ${message}`);
      writeAudit(this.deps.db, { action: "run.failed", runId, detail: { error: message } });
      const r = this.deps.db.select().from(runs).where(eq(runs.id, runId)).get();
      this.deps.logger.error({ runId, kind: r?.kind, runError: message }, "run failed");
      if (r) callOnTerminal(this.deps, this.deps.runDefinitions.get(r.kind), runId, (r.paramsJson as Record<string, unknown> | null) ?? {}, "failed");
    } catch (err) {
      this.deps.logger.error({ err, runId, runError: message }, "could not record the run's failure — the run row still reads whatever it read before, and the reason it failed now exists only in this line");
    }
    // Reached whether or not the recording landed, because the catch above swallows deliberately.
    this.active.delete(runId);
    this.runSecrets.delete(runId);
    this.queue.dispatch();
  }

  private loadRun(runId: string): LoadedRun {
    const r = this.deps.db.select().from(runs).where(eq(runs.id, runId)).get();
    if (!r) throw errValidation(`run ${runId} not found`);
    // A soft-deleted run is gone from the operator's view — no mutation (approve/discard/
    // retry/skip/abort) may resurrect it into an invisible live run. execute() only ever
    // loads runs it was handed by approve/resume, which never see a deleted run.
    if (r.deleted) throw errValidation(`run ${runId} is deleted`);
    return {
      id: r.id,
      kind: r.kind,
      targetKind: r.targetKind,
      targetId: r.targetId,
      params: (r.paramsJson as Record<string, unknown> | null) ?? {},
      plan: r.planJson as PlanSnapshot,
      status: r.status,
      startedAt: r.startedAt,
    };
  }

  private stepRowFull(runId: string, name: string): { id: string; name: string; status: StepStatus; ordinal: number } {
    const row = this.deps.db.select().from(steps).where(and(eq(steps.runId, runId), eq(steps.name, name))).get();
    if (!row) throw errInternal(`step ${name} not found on run ${runId}`);
    return { id: row.id, name: row.name, status: row.status, ordinal: row.ordinal };
  }


  private allStepRows(runId: string): { id: string; name: string; title: string; status: StepStatus; ordinal: number; checkpoint: unknown }[] {
    return this.deps.db
      .select()
      .from(steps)
      .where(eq(steps.runId, runId))
      .orderBy(steps.ordinal)
      .all()
      .map((s) => ({ id: s.id, name: s.name, title: s.title, status: s.status, ordinal: s.ordinal, checkpoint: s.checkpointJson }));
  }

  private storeSecrets(runId: string, secrets?: Record<string, Buffer>): void {
    const map = new RunSecretsMap(runId);
    if (secrets) for (const [k, v] of Object.entries(secrets)) map.set(k, v);
    this.runSecrets.set(runId, map);
  }

  /** Fire execute() and register it in `inflight` so settle()/cancel() see the run. Returns the
   *  execution promise (execute never rejects — its catch-all settles the run failed, and failRun
   *  cannot throw).
   *
   *  ONE promise: the bookkeeping is chained onto execute()'s and the SAME object is both stored and
   *  returned, so what settle() awaits and what the map holds are the same thing. Attaching `.finally()`
   *  and discarding the result — the shape this replaces — makes a SECOND promise that no caller can
   *  ever reach: on a rejection, awaiting settle() handled the first one while the discarded one went
   *  to the process as an unhandled rejection, with no way for anyone to catch it. */
  private fireExecute(runId: string, opts: { afterRestart?: boolean } = {}): Promise<void> {
    // A run writes as its owner, whoever set it going: a queued run is dispatched by the request that
    // freed its claims, and a resumed one by the boot.
    const owner = this.deps.db.select({ owner: runs.owner }).from(runs).where(eq(runs.id, runId)).get()?.owner ?? runActor();
    const p = runAsActor(owner, () => this.execute(runId, opts)).finally(() => this.inflight.delete(runId));
    this.inflight.set(runId, p);
    return p;
  }
}
