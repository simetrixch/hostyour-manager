import type { z } from "zod";
import type { Db } from "../db/client.ts";
import type { RunKind, RunStatus, TargetKind, RunOutputStream, LockResource } from "../../shared/enums.ts";
import type { SshSession } from "../adapters/ssh/port.ts";
import type { CredentialStore } from "../security/store.ts";
import type { Logger } from "../kernel/logger.ts";
import type { SshTransport } from "./transport.ts";

// The Run/Step executor types. Everything a
// step may touch is here — deliberately narrow: no Hono context, no direct sqlite handle
// for runs/steps/events (executor-owned).

/** Memory-only secret channel (one-time password etc.). Implemented by RunSecretsMap. */
export interface RunSecrets {
  get(name: string): Buffer | undefined; // e.g. "adopt-password"
  wipe(name?: string): void; // zero + delete (all, when name omitted)
}

export interface Cleanup {
  name: string;
  title: string;
  run(ctx: StepCtx): Promise<void>;
}

export interface StepCtx {
  readonly runId: string;
  readonly stepName: string;
  readonly db: Db; // inventory writes (servers/clusters/apps) only
  readonly creds: CredentialStore; // audited open/seal
  readonly params: Readonly<Record<string, unknown>>;
  readonly secrets: RunSecrets; // memory-only, never persisted
  readonly signal: AbortSignal; // fires on cancel/abort and on shutdown
  readonly logger: Logger; // pino child({ runId, step })

  /** Plan-gated SSH. No arg = the single ownsHost target. Multi-target execution
   *  (ctx.ssh(serverId) to an aux target) is not implemented yet; a run is single-target. */
  ssh(serverId?: string): Promise<SshSession>;

  /** The adopt password ceremony ONLY. Open a PASSWORD-authed session to the run's
   *  ownsHost target from RunSecrets("adopt-password") and record the host key trust-on-
   *  first-use onto the server row, so the later key session (ssh()) can pin it. Cached per
   *  run; later ceremony steps get the same session until closePasswordSession(). Throws
   *  MissingRunSecret when the password is gone (crash/restart). Normal
   *  runs never touch this — they use ssh() (key, cached). */
  openPasswordSession(): Promise<SshSession>;
  /** Close + evict the password session (adopt step 6 discard-password, after key login is
   *  verified). No-op if none is open. */
  closePasswordSession(): void;
  /** Machine-identity attestation. Not implemented yet; the interface is final here. */
  attest(serverId?: string): Promise<void>;

  /** Append one line to `events` (+ live SSE). The ONLY way run output exists. The "ephemeral"
   *  stream goes to the live SSE bus alone — no `events` row, so the line cannot be replayed or
   *  read back; a value that must be shown once and stored nowhere takes that stream. */
  log(stream: RunOutputStream, text: string): void;
  /** Persist progress inside a step (steps.checkpoint_json). Secret-free (redactor). */
  checkpoint(data: unknown): void;
  readCheckpoint<T>(): T | undefined;
  /** Register a compensating action for abort-with-cleanup. Idempotent by contract. */
  registerCleanup(c: Cleanup): void;
}

export interface Step {
  name: string; // stable id: "install-key"
  title: string; // human: "Install SSH key"
  /** Idempotent BY CONTRACT: checks its own precondition first; safe to re-run after a
   *  crash mid-step. Throw to fail; return to succeed. */
  run(ctx: StepCtx): Promise<void>;
}

/** ownsHost=true ⇒ exclusive host ownership: the planner derives a `server:<id>` lock from it, so no
 *  second run can touch that machine while this one holds it. */
export interface RunTargetRef {
  serverId: string;
  ownsHost: boolean;
  label: string; // approval card: "m1 (master)"
  /** WHICH of the server's two addresses this run reaches it on (executor/transport.ts). Optional
   *  and absent on every run that has no reason to care — omitted means "default", the LAN address
   *  when the row carries one. A run states it here, not per ssh() call, so the choice is frozen
   *  into plan_json at approval and one host cannot be reached two ways inside one run. */
  transport?: SshTransport;
}

export interface LockClaim {
  resource: LockResource;
  key: string;
}

