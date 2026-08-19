import { eq, and, inArray, gte, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { runs, steps, events, runLocks } from "../db/schema/runs.ts";
import { writeAudit } from "../db/audit-writer.ts";
import { runId as genRunId, stepId as genStepId, evtId as genEvtId } from "../kernel/ids.ts";
import { AppError, errValidation, errNotFound, errIllegalTransition } from "../kernel/errors.ts";
import { redact } from "../security/redact.ts";
import type { CredentialStore } from "../security/store.ts";
import type { SshFactory } from "../adapters/ssh/port.ts";
import type { Logger } from "../kernel/logger.ts";
import type { RunKind, RunStatus, StepStatus, TargetKind } from "../../shared/enums.ts";
import { assertRunTransition, isDeletableRun } from "./transitions.ts";
import { acquireLocks, releaseLocks, deriveServerLocks } from "./locks.ts";
import { runGuards, isMutatingPrecondition } from "./guards.ts";
import { RunSecretsMap } from "./secrets.ts";
import { RunContext } from "./context.ts";
import { hashPlan } from "./plan-hash.ts";
import { beginStreamingPlan } from "./streaming-plan.ts";
import { registeredCleanupNames, settleAbortWithoutCleanup, scheduleCleanupSteps } from "./cleanup.ts";
import type { RunEventBus } from "./bus.ts";
import type { AnyRunDefinition, Plan, PlanSnapshot, RunTargetRef, Step } from "./types.ts";
import { setStepStatus, setStepStatusIn } from "./step-status.ts";

export interface ExecutorDeps {
  db: Db;
  creds: CredentialStore;
  bus: RunEventBus;
  logger: Logger;
  registry: Map<RunKind, AnyRunDefinition>;
  sshFactory: SshFactory;
  actor: () => string; // current operator id (from request ctx) or "op_system"
}

interface LoadedRun {
  id: string;
  kind: RunKind;
  targetKind: TargetKind;
  targetId: string;
  params: Record<string, unknown>;
  plan: PlanSnapshot;
  status: RunStatus;
  startedAt: Date | null;
}

/**
 * The single write path for the world. Route handlers never touch
 * runs/steps/events directly — only this API. Every `db.transaction` is one atomic step,
 * so a crash between any two leaves a consistent, resumable picture.
 */
export class Executor {
  private readonly active = new Map<string, AbortController>();
  private readonly runSecrets = new Map<string, RunSecretsMap>();
  private readonly inflight = new Map<string, Promise<void>>();

  constructor(private readonly deps: ExecutorDeps) {}

  async plan(kind: RunKind, rawParams: unknown): Promise<{ runId: string; plan: PlanSnapshot }> {
    const def = this.deps.registry.get(kind);
    if (!def) throw errValidation(`unknown run kind: ${kind}`);
    const params = def.paramsSchema.parse(rawParams);
    await runGuards(kind, params, { db: this.deps.db });
    const plan = await def.plan(params, { db: this.deps.db });
    const impls = def.steps(params);
    if (impls.map((s) => s.name).join(",") !== plan.steps.map((s) => s.name).join(",")) {
      throw new AppError("INTERNAL", `planner/steps name mismatch for ${kind}`);
    }
    const snapshot: PlanSnapshot = { ...plan, planHash: hashPlan(plan, params), plannedAt: Date.now() };
    const id = genRunId();
    const actor = this.deps.actor();
    this.deps.db.transaction((tx) => {
      tx.insert(runs)
        .values({ id, kind, targetKind: plan.targetKind, targetId: plan.targetId, paramsJson: params, planJson: snapshot, status: "planned", startedBy: actor })
        .run();
      impls.forEach((s, i) => {
        tx.insert(steps).values({ id: genStepId(), runId: id, ordinal: i, name: s.name, title: s.title, status: "pending" }).run();
      });
    });
    writeAudit(this.deps.db, { actor, action: "run.planned", targetKind: plan.targetKind, targetId: plan.targetId, runId: id, detail: { kind, summary: plan.summary } });
    return { runId: id, plan: snapshot };
  }

  /** Streaming plan entrypoint (onboard). Records the run in `planning`, fires the def's streaming
   *  planner (the gate-runner validation) whose lines land as events, and settles the run to
   *  `planned` (validation passed — a plan awaits approval) or `failed` (rejected, with the full
   *  report frozen into plan_json so the operator keeps the full report on a settled run). Returns immediately; SSE streams the gate
   *  lines. Only defs that declare planStream() are eligible. */
  async planStreamed(kind: RunKind, rawParams: unknown): Promise<{ runId: string }> {
    return beginStreamingPlan(this.deps, this.active, this.inflight, kind, rawParams);
  }

  async approve(runId: string, secrets?: Record<string, Buffer>): Promise<void> {
    const run = this.loadRun(runId);
    assertRunTransition(run.status, "approved");
    for (const name of run.plan.requiredSecrets) {
      // A 0-length Buffer is truthy — reject it too, or an empty operator value would pass here and
      // (for onboard) be seeded create-only into Vault as a PERMANENT empty secret (cas=0, no rotate).
      if (!secrets?.[name] || secrets[name].length === 0) throw errValidation(`missing required secret: ${name}`);
    }
    const targets = run.plan.targets ?? this.defaultTargets(run.plan);
    acquireLocks(this.deps.db, runId, [...deriveServerLocks(targets), ...(run.plan.locks ?? [])]);
    const actor = this.deps.actor();
    this.deps.db.transaction((tx) => tx.update(runs).set({ status: "approved", approvedAt: new Date() }).where(eq(runs.id, runId)).run());
    writeAudit(this.deps.db, { actor, action: "run.approved", runId, detail: { planHash: run.plan.planHash } });

    const secretsMap = new RunSecretsMap(runId);
    if (secrets) for (const [k, v] of Object.entries(secrets)) secretsMap.set(k, v);
    this.runSecrets.set(runId, secretsMap);

    this.fireExecute(runId); // fire — API returns immediately, SSE takes over
  }

  async discard(runId: string): Promise<void> {
    const run = this.loadRun(runId);
    assertRunTransition(run.status, "cancelled");
    this.deps.db.transaction((tx) => tx.update(runs).set({ status: "cancelled", finishedAt: new Date() }).where(eq(runs.id, runId)).run());
    writeAudit(this.deps.db, { actor: this.deps.actor(), action: "run.cancelled", runId, detail: { discarded: true } });
    this.safeOnTerminal(this.deps.registry.get(run.kind), runId, run.params, "cancelled");
  }

  /** Soft-delete a run — gated purely on status (isDeletableRun): any SETTLED run
   *  (planned, failed, cancelled, OR succeeded) may be deleted so the owner can tidy the
   *  list; only an in-flight run (planning/approved/running) is refused and must settle
   *  first. A run is NEVER hard-deleted. "Deleted" means removed from the operator's view:
   *  `deleted_at` is set and listRuns hides the run, while the row and its
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
    if (r.deletedAt) return; // already soft-deleted — idempotent, no second hook/audit
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
      this.safeOnTerminal(this.deps.registry.get(r.kind), runId, (r.paramsJson as Record<string, unknown> | null) ?? {}, "cancelled");
    }
    this.deps.db.transaction((tx) => {
      tx.delete(runLocks).where(eq(runLocks.runId, runId)).run(); // planned/failed normally hold none — defensive, a hidden run must never keep a lock
      tx.update(runs).set({ deletedAt: new Date() }).where(eq(runs.id, runId)).run();
    });
    this.runSecrets.delete(runId); // hygiene — a deletable run holds no secrets, but never leak
    writeAudit(this.deps.db, {
      actor: this.deps.actor(),
      action: "run.deleted",
      targetKind: r.targetKind,
      targetId: r.targetId,
      runId,
      detail: { kind: r.kind, statusAtDelete: r.status, soft: true },
    });
  }

  async cancel(runId: string): Promise<void> {
    this.active.get(runId)?.abort();
    await this.settle(runId);
  }

  /** Resume-on-boot. No locked boot while the keystore is plaintext, so this
   *  runs immediately. Normalizes crash artifacts, then continues every unfinished run
   *  CONCURRENTLY through the same inflight bookkeeping approve uses. execute() registers the
   *  run's AbortController synchronously (before its first await), so by the time the fire
   *  loop below has run, every resumed run is in `active`/`inflight`: a cancel on any of them
   *  aborts a real controller and settle() awaits a real promise — with a serial loop, a run
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
      for (const run of orphanedPlanning) this.failRun(run.id, "validation was interrupted by a controller restart — re-submit the onboarding");
      const pending = this.deps.db.select({ id: runs.id }).from(runs).where(inArray(runs.status, ["running", "approved"])).all();
      // Only the steps left RUNNING by the crash: pending ones are already where they belong, and
      // an ok one must never be reset. The state list IS the WHERE, so that holds in the statement.
      for (const run of pending) setStepStatusIn(this.deps.db, run.id, ["running"], "pending", { startedAt: null });
      await Promise.all(pending.map((run) => this.fireExecute(run.id)));
    } catch (err) { this.deps.logger.error({ err }, "boot-time recovery could not read or normalize the runs a crash left behind — nothing was resumed on this boot; they stay as the crash left them and the next boot takes them again"); }
  }

  async shutdown(): Promise<void> {
    for (const ctrl of this.active.values()) ctrl.abort();
    const deadline = Date.now() + 10_000;
    while (this.active.size > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  /** Resolves once the run's execution (if in flight) has settled. Test/introspection use. */
  async settle(runId: string): Promise<void> {
    await this.inflight.get(runId);
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
  async retryFromStep(runId: string, stepName?: string, secrets?: Record<string, Buffer>): Promise<void> {
    const run = this.loadRun(runId);
    if (run.status !== "failed") throw errValidation(`run ${runId} is not failed`);
    const target = stepName ? this.stepRowFull(runId, stepName) : this.firstFailedStep(runId);
    if (target.status !== "failed" && target.status !== "skipped" && target.status !== "pending") {
      throw errValidation(`cannot retry from step ${target.name} (status ${target.status})`);
    }
    this.deps.db.transaction((tx) => {
      const later = tx.select().from(steps).where(and(eq(steps.runId, runId), gte(steps.ordinal, target.ordinal))).all();
      for (const s of later) {
        if (s.status !== "ok") {
          setStepStatus(tx, s.id, s.status, "pending", { error: null, startedAt: null, finishedAt: null });
        }
      }
      tx.update(runs).set({ status: "running", error: null, finishedAt: null }).where(eq(runs.id, runId)).run();
    });
    writeAudit(this.deps.db, { actor: this.deps.actor(), action: "run.step_retried", runId, detail: { step: target.name } });
    this.storeSecrets(runId, secrets);
    this.fireExecute(runId);
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
  async skipStep(runId: string, stepName: string, reason: string): Promise<void> {
    const run = this.loadRun(runId);
    if (run.status !== "failed") throw errValidation(`run ${runId} is not failed`);
    if (!reason.trim()) throw errValidation("a skip reason is required");
    const step = this.stepRowFull(runId, stepName);
    if (step.status !== "failed") throw errValidation(`step ${stepName} is not the failed step`);
    // Asked on the DEFINITION's mutating flag + the step name (guards.isMutatingPrecondition), never on
    // the kind: the executor stays domain-agnostic and learns nothing about tenants, consumers or slaves.
    if (isMutatingPrecondition(this.deps.registry.get(run.kind), step.name)) {
      throw errValidation(
        `step ${stepName} is the fail-closed precondition of this ${run.kind} run — it cannot be skipped. ` +
          "It refused because of what it found in the world, not because of anything this run did, and every step after it mutates. " +
          "Fix what it refused and retry the step, or abort/delete the run.",
      );
    }
    this.deps.db.transaction((tx) => {
      setStepStatus(tx, step.id, step.status, "skipped", { skipReason: reason });
      tx.update(runs).set({ status: "running", error: null, finishedAt: null }).where(eq(runs.id, runId)).run();
    });
    writeAudit(this.deps.db, { actor: this.deps.actor(), action: "run.step_skipped", runId, detail: { step: stepName, reason } });
    this.appendMeta(runId, `⏭ skipped by ${this.deps.actor()}: ${reason}`);
    this.fireExecute(runId);
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
   *  (2) PARAMS ARE PARSED ONLY WHERE THEY ARE NEEDED. paramsSchema.parse used to be the FIRST thing this
   *  method did, which made a run that never got a usable plan un-abortable: a run that failed while still
   *  `planning` carries only the operator's RAW request (beginStreamingPlan persists it verbatim and only
   *  the settled plan overwrites it) and has no step rows at all, so the parse threw a ZodError at the
   *  operator instead of settling the run cancelled — a guaranteed-failing button on a run that had
   *  nothing to clean up in the first place. The params feed the definition's cleanups + precondition, so
   *  they are parsed there and nowhere else.
   *
   *  `secrets` is retryFromStep's re-entry surface on the abort path: a terminal run's secrets were
   *  wiped with the run (finishRun), and a cleanup that drives the machine's programs needs the
   *  elevation password again — re-supplied here, held in memory, wiped with the cleanup run like
   *  any other. Stored only on the path that schedules cleanups, because the other path runs nothing. */
  async abortWithCleanup(runId: string, secrets?: Record<string, Buffer>): Promise<void> {
    const run = this.loadRun(runId);
    if (run.status !== "failed" && run.status !== "cancelled") throw errValidation(`run ${runId} is not failed/cancelled`);
    const def = this.deps.registry.get(run.kind);
    const all = this.allStepRows(runId);
    const names = registeredCleanupNames(all);
    if (names.length === 0) {
      settleAbortWithoutCleanup(this.deps.db, runId);
      writeAudit(this.deps.db, { actor: this.deps.actor(), action: "run.cancelled", runId, detail: { cleanedUp: false } });
      return;
    }
    const params = def ? def.paramsSchema.parse(run.params) : {};
    await def?.assertAbortable?.(params, { db: this.deps.db });
    scheduleCleanupSteps(this.deps.db, runId, all, names, new Map((def?.cleanups?.(params) ?? []).map((c) => [c.name, c])));
    if (secrets) this.storeSecrets(runId, secrets);
    writeAudit(this.deps.db, { actor: this.deps.actor(), action: "run.cleanup_started", runId });
    this.fireExecute(runId);
  }

  // ---- internals

  private async execute(runId: string): Promise<void> {
    try {
      const run = this.loadRun(runId);
      const def = this.deps.registry.get(run.kind);
      if (!def) {
        this.failRun(runId, `unknown run kind ${run.kind}`);
        return;
      }
      const params = def.paramsSchema.parse(run.params);
      const impls = def.steps(params);
      if (impls.map((s) => s.name).join(",") !== run.plan.steps.map((s) => s.name).join(",")) {
        writeAudit(this.deps.db, { actor: "system", action: "run.plan_diverged", runId, detail: { expected: run.plan.steps.map((s) => s.name), actual: impls.map((s) => s.name) } });
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

      const controller = new AbortController();
      this.active.set(runId, controller);
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
        signal: controller.signal,
        sshFactory: this.deps.sshFactory,
        targetServerId: this.targetServerId(run),
        declaredTargets: this.declaredTargets(run),
      });
      // Log the run's sanitized inputs (run.params — never secret material) so the DB run log states WHAT it ran with, not just "Run started".
      const args = Object.entries(run.params).map(([k, v]) => `${k}=${v !== null && typeof v === "object" ? JSON.stringify(v) : String(v)}`).join("  ");
      ctx.emitMeta(resuming ? "Run resumed" : `Run started${args ? `  ·  ${args}` : ""}`);
      writeAudit(this.deps.db, { actor: "system", action: resuming ? "run.resumed" : "run.started", runId });

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
        if (controller.signal.aborted) {
          this.deps.db.transaction((tx) => tx.update(runs).set({ status: "cancelled", finishedAt: new Date() }).where(eq(runs.id, runId)).run());
          ctx.emitMeta(`✕ cancelled before: ${row.title}`);
          writeAudit(this.deps.db, { actor: "system", action: "run.cancelled", runId, detail: { beforeStep: row.name } });
          this.safeOnTerminal(def, runId, params, "cancelled");
          this.finishRun(runId, ctx, secrets);
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
          writeAudit(this.deps.db, { actor: "system", action: "run.failed", runId, detail: { failedStep: row.name } });
          this.safeOnTerminal(def, runId, params, "failed");
          this.finishRun(runId, ctx, secrets);
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
          const aborted = controller.signal.aborted || (err instanceof Error && err.name === "AbortError");
          const message = redact(err instanceof Error ? err.message : String(err));
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
          writeAudit(this.deps.db, { actor: "system", action: aborted ? "run.cancelled" : "run.failed", runId, detail: { failedStep: row.name } });
          this.safeOnTerminal(def, runId, params, aborted ? "cancelled" : "failed");
          this.finishRun(runId, ctx, secrets);
          return;
        }
      }
      const finalStatus = isCleanupRun ? "cancelled" : "succeeded";
      this.deps.db.transaction((tx) => tx.update(runs).set({ status: finalStatus, finishedAt: new Date() }).where(eq(runs.id, runId)).run());
      ctx.emitMeta(isCleanupRun ? "Run cancelled — cleanup complete" : "Run succeeded");
      writeAudit(this.deps.db, { actor: "system", action: isCleanupRun ? "run.cancelled" : "run.succeeded", runId, ...(isCleanupRun ? { detail: { cleanedUp: true } } : {}) });
      this.safeOnTerminal(def, runId, params, finalStatus);
      this.finishRun(runId, ctx, secrets);
    } catch (err) {
      // Unexpected executor error (not a step failure — those are handled above).
      this.failRun(runId, redact(err instanceof Error ? err.message : String(err)));
    }
  }

  private finishRun(runId: string, ctx: RunContext, secrets: RunSecretsMap): void {
    releaseLocks(this.deps.db, runId);
    secrets.wipe();
    ctx.close();
    this.active.delete(runId);
    this.runSecrets.delete(runId);
  }

  // Call a definition's onTerminal hook (status choreography). Never lets a hook error
  // escalate — the run's terminal status is already committed, so a throwing hook could only
  // corrupt the record of a run that has already finished.
  private safeOnTerminal(def: AnyRunDefinition | undefined, runId: string, params: Record<string, unknown>, status: RunStatus): void {
    if (!def?.onTerminal) return;
    try {
      def.onTerminal(status, { db: this.deps.db, runId, params });
    } catch (err) {
      this.deps.logger.error({ err, runId }, "onTerminal hook failed (swallowed)");
      // Log-everything: the hook is the run's status choreography (inventory
      // rows) — its failure must land in the DB run log, not only pod stdout. appendMeta
      // redacts; self-guarded so safeOnTerminal keeps its never-escalate contract.
      try { this.appendMeta(runId, `✗ post-run choreography (onTerminal → ${status}) failed: ${err instanceof Error ? err.message : String(err)} — server/cluster rows may not reflect this run's outcome`); } catch { /* the pino line above is the last resort */ }
    }
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
      this.appendMeta(runId, `✗ run failed: ${message}`);
      writeAudit(this.deps.db, { actor: "system", action: "run.failed", runId, detail: { error: message } });
      const r = this.deps.db.select().from(runs).where(eq(runs.id, runId)).get();
      if (r) this.safeOnTerminal(this.deps.registry.get(r.kind), runId, (r.paramsJson as Record<string, unknown> | null) ?? {}, "failed");
      releaseLocks(this.deps.db, runId);
    } catch (err) {
      this.deps.logger.error({ err, runId, runError: message }, "could not record the run's failure — the run row still reads whatever it read before, and the reason it failed now exists only in this line");
    }
    // Reached whether or not the recording landed, because the catch above swallows deliberately.
    this.active.delete(runId);
    this.runSecrets.delete(runId);
  }

  private defaultTargets(plan: Plan): RunTargetRef[] {
    if (plan.targetKind === "server") return [{ serverId: plan.targetId, ownsHost: true, label: plan.targetId }];
    return [];
  }

  private targetServerId(run: LoadedRun): string | undefined {
    if (run.targetKind === "server") return run.targetId;
    const targets = run.plan.targets ?? [];
    return targets.find((t) => t.ownsHost)?.serverId ?? targets[0]?.serverId;
  }

  // Every target the run's plan declares — the gate for a non-default ctx.ssh(id) (deploy-slave
  // per target server AND per address), and the address each host is reached on. Read off the FROZEN plan, so the transport a
  // run was approved with is the transport it runs with. Falls back to the derived single
  // owns-host target for a plan that declares no explicit targets (e.g. adopt), so single-target
  // runs stay unchanged.
  private declaredTargets(run: LoadedRun): RunTargetRef[] {
    return run.plan.targets ?? this.defaultTargets(run.plan);
  }

  private loadRun(runId: string): LoadedRun {
    const r = this.deps.db.select().from(runs).where(eq(runs.id, runId)).get();
    if (!r) throw errValidation(`run ${runId} not found`);
    // A soft-deleted run is gone from the operator's view — no mutation (approve/discard/
    // retry/skip/abort) may resurrect it into an invisible live run. execute() only ever
    // loads runs it was handed by approve/resume, which never see a deleted run.
    if (r.deletedAt) throw errValidation(`run ${runId} is deleted`);
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
    if (!row) throw new AppError("INTERNAL", `step ${name} not found on run ${runId}`);
    return { id: row.id, name: row.name, status: row.status, ordinal: row.ordinal };
  }

  private firstFailedStep(runId: string): { id: string; name: string; status: StepStatus; ordinal: number } {
    const row = this.deps.db.select().from(steps).where(and(eq(steps.runId, runId), eq(steps.status, "failed"))).orderBy(steps.ordinal).get();
    if (!row) throw errValidation(`run ${runId} has no failed step to retry`);
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
  private fireExecute(runId: string): Promise<void> {
    const p = this.execute(runId).finally(() => this.inflight.delete(runId));
    this.inflight.set(runId, p);
    return p;
  }

  private appendMeta(runId: string, text: string): void {
    const row = this.deps.db
      .select({ maxSeq: sql<number>`COALESCE(MAX(${events.seq}), -1)` })
      .from(events)
      .where(eq(events.runId, runId))
      .get();
    const seq = (row?.maxSeq ?? -1) + 1;
    const line = redact(text);
    this.deps.db.insert(events).values({ id: genEvtId(), runId, stepId: null, stream: "meta", seq, text: line }).run();
    this.deps.bus.publish(runId, { seq, stream: "meta", text: line, at: Date.now() });
  }
}
