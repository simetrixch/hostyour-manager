// One error type, carrying its HTTP status beside its code. Each constructor below names both, so a
// code's status is decided once, where the code is declared, and a plugin brings a code of its own the
// same way — beside its own code, with nothing to add here. `error-shape.ts` is the only module that
// turns these into a response.
export interface AppErrorOptions {
  detail?: Record<string, unknown>;
  cause?: unknown;
}

export class AppError extends Error {
  readonly code: string;
  readonly http: number;
  readonly detail: Record<string, unknown> | undefined;

  constructor(code: string, http: number, message: string, opts?: AppErrorOptions) {
    super(message, opts?.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "AppError";
    this.code = code;
    this.http = http;
    this.detail = opts?.detail;
  }
}

// Typed constructors. Branch on `.code`, never on subclass identity.
export const errValidation = (message: string, detail?: Record<string, unknown>): AppError =>
  new AppError("VALIDATION", 400, message, detail ? { detail } : undefined);
export const errNotAMember = (message: string): AppError => new AppError("NOT_A_MEMBER", 403, message);
export const errNotFound = (message = "Not found"): AppError => new AppError("NOT_FOUND", 404, message);
export const errCsrfRefused = (): AppError => new AppError("CSRF_REFUSED", 403, "Cross-origin request refused");
export const errIllegalTransition = (message: string): AppError => new AppError("ILLEGAL_TRANSITION", 409, message);
export const errResourceBusy = (message: string, detail?: { resource: string; key: string; holderRunId: string }): AppError =>
  new AppError("RESOURCE_BUSY", 409, message, detail ? { detail } : undefined);
export const errUndeclaredTarget = (serverId: string): AppError =>
  new AppError("UNDECLARED_TARGET", 500, `Step reached an undeclared target: ${serverId}`);
// A one-time run secret (e.g. the machine account's password) is absent — never stored, so lost on a
// crash/restart. Retry the step and re-enter it, or discard the run.
export const errMissingRunSecret = (name: string): AppError =>
  new AppError(
    "MISSING_RUN_SECRET",
    400,
    `The one-time secret "${name}" is not available — it is never stored, so re-enter it and retry this step (or discard the run).`,
    { detail: { secret: name } },
  );
export const errIdpUnreachable = (): AppError => new AppError("IDP_UNREACHABLE", 503, "The identity provider is unreachable");
// A feature whose config is absent by declaration (e.g. GITHUB_REPO unset) — 501, an honest
// "not configured here", never a half-enabled quiet default (no-silent-fallbacks).
export const errNotConfigured = (message: string): AppError => new AppError("NOT_CONFIGURED", 501, message);
// An upstream service (GitHub) refused/failed — surface ITS message verbatim (never a mask).
export const errUpstream = (message: string, opts?: AppErrorOptions): AppError => new AppError("UPSTREAM", 502, message, opts);
// The gate-runner's queue-of-1 is busy with another validation — the
// second plan fails cleanly rather than hanging.
export const errRunnerBusy = (): AppError =>
  new AppError("RUNNER_BUSY", 409, "The validation sandbox is busy with another job — try again in a moment");
// The gate-run's egress-fence self-probe was not green, so the sandbox that keeps untrusted
// repository content away from the cluster was not provably holding. Fail-closed: the report is
// refused where it crosses into the Manager, whatever its gates say. Held apart from GATE_INCOMPLETE
// for the reader's sake — that one says no report exists, this one says a report exists and is
// exactly what proves the sandbox was not sound. NEITHER is a finding about the repository under
// validation, and the message always says so, which is why there is no default one.
export const errSandboxDegraded = (message: string): AppError => new AppError("SANDBOX_DEGRADED", 503, message);
// The gate-run produced NO gate report — the gate task died before writing one, the publish step
// wrote a ConfigMap this Manager does not recognise, or no report ConfigMap was published at all.
// Held apart from a gate that FAILED, which is a report carrying a verdict and a named gate: this
// code says nothing was judged about the repository under validation, so whoever reads it must not
// go looking for the fault in that repository's own files.
export const errGateIncomplete = (message: string): AppError => new AppError("GATE_INCOMPLETE", 502, message);
// A fault of this process's own making — a broken invariant, never something the caller can fix.
export const errInternal = (message: string): AppError => new AppError("INTERNAL", 500, message);
