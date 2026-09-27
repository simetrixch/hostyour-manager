import { describe, it, expect } from "vitest";
import { msUntilHour } from "./registry-reap-schedule.ts";

// The reaper runs once a day at the configured hour, UTC: the wait is measured to the next such
// hour, and a boot at the hour itself waits a whole day.
describe("msUntilHour", () => {
  const HOUR = 3_600_000;
  it("waits until the hour on the same day, or the next day once it has passed", () => {
    expect(msUntilHour(new Date("2026-09-27T01:30:00Z"), 3)).toBe(1.5 * HOUR);
    expect(msUntilHour(new Date("2026-09-27T04:00:00Z"), 3)).toBe(23 * HOUR);
    expect(msUntilHour(new Date("2026-09-27T03:00:00Z"), 3)).toBe(24 * HOUR);
  });

  it("crosses a month end", () => {
    expect(msUntilHour(new Date("2026-09-30T23:00:00Z"), 3)).toBe(4 * HOUR);
  });
});
