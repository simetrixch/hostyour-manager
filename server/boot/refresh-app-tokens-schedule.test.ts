// The App-token refresh on a timer (refresh-app-tokens-schedule.ts): every interval, never
// overlapping, never throwing through the timer, and armed once.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../kernel/logger.ts";
import { APP_TOKEN_REFRESH_INTERVAL_MS, scheduleAppTokenRefresh, stopAppTokenRefreshSchedule } from "./refresh-app-tokens-schedule.ts";
import { TOKEN_MIN_VALIDITY_MS } from "../adapters/github-app/github-app-http.ts";

const silent = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as unknown as Logger;

afterEach(() => {
  stopAppTokenRefreshSchedule();
  vi.useRealTimers();
});

describe("the App-token refresh's schedule", () => {
  it("never ticks slower than the App client's tokens last in a build secret", () => {
    // A token written at one tick is read by clones until the next tick, and a pipeline takes up to
    // five minutes to reach its clone after its trigger.
    expect(APP_TOKEN_REFRESH_INTERVAL_MS + 5 * 60_000).toBeLessThanOrEqual(TOKEN_MIN_VALIDITY_MS);
  });

  it("fires every 45 minutes — under the hour a token lives", async () => {
    expect(APP_TOKEN_REFRESH_INTERVAL_MS).toBe(45 * 60_000);
    expect(APP_TOKEN_REFRESH_INTERVAL_MS).toBeLessThan(60 * 60_000);
    vi.useFakeTimers();
    const refresh = vi.fn().mockResolvedValue(undefined);
    scheduleAppTokenRefresh(refresh, silent);
    await vi.advanceTimersByTimeAsync(APP_TOKEN_REFRESH_INTERVAL_MS - 1);
    expect(refresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2 * APP_TOKEN_REFRESH_INTERVAL_MS);
    expect(refresh).toHaveBeenCalledTimes(3);
  });

  it("never overlaps: a refresh that outlasts the interval is not started twice", async () => {
    vi.useFakeTimers();
    let release: () => void = () => {};
    const refresh = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    scheduleAppTokenRefresh(refresh, silent, 1000);
    await vi.advanceTimersByTimeAsync(3000);
    expect(refresh).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(1000);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("a refresh that rejects is logged and the schedule goes on", async () => {
    vi.useFakeTimers();
    const errors: unknown[] = [];
    const logger = { info: vi.fn(), error: (...a: unknown[]) => { errors.push(a); }, warn: vi.fn(), debug: vi.fn() } as unknown as Logger;
    const refresh = vi.fn().mockRejectedValue(new Error("vault unreachable"));
    scheduleAppTokenRefresh(refresh, logger, 1000);
    await vi.advanceTimersByTimeAsync(2000);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(errors)).toContain("vault unreachable");
  });

  it("schedules once: a second call is a no-op", async () => {
    vi.useFakeTimers();
    const refresh = vi.fn().mockResolvedValue(undefined);
    scheduleAppTokenRefresh(refresh, silent, 1000);
    scheduleAppTokenRefresh(refresh, silent, 1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
