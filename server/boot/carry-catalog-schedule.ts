// The catalog's trunk carried into this installation's books branch on a TIMER — the third road
// beside the boot (boot.ts, behind the listener) and the tenant plan (create-tenant.run.ts). A member
// Application of a standing tenant follows the books branch, so without this a chart fix pushed to
// the catalog's trunk reached a standing tenant only when somebody booted the Manager or planned a
// tenant (#169). A merge with nothing to bring in is "Already up to date" and pushes nothing
// (adapters/git/git.ts carryTrunkToBooksBranch), so a tick with no change costs one fetch.
import type { Logger } from "../kernel/logger.ts";
import { scheduleEvery } from "./schedule.ts";

export const CARRY_INTERVAL_MS = 10 * 60_000;

let stop: (() => void) | null = null;

/** Run `carry` every `intervalMs` (schedule.ts: never overlapping, never throwing through the
 *  timer, unref'd). The carry boot hands in (Wired.carryCatalogTrunk) already logs and swallows its
 *  own failure. Idempotent: a second call schedules nothing. */
export function scheduleCatalogCarry(carry: () => Promise<void>, logger: Logger, intervalMs = CARRY_INTERVAL_MS): void {
  if (stop) return;
  stop = scheduleEvery("catalog carry", carry, logger, intervalMs);
}

/** Stops the schedule — tests, and nothing else, call it. */
export function stopCatalogCarrySchedule(): void {
  stop?.();
  stop = null;
}