/** What plan() produces; frozen into runs.plan_json at approval. */
export interface Plan {
  kind: RunKind;
  targetKind: TargetKind;
  targetId: string;
  summary: string;
  steps: ReadonlyArray<Pick<Step, "name" | "title">>;
  /** Optional with executor defaulting: targetKind==='server' ⇒
   *  [{serverId: targetId, ownsHost: true, label: name}]. So the adopt run compiles with zero edits. */
  targets?: RunTargetRef[];
  locks?: LockClaim[]; // extra claims beyond the derived server:*; defaults to []
  warnings: string[];
  estimateSeconds?: number;
  requiredSecrets: string[];
  /** Operator-supplied NON-secret inputs the plan asks for at approve (onboard activation
   *  prompts). Optional + defaults to none, so every existing plan/def compiles unchanged. Frozen into
   *  plan_json; surfaced on RunView.requiredInputs; collected in the clear (never sealed). */
  requiredInputs?: { field: string; label: string }[];
}

export interface PlanSnapshot extends Plan {
  planHash: string; // sha256 over canonical {kind,targetId,steps,targets,locks,paramsJson}
  plannedAt: number; // epoch ms
}

export interface PlannerDeps {
  db: Db; // planners read inventory, never mutate
}

/** The channel a STREAMING planner runs against (onboard). Unlike plan(), which is a fast
 *  synchronous read, a streaming planner runs a long, observable validation (the gate-runner) whose
 *  lines land as append-only events while the run sits in `planning`. */
export interface PlanStreamCtx {
  db: Db;
  /** Append one line to the run's log (meta stream) as validation progresses. */
  log: (line: string) => void;
  signal: AbortSignal; // fires on cancel/shutdown mid-validation
}

/** What a streaming planner returns: a plan ready for approval (validation passed), or a rejection
 *  whose full report is frozen into plan_json so the operator sees every expected/found/reason
 * and the failed run stays soft-deletable. */
export type PlanStreamResult<P = Record<string, unknown>> =
  | { outcome: "planned"; params: P; plan: Plan }
  | { outcome: "rejected"; summary: string; planJson: unknown };

export interface RunDefinition<P = Record<string, unknown>> {
  kind: RunKind;
  paramsSchema: z.ZodType<P>;
  /** mutating ⇒ steps()[0].name === "attest-target" (asserted where the run definitions are assembled at boot). */
  mutating: boolean;
  plan(params: P, deps: PlannerDeps): Promise<Plan>;
  /** Optional streaming planner (onboard). When present, the executor's planStreamed() path drives
   *  it — the run sits in `planning`, the validation streams, and it settles planned or failed —
   *  instead of the synchronous plan() path. A def that has planStream() keeps plan() as a guard. */
  planStream?(rawParams: unknown, ctx: PlanStreamCtx): Promise<PlanStreamResult<P>>;
  steps(params: P): Step[];
  /** Compensating actions this kind may register (code-is-truth). abortWithCleanup
   *  resolves persisted __cleanups names against these; appended cleanup steps run in
   *  reverse registration order. */
  cleanups?(params: P): Cleanup[];
  /** The abort's OWN precondition: may this run's compensations RUN, right now? Asked by
   *  abortWithCleanup before it schedules a single cleanup step, and only when the run actually
   *  registered some — an abort that compensates nothing tears nothing down and so has nothing to
   *  refuse. It exists because a compensation is a MUTATION (create-tenant's rollback git-rm's the
   *  tenant's pointer, prunes its whole fan-out and records the tenant offboarded), while the run
   *  STATUS the executor gates on says only that the run stopped — not what undoing it would take
   *  off the cluster. The executor is domain-agnostic and must never learn that, so it ASKS the
   *  definition, which is the thing that knows what its own cleanups do. Throw (an AppError, so the
   *  route maps it) to refuse; the run is then left exactly as it was, nothing scheduled, and the
   *  refusal holds for EVERY caller of the abort rather than for one route. A def without this hook
   *  is always abortable, as before. */
  assertAbortable?(params: P, deps: { db: Db }): Promise<void>;
  /** Called once after the run commits a terminal status (succeeded/failed/cancelled), for
   *  status choreography — e.g. adopt resets the server `adopting → bare` on failure
   *. Sync, idempotent, fast; a throw is logged and swallowed. */
  onTerminal?(status: RunStatus, deps: { db: Db; runId: string; params: P }): void;
}

export type AnyRunDefinition = RunDefinition<Record<string, unknown>>;

/** A plan guard. Throws PLAN_REFUSED; evaluated before the planner runs. */
export type PlanGuard = (params: unknown, deps: PlannerDeps) => Promise<void>;
