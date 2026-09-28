import { describe, it, expect } from "vitest";
import { generationsToKeep } from "./backup-retention.ts";

// The owner's retention of 2026-09-28: 7 daily and 4 weekly (hostyour-cloud#254).

const nightly = (from: string, days: number): string[] =>
  Array.from({ length: days }, (_, n) => new Date(Date.parse(from) + n * 86_400_000).toISOString().slice(0, 10).replace(/-/g, "") + "T030000Z");

describe("retention of a unit's generations", () => {
  it("keeps the newest seven and the newest of each of the four most recent weeks, and nothing else", () => {
    // Forty nights ending on Monday 2026-09-28.
    const kept = [...generationsToKeep(nightly("2026-08-20", 40))].sort();
    expect(kept).toEqual([
      "20260913T030000Z", // the newest of the week of Monday 2026-09-07
      "20260920T030000Z", // the newest of the week of Monday 2026-09-14
      "20260922T030000Z", "20260923T030000Z", "20260924T030000Z", "20260925T030000Z", "20260926T030000Z", "20260927T030000Z", "20260928T030000Z",
    ]);
  });

  it("keeps everything of a unit that has fewer generations than the rule reaches", () => {
    const few = ["20260927T030000Z", "20260928T030000Z", "20260928T101500Z"];
    expect([...generationsToKeep(few)].sort()).toEqual(few);
  });

  it("counts a manual generation like a nightly one: the newest seven are the newest seven", () => {
    // Fourteen nights up to 2026-09-26, and a Backup at noon of that day.
    const kept = generationsToKeep([...nightly("2026-09-13", 14), "20260926T120000Z"]);
    expect([...kept].sort()).toEqual([
      "20260913T030000Z", // the newest of the week of Monday 2026-09-07
      "20260920T030000Z", // the newest of the week of Monday 2026-09-14, pushed out of the newest seven by the Backup
      "20260921T030000Z", "20260922T030000Z", "20260923T030000Z", "20260924T030000Z", "20260925T030000Z", "20260926T030000Z", "20260926T120000Z",
    ]);
  });
});
