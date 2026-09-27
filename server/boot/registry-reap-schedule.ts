// The registry reaper on a TIMER: once a day at a fixed hour, UTC, inside this server. The hour is the
// installation's choice (REGISTRY_REAPER_HOUR), so a prune runs off-peak and never beside a working
// day's releases. Never overlapping: the next day is armed only when a run has ended. Unref'd, so a
// Manager that is shutting down is not held open by it.
import type { Logger } from "../kernel/logger.ts";

/** Milliseconds from `now` to the next `hourUtc`:00:00 UTC. A boot at the hour waits a day. */
export function msUntilHour(now: Date, hourUtc: number): number {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hourUtc));
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

let stop: (() => void) | null = null;

/** Run `reap` every day at `hourUtc`:00 UTC. The reap itself never rejects; a rejection past it is
 *  logged and the next day is armed all the same. Idempotent: a second call schedules nothing. */
export function scheduleRegistryReap(reap: () => Promise<void>, logger: Logger, hourUtc: number): void {
  if (stop) return;
  let timer: NodeJS.Timeout | undefined;
  const arm = (): void => {
    timer = setTimeout(() => {
      void reap()
        .catch((err: unknown) => logger.error({ err: String(err) }, "the scheduled registry reaper threw past its own guard"))
        .finally(arm);
    }, msUntilHour(new Date(), hourUtc));
    timer.unref();
  };
  arm();
  logger.info({ hourUtc }, "registry reaper scheduled");
  stop = () => clearTimeout(timer);
}

/** Stops the schedule — tests, and nothing else, call it. */
export function stopRegistryReapSchedule(): void {
  stop?.();
  stop = null;
}
