import { describe, expect, it } from "vitest";
import type { RunEventView } from "../../shared/api-types.ts";
import { followRunLog, RUN_LOG_RETRY_MS, type RunLogSource } from "./runLogFollow.ts";

/** A stand-in for one EventSource: the test plays the server through `deliver`, `end` and `drop`. */
class FakeSource implements RunLogSource {
  closed = false;
  private readonly listeners = new Map<string, (e: MessageEvent) => void>();
  constructor(readonly after: number) {}
  addEventListener(type: string, listener: (e: MessageEvent) => void): void {
    this.listeners.set(type, listener);
  }
  close(): void {
    this.closed = true;
  }
  deliver(seq: number): void {
    const e: RunEventView = { seq, stream: "meta", text: `line ${seq}`, at: 0 };
    this.listeners.get(e.stream)?.({ data: JSON.stringify(e) } as MessageEvent);
  }
  end(): void {
    this.listeners.get("end")?.({ data: "" } as MessageEvent);
  }
  drop(): void {
    this.listeners.get("error")?.({ data: "" } as MessageEvent);
  }
}

function harness() {
  const sources: FakeSource[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const lines: number[] = [];
  let ended = 0;
  const stop = followRunLog(
    (after) => {
      const s = new FakeSource(after);
      sources.push(s);
      return s;
    },
    { line: (e) => lines.push(e.seq), ended: () => ended++ },
    (fn, ms) => {
      timers.push({ fn, ms });
    },
  );
  const fire = () => timers.splice(0).forEach((t) => t.fn());
  return { sources, timers, lines, ended: () => ended, fire, stop };
}

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

describe("followRunLog", () => {
  it("PLANTED: a stream dropped after line 3 reopens from line 3, and the run's 20 lines arrive once each", () => {
    const h = harness();
    range(0, 3).forEach((seq) => h.sources[0]!.deliver(seq));
    h.sources[0]!.drop();
    expect(h.sources[0]!.closed).toBe(true);
    expect(h.timers.map((t) => t.ms)).toEqual([RUN_LOG_RETRY_MS]);
    h.fire();
    expect(h.sources.map((s) => s.after)).toEqual([-1, 3]);
    range(3, 19).forEach((seq) => h.sources[1]!.deliver(seq)); // a server that repeats line 3 doubles nothing
    h.sources[1]!.end();
    expect(h.lines).toEqual(range(0, 19));
    expect(h.ended()).toBe(1);
  });

  it("a stream dropped while the run is still planning reopens from its last line and goes on following", () => {
    const h = harness();
    h.sources[0]!.deliver(0);
    h.sources[0]!.drop();
    h.fire();
    h.sources[1]!.deliver(1);
    h.sources[1]!.drop();
    h.fire();
    expect(h.sources.map((s) => s.after)).toEqual([-1, 0, 1]);
    h.sources[2]!.deliver(2);
    expect(h.lines).toEqual([0, 1, 2]);
    expect(h.ended()).toBe(0);
  });

  it("the server's end closes the stream for good: no reopen follows", () => {
    const h = harness();
    h.sources[0]!.deliver(0);
    h.sources[0]!.end();
    expect(h.sources[0]!.closed).toBe(true);
    h.sources[0]!.drop(); // the browser reports the close the server made
    expect(h.timers).toEqual([]);
    expect(h.sources).toHaveLength(1);
  });

  it("stop closes the stream and cancels a pending reopen", () => {
    const h = harness();
    h.sources[0]!.drop();
    h.stop();
    h.fire();
    expect(h.sources).toHaveLength(1);
  });
});
