// The clock behind the nightly backup (hostyour-cloud#254).
//
// The WORK is a run per family, consumer-nightly-backup and tenant-nightly-backup: planned, approved,
// executed and recorded like every other, so each night stands in the run list. What is here only
// starts them, as check-tenants-schedule.ts starts its check: Executor.plan followed by
// Executor.approve.
//
// ONCE PER UTC DAY, FROM 03:00. A tick every quarter hour starts what is due; a manager that was down
// at 03:00 starts the pass at its first tick after it. Both runs take the master lock, so a tick
// starts one run and only when no run holds that lock — the second family follows at a tick after the
// first has finished. What was started today is this process's memory, and after a restart the book
// of backups: a family whose units already hold a nightly generation of today is not started again.
import type { Logger } from "pino";
import type { Executor } from "../executor/executor.ts";
import type { Db } from "../db/client.ts";
import { listLocks } from "../executor/locks.ts";
import { hasNightlyGenerationOn } from "../db/unit-backups.ts";

/** The UTC hour from which the pass of a day is due. */
export const NIGHTLY_HOUR_UTC = 3;
const TICK_MS = 15 * 60 * 1000;
const NIGHTLY: readonly { kind: "consumer-nightly-backup" | "tenant-nightly-backup"; unitKind: "consumer" | "tenant" }[] = [
  { kind: "consumer-nightly-backup", unitKind: "consumer" },
  { kind: "tenant-nightly-backup", unitKind: "tenant" },
];

let timer: NodeJS.Timeout | undefined;
/** Per run kind, the UTC day (YYYYMMDD) its pass was started or refused on. */
const handled = new Map<string, string>();

/** Stops the schedule and forgets the days. Exported for tests. */
export function stopNightlyBackupSchedule(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
  handled.clear();
}

/** Start the nightly run that is due at `now`, at most one per call, and answer which one it started.
 *  Exported so the decision is testable without a timer. A refusal is logged with its reason once a
 *  day, because a pass that silently stopped being started reads like a pass with nothing to report. */
export async function startDueNightlyBackup(executor: Executor, db: Db, logger: Logger, now: Date): Promise<string | null> {
  if (now.getUTCHours() < NIGHTLY_HOUR_UTC) return null;
  const day = now.toISOString().slice(0, 10).replace(/-/g, "");
  for (const { kind, unitKind } of NIGHTLY) {
    if (handled.get(kind) === day) continue;
    if (hasNightlyGenerationOn(db, unitKind, day)) {
      handled.set(kind, day);
      continue;
    }
    // Another run holds the master: the pass waits for a later tick rather than leave a planned run.
    if (listLocks(db).length > 0) return null;
    handled.set(kind, day);
    let runId: string | undefined;
    try {
      runId = (await executor.plan(kind, {})).runId;
      await executor.approve(runId);
      logger.info({ runId, kind }, "nightly backup started");
      return kind;
    } catch (err) {
      if (runId !== undefined) {
        await executor.discard(runId).catch((e: unknown) => logger.error({ runId, err: e instanceof Error ? e.message : String(e) }, "the unstarted nightly backup run could not be discarded"));
      }
      logger.info({ kind, err: err instanceof Error ? err.message : String(err) }, "nightly backup was not started today");
      return null;
    }
  }
  return null;
}

/** Arms the schedule. Does nothing when it is already armed. */
export function scheduleNightlyBackup(executor: Executor, db: Db, logger: Logger): void {
  if (timer) return;
  let inFlight = false;
  timer = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    void startDueNightlyBackup(executor, db, logger, new Date()).finally(() => {
      inFlight = false;
    });
  }, TICK_MS);
  timer.unref();
  logger.info({ hourUtc: NIGHTLY_HOUR_UTC, tickMinutes: TICK_MS / 60_000 }, "nightly backup scheduled");
}
