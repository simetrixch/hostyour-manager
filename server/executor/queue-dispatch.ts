import type { Db } from "../db/client.ts";
import type { RunEventBus } from "./bus.ts";
import type { Logger } from "../kernel/logger.ts";
import { findFailedHolder, listQueuedRuns, startQueuedRuns, type HasSecrets } from "./queue.ts";
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

  /** The holders a waiting run was already warned about, so each pair is written once per process. */
  private readonly warned = new Map<string, Set<string>>();

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
    this.warnAboutFailedHolders();
  }

  /** A failed or cancelled run keeps its locks and never lets go by itself, so a run queued behind one
   *  waits until somebody retries, aborts or deletes it, and nothing else tells anyone. One warn line
   *  per waiting run and holder (the first lock they collide on), which the master's log alarm mails.
   *  It never throws, for the same reason dispatch() does not. */
  private warnAboutFailedHolders(): void {
    try {
      for (const q of this.list()) {
        const reported = this.warned.get(q.runId) ?? new Set<string>();
        for (const w of q.waitsFor) {
          if (reported.has(w.holderRunId)) continue;
          const holder = findFailedHolder(this.opts.db, w.holderRunId);
          if (!holder) continue;
          reported.add(w.holderRunId);
          this.opts.logger.warn(
            { waitingRunId: q.runId, waitingKind: q.kind, holderRunId: holder.runId, holderKind: holder.kind, holderStatus: holder.status, holderFailedStep: holder.failedStep, holderError: holder.error, resource: w.resource, key: w.key },
            "a run waits behind a failed run's lock",
          );
        }
        if (reported.size > 0) this.warned.set(q.runId, reported);
      }
    } catch (err) {
      this.opts.logger.error({ err }, "could not check whether a queued run waits behind a failed run — the next lock release or change of the queue checks again");
    }
  }

  leave(runId: string): void {
    this.warned.delete(runId);
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
    const what = place.waitsFor.length > 0 ? place.waitsFor.map((w) => `${w.resource} ${w.key} (run ${w.holderRunId}${this.failedNote(w.holderRunId)})`).join(", ") : "the next start of the queue";
    appendRunMeta(this.opts.db, this.opts.bus, runId, `⏳ queued at place ${place.place}: it waits for ${what}`);
    return { status: "queued" };
  }

  /** ", failed at step X" for a holder that ended in the middle, nothing for one still going. */
  private failedNote(holderRunId: string): string {
    const holder = findFailedHolder(this.opts.db, holderRunId);
    return holder ? `, ${holder.status}${holder.failedStep ? ` at step ${holder.failedStep}` : ""}` : "";
  }
}
