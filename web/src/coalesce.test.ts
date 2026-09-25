import { describe, it, expect, vi, afterEach } from "vitest";
import { coalesced, RUN_REFRESH_WINDOW_MS } from "./coalesce.ts";

afterEach(() => vi.useRealTimers());

describe("coalesced — a burst of reasons is one call", () => {
  it("PLANTED DEFECT (the shape that broke a run screen): a replayed log of 1734 lines asks once, not 1734 times", () => {
    vi.useFakeTimers();
    let calls = 0;
    const c = coalesced(() => (calls += 1), RUN_REFRESH_WINDOW_MS);
    for (let i = 0; i < 1734; i += 1) c.call(); // the whole log arrives in one tick, as it does
    expect(calls, "it read the run while the burst was still arriving").toBe(0);
    vi.advanceTimersByTime(RUN_REFRESH_WINDOW_MS);
    expect(calls).toBe(1);
  });

  it("INNOCENT CASE: a lone reason still causes exactly one call, one window later", () => {
    vi.useFakeTimers();
    let calls = 0;
    coalesced(() => (calls += 1), RUN_REFRESH_WINDOW_MS).call();
    vi.advanceTimersByTime(RUN_REFRESH_WINDOW_MS - 1);
    expect(calls, "it ran before its own window closed").toBe(0);
    vi.advanceTimersByTime(1);
    expect(calls).toBe(1);
  });

  it("a live run keeps moving: reasons that arrive further apart than the window each get their read", () => {
    vi.useFakeTimers();
    let calls = 0;
    const c = coalesced(() => (calls += 1), RUN_REFRESH_WINDOW_MS);
    for (let i = 0; i < 3; i += 1) { c.call(); vi.advanceTimersByTime(RUN_REFRESH_WINDOW_MS); }
    expect(calls).toBe(3);
  });

  it("a screen taken down mid-window reads nothing afterwards", () => {
    vi.useFakeTimers();
    let calls = 0;
    const c = coalesced(() => (calls += 1), RUN_REFRESH_WINDOW_MS);
    c.call();
    c.cancel();
    vi.advanceTimersByTime(RUN_REFRESH_WINDOW_MS * 10);
    expect(calls, "it read the run after the screen was gone").toBe(0);
  });
});
