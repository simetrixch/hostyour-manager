// The catalog carry on a timer (carry-catalog-schedule.ts): every interval, never overlapping, never
// throwing through the timer.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../kernel/logger.ts";
import { scheduleCatalogCarry, stopCatalogCarrySchedule } from "./carry-catalog-schedule.ts";

const silent = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as unknown as Logger;

afterEach(() => {
  stopCatalogCarrySchedule();
  vi.useRealTimers();
});

describe("the catalog carry's schedule", () => {
  it("runs the carry once per interval", async () => {
    vi.useFakeTimers();
    const carry = vi.fn().mockResolvedValue(undefined);
    scheduleCatalogCarry(carry, silent, 1000);
    expect(carry).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(carry).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(carry).toHaveBeenCalledTimes(3);
  });

  it("never overlaps: a carry that outlasts the interval is not started twice", async () => {
    vi.useFakeTimers();
    let release: () => void = () => {};
    const carry = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    scheduleCatalogCarry(carry, silent, 1000);
    await vi.advanceTimersByTimeAsync(3000);
    expect(carry).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(1000);
    expect(carry).toHaveBeenCalledTimes(2);
  });

  it("a carry that rejects is logged and the schedule goes on", async () => {
    vi.useFakeTimers();
    const errors: unknown[] = [];
    const logger = { info: vi.fn(), error: (...a: unknown[]) => { errors.push(a); }, warn: vi.fn(), debug: vi.fn() } as unknown as Logger;
    const carry = vi.fn().mockRejectedValue(new Error("origin refused"));
    scheduleCatalogCarry(carry, logger, 1000);
    await vi.advanceTimersByTimeAsync(2000);
    expect(carry).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(errors)).toContain("origin refused");
  });

  it("schedules once: a second call is a no-op", async () => {
    vi.useFakeTimers();
    const carry = vi.fn().mockResolvedValue(undefined);
    scheduleCatalogCarry(carry, silent, 1000);
    scheduleCatalogCarry(carry, silent, 1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(carry).toHaveBeenCalledTimes(1);
  });
});
