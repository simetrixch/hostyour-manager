import type { LockView, RunDurationView, RunView } from "../../shared/api-types.ts";
import { ApiRequestError } from "./request.ts";

// What the Runs page and a refused approve say about a run: which runs are still open, where a run
// stands, which locks it holds, and when a run of its kind usually ends.

const OPEN_STATUSES: ReadonlySet<string> = new Set(["planning", "planned", "approved", "running"]);

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
  if (!d) return "no earlier run of this kind has finished, so there is no usual time yet";
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

/** The claim a refused approve collided with, or null for any other failure. */
export interface BusyHolder {
  resource: string;
  key: string;
  holderRunId: string;
}

export function busyHolderOf(e: unknown): BusyHolder | null {
  if (!(e instanceof ApiRequestError) || e.code !== "RESOURCE_BUSY" || !e.detail) return null;
  const { resource, key, holderRunId } = e.detail;
  return typeof resource === "string" && typeof key === "string" && typeof holderRunId === "string" ? { resource, key, holderRunId } : null;
}
