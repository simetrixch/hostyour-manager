// A timer inside this process, for the acts that have to recur without a run behind them: the
// catalog carry (carry-catalog-schedule.ts) and the App-token refresh (refresh-app-tokens-schedule.ts)
// stand on it. Never overlapping: a tick that finds the last act still running does nothing, so a slow
// network never stacks two carries or two Vault writes. Never throwing through the timer: a rejection
// is logged and the schedule goes on, because a timer that died silently on one bad tick is the
// failure nobody sees. Unref'd, so a Manager that is shutting down is not held open by it.
import type { Logger } from "../kernel/logger.ts";

/** Run `act` every `intervalMs` under the guarantees above. Answers the stop. */
export function scheduleEvery(name: string, act: () => Promise<void>, logger: Logger, intervalMs: number): () => void {
  let inFlight = false;
  const tick = (): void => {
    if (inFlight) return;
    inFlight = true;
    void act()
      .catch((err: unknown) => logger.error({ err: String(err) }, `the scheduled ${name} threw past its own guard`))
      .finally(() => {
        inFlight = false;
      });
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  logger.info({ intervalMinutes: intervalMs / 60_000 }, `${name} scheduled`);
  return () => clearInterval(timer);
}
