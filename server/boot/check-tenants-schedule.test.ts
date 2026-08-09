import { afterEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "pino";
import type { Executor } from "../executor/executor.ts";
import { scheduleTenantCheck, startTenantCheck, stopTenantCheckSchedule } from "./check-tenants-schedule.ts";

const silent = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as unknown as Logger;

afterEach(() => {
  stopTenantCheckSchedule();
  vi.useRealTimers();
});

describe("the tenant administrator check's schedule", () => {
  it("STARTS A RUN — it does not do the work itself", () => {
    // The whole reason this is a run: a check that did its work in a timer would leave nothing in
    // the run list, and being visible there is what the check exists for.
    const plan = vi.fn().mockResolvedValue({ runId: "run_1", plan: {} });
    const approve = vi.fn().mockResolvedValue(undefined);
    const executor = { plan, approve } as unknown as Executor;

    return startTenantCheck(executor, silent).then((started) => {
      expect(started).toBe(true);
      expect(plan).toHaveBeenCalledWith("check-tenants", {});
      // approve() is what the operator's button does. There is nothing to read and nothing to
      // decide — the check changes no cluster — so it is approved immediately.
      expect(approve).toHaveBeenCalledWith("run_1");
    });
  });

  it("a manager without the tenant family answers false rather than throwing", async () => {
    // A run kind that is not registered is a normal state — the tenant family is built only when its
    // adapters are configured — and a timer tick must never crash the server.
    const executor = {
      plan: vi.fn().mockRejectedValue(new Error("unknown run kind: check-tenants")),
      approve: vi.fn(),
    } as unknown as Executor;

    await expect(startTenantCheck(executor, silent)).resolves.toBe(false);
  });

  it("a failing approve is reported and never crashes the caller", async () => {
    const executor = {
      plan: vi.fn().mockResolvedValue({ runId: "run_1", plan: {} }),
      approve: vi.fn().mockRejectedValue(new Error("locked")),
    } as unknown as Executor;

    await expect(startTenantCheck(executor, silent)).resolves.toBe(false);
  });

  it("waits before the first check, then repeats", async () => {
    vi.useFakeTimers();
    const plan = vi.fn().mockResolvedValue({ runId: "run_1", plan: {} });
    const executor = { plan, approve: vi.fn().mockResolvedValue(undefined) } as unknown as Executor;

    scheduleTenantCheck(executor, silent);
    // Nothing on boot: a restart loop must not fill the run list, and the pod should be serving
    // before it starts asking other services anything.
    expect(plan).not.toHaveBeenCalled();

    // ByTimeAsync, not ByTime: the inFlight guard is only released when the previous check's
    // promise settles, and a synchronous advance never lets it. That is the guard working — two
    // checks must never overlap and write the same rows from both.
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(plan).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
    expect(plan).toHaveBeenCalledTimes(2);
  });

  it("never overlaps: a check that has not settled blocks the next tick", async () => {
    vi.useFakeTimers();
    // A check over many tenants, each with its own budget, can outlast a tick. Two of them would
    // ask every tenant twice and write its row from both.
    let release: () => void = () => {};
    const plan = vi.fn().mockReturnValue(new Promise((r) => {
      release = () => r({ runId: "run_1", plan: {} });
    }));
    const executor = { plan, approve: vi.fn().mockResolvedValue(undefined) } as unknown as Executor;

    scheduleTenantCheck(executor, silent);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(plan).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(18 * 60 * 60 * 1000);
    expect(plan).toHaveBeenCalledTimes(1);

    release();
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
    expect(plan).toHaveBeenCalledTimes(2);
  });

  it("arming it twice arms one schedule", () => {
    vi.useFakeTimers();
    const plan = vi.fn().mockResolvedValue({ runId: "run_1", plan: {} });
    const executor = { plan, approve: vi.fn().mockResolvedValue(undefined) } as unknown as Executor;

    scheduleTenantCheck(executor, silent);
    scheduleTenantCheck(executor, silent);
    vi.advanceTimersByTime(5 * 60 * 1000);

    expect(plan).toHaveBeenCalledTimes(1);
  });

  it("stopping it stops it", () => {
    vi.useFakeTimers();
    const plan = vi.fn().mockResolvedValue({ runId: "run_1", plan: {} });
    const executor = { plan, approve: vi.fn().mockResolvedValue(undefined) } as unknown as Executor;

    scheduleTenantCheck(executor, silent);
    stopTenantCheckSchedule();
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);

    expect(plan).not.toHaveBeenCalled();
  });
});
