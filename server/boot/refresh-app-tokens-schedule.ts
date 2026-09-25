// The App-token refresh on a TIMER (domains/units/app-token-refresh.ts): every 45 minutes, the build
// repo-pat of every unit whose credential is the platform's GitHub App is rewritten with a token
// minted now, and the unit's three build Secrets are deleted behind the rewrite. A token lives 60
// minutes, so 45 keeps the entry alive across one missed tick's worth of drift and never lets the
// pipeline's clone read a value older than the token behind it. The deletion is what carries the
// rewrite to the clone: the Secrets are materialized by ExternalSecrets that read Vault on deploy and
// on the deletion of their target, never on a timer (`refreshPolicy: OnChange`), so a rewrite alone
// leaves the clone on the token ESO fetched at the deploy. Boot fires the same act once behind the
// listener (boot.ts), so the first tick is not the first refresh.
import type { Logger } from "../kernel/logger.ts";
import { scheduleEvery } from "./schedule.ts";

export const APP_TOKEN_REFRESH_INTERVAL_MS = 45 * 60_000;

let stop: (() => void) | null = null;

/** Run `refresh` every `intervalMs` (schedule.ts: never overlapping, never throwing through the
 *  timer, unref'd). The refresh itself never rejects and logs every unit it could not rewrite.
 *  Idempotent: a second call schedules nothing. */
export function scheduleAppTokenRefresh(refresh: () => Promise<void>, logger: Logger, intervalMs = APP_TOKEN_REFRESH_INTERVAL_MS): void {
  if (stop) return;
  stop = scheduleEvery("App-token refresh", refresh, logger, intervalMs);
}

/** Stops the schedule — tests, and nothing else, call it. */
export function stopAppTokenRefreshSchedule(): void {
  stop?.();
  stop = null;
}
