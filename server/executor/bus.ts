import type { RunEventView } from "../../shared/api-types.ts";

export type RunEventListener = (event: RunEventView) => void;

/**
 * In-process pub/sub for live run output. Map<runId, Set<listener>> —
 * the SSE route subscribes; ctx.log() publishes. No cross-process delivery (one-process
 * product); reconnect replay comes from the events table, not the bus.
 */
export class RunEventBus {
  private readonly subs = new Map<string, Set<RunEventListener>>();

  subscribe(runId: string, fn: RunEventListener): () => void {
    const set = this.subs.get(runId) ?? new Set<RunEventListener>();
    set.add(fn);
    this.subs.set(runId, set);
    return () => {
      const s = this.subs.get(runId);
      if (!s) return;
      s.delete(fn);
      if (s.size === 0) this.subs.delete(runId);
    };
  }

  publish(runId: string, event: RunEventView): void {
    const set = this.subs.get(runId);
    if (!set) return;
    for (const fn of set) fn(event);
  }

  subscriberCount(runId: string): number {
    return this.subs.get(runId)?.size ?? 0;
  }
}
