import type { LockView, QueuedRunView, RunDurationView, RunView } from "../../shared/api-types.ts";

// What the Runs page and a run's page say about a run: which runs are still open, where a run
// stands or waits in the queue, which locks it holds, and when a run of its kind usually ends.

const OPEN_STATUSES: ReadonlySet<string> = new Set(["planning", "planned", "queued", "approved", "running"]);

/** A run still in play: not yet ended, or ended `failed` while it keeps its locks for a retry. */
export function isOpenRun(run: RunView, locks: readonly LockView[]): boolean {
  return OPEN_STATUSES.has(run.status) || locks.some((l) => l.runId === run.id);
}

/** The locks a run holds, as "resource key". */
export function locksHeldBy(runId: string, locks: readonly LockView[]): string[] {
  return locks.filter((l) => l.runId === runId).map((l) => `${l.resource} ${l.key}`);
}

/** Where a run stands, in the words of its steps. */
export function currentStepOf(run: RunView): string {
  if (run.status === "planning") return "planning";
  if (run.status === "planned") return "waiting for approval";
  if (run.status === "queued") return "queued";
  const running = run.steps.find((s) => s.status === "running");
  if (running) return running.title;
  const failed = run.steps.find((s) => s.status === "failed");
  if (failed) return `stopped at ${failed.title}`;
  if (run.status === "approved") return "starting";
  return "";
}

/** When a run of `kind` usually ends, from the measured runs before it. Never a promise. */
export function usualDurationOf(kind: string, durations: readonly RunDurationView[]): string {
  const d = durations.find((x) => x.kind === kind);
  if (!d) return "no earlier run of this kind has succeeded, so there is no usual time yet";
  const minutes = Math.max(1, Math.round(d.typicalMs / 60_000));
  return `usually ~${minutes} min (from ${d.sampleSize} earlier ${d.sampleSize === 1 ? "run" : "runs"})`;
}

/** Elapsed time as "Nh Mm", "Mm" or "Ss". */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** What a queued run is waiting for, or whether its credentials must be supplied again. */
export function queueLine(q: QueuedRunView): string {
  if (q.needsSecrets) return "needs its password again on its run page";
  if (q.waitsFor.length === 0) return "starts now";
  return "waits for " + q.waitsFor.map((w) => `${w.resource} ${w.key} (run ${w.holderRunId})`).join(", ");
}
