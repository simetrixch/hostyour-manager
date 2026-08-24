// The period behind the administrator check.
//
// The WORK is a run — planned, approved, executed and recorded like every other, so a check is
// visible in the run list, comparable with the one before it, and startable by hand. What is here is
// only what starts it, and it starts it exactly as a route handler does: Executor.plan followed by
// Executor.approve.
//
// IN THIS PROCESS, and not in a CronJob beside it. The reaper next door is a CronJob because its
// database is an emptyDir it fills and throws away. This one has to write into the manager's OWN
// database — a run nobody can see in the run list is the one thing this check must not be — and that
// database is a ReadWriteOnce volume held by a single replica. seed-master.ts states the same
// dependency in as many words: "the single-replica deployment (RWO sqlite ⇒ no cross-pod
// concurrency)". A second pod writing it is not merely awkward, it is excluded by the storage.
//
// The alternative was a CronJob calling the API, which needs a machine-to-machine credential this
// product does not have. Adding one would be a new way into an API that provisions tenants and holds
// every cluster credential — a large decision to take for a timer.
//
// The shape is seed-master.ts's background reconcile: unref'd so it never holds the process open, an
// inFlight guard so a slow check never overlaps the next tick, a stop function exported for tests,
// and a tick that can never crash the server.
import type { Logger } from "pino";
import type { Executor } from "../executor/executor.ts";

/** How often to ask. Tenants do not lose their administrators quickly, and a run in the list every
 *  few minutes would bury the ones somebody started. */
const INTERVAL_MS = 6 * 60 * 60 * 1000;

/** How long after boot the first check waits. Long enough that a restart loop cannot fill the run
 *  list, and that the pod is serving before it starts asking other services anything. */
const FIRST_DELAY_MS = 5 * 60 * 1000;

let timer: NodeJS.Timeout | undefined;
let firstTimer: NodeJS.Timeout | undefined;

/** Stops the schedule. Exported for tests (afterEach) — the timers are unref()'d, so a leftover
 *  never holds a process open, but a leftover across tests would still fire into a closed database. */
export function stopTenantCheckSchedule(): void {
  if (firstTimer) clearTimeout(firstTimer);
  if (timer) clearInterval(timer);
  firstTimer = undefined;
  timer = undefined;
}

/** Starts one check, and answers whether it was started.
 *
 * Exported so the schedule's decision — start a run, never do the work — is testable without a
 * timer. It swallows nothing: a refusal is logged with its reason, because a check that silently
 * stopped being started is indistinguishable from a check that keeps finding nothing wrong. */
export async function startTenantCheck(executor: Executor, logger: Logger): Promise<boolean> {
  try {
    const { runId } = await executor.plan("tenant-check", {});
    // approve() is what the operator's button does after reading a plan. There is nothing to read
    // and nothing to decide here — the check reads and records, and changes no cluster.
    await executor.approve(runId);
    logger.info({ runId }, "tenant administrator check started");
    return true;
  } catch (err) {
    // A manager without tenant onboarding configured has no such run kind, which is a normal state
    // and not a fault: it is logged once per tick at info, not error.
    logger.info(
      { err: err instanceof Error ? err.message : String(err) },
      "tenant administrator check was not started",
    );
    return false;
  }
}

/** Arms the schedule. Does nothing when it is already armed. */
export function scheduleTenantCheck(executor: Executor, logger: Logger): void {
  if (timer || firstTimer) return;
  let inFlight = false;

  const tick = (): void => {
    // Never overlap: a check over many tenants, each with a ten-second budget, can outlast a tick,
    // and two of them would ask every tenant twice and write the row from both.
    if (inFlight) return;
    inFlight = true;
    void startTenantCheck(executor, logger).finally(() => {
      inFlight = false;
    });
  };

  firstTimer = setTimeout(() => {
    tick();
    timer = setInterval(tick, INTERVAL_MS);
    timer.unref();
  }, FIRST_DELAY_MS);
  firstTimer.unref();

  logger.info(
    { intervalHours: INTERVAL_MS / 3_600_000, firstAfterMinutes: FIRST_DELAY_MS / 60_000 },
    "tenant administrator check scheduled",
  );
}
