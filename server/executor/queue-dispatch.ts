import type { Db } from "../db/client.ts";
import type { RunEventBus } from "./bus.ts";
import type { Logger } from "../kernel/logger.ts";
import { listQueuedRuns, startQueuedRuns, type HasSecrets } from "./queue.ts";
import type { QueuedRunView } from "../../shared/api-types.ts";
import { appendRunMeta } from "./run-meta.ts";

export interface QueueDispatcherOpts {
  db: Db;
  bus: RunEventBus;
  logger: Logger;
  hasSecrets: HasSecrets;
  isStopping: () => boolean;
  fireExecute: (runId: string) => void;
}

// The executor's in-memory side of the queue: who waits for a run to leave it,
// and starting what the database queue lets start; the queue itself is queue.ts and the runs table.
export class QueueDispatcher {
  /** What settle() waits on while a run is queued: resolved when the run starts or is discarded. */
  private readonly queueLeft = new Map<string, { promise: Promise<void>; resolve: () => void }>();

  constructor(private readonly opts: QueueDispatcherOpts) {}

  /** The queue in line order, with what each run waits for. */
  list(): QueuedRunView[] {
    return listQueuedRuns(this.opts.db, this.opts.hasSecrets);
  }

  /** Start whatever the queue lets start, wherever a lock is let go or the line changes. It never
   *  throws, because its callers are runs ending, and a run must not fail over the next one's start: a
   *  database that refuses goes to the process log, and the next release or boot tries again. */
  dispatch(): void {
    if (this.opts.isStopping()) return;
    try {
      for (const runId of startQueuedRuns(this.opts.db, this.opts.hasSecrets)) {
        this.opts.fireExecute(runId);
        this.leave(runId);
      }
    } catch (err) {
      this.opts.logger.error({ err }, "the queued runs could not be started — they stay queued, and the next lock release or Manager start tries again");
    }
  }

  leave(runId: string): void {
    this.queueLeft.get(runId)?.resolve();
    this.queueLeft.delete(runId);
  }

  untilLeaves(runId: string): Promise<void> {
    let waiter = this.queueLeft.get(runId);
    if (!waiter) {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => { resolve = r; });
      waiter = { promise, resolve };
      this.queueLeft.set(runId, waiter);
    }
    return waiter.promise;
  }

  /** Whether the run started, and for a run left waiting a line in its log naming what it waits for. */
  startedOrQueued(runId: string): { status: "approved" | "queued" } {
    const place = this.list().find((q) => q.runId === runId);
    if (!place) return { status: "approved" };
    // Empty where every lock is free but the start failed: the next dispatch tries again.
    const what = place.waitsFor.length > 0 ? place.waitsFor.map((w) => `${w.resource} ${w.key} (run ${w.holderRunId})`).join(", ") : "the next start of the queue";
    appendRunMeta(this.opts.db, this.opts.bus, runId, `⏳ queued at place ${place.place}: it waits for ${what}`);
    return { status: "queued" };
  }
}
