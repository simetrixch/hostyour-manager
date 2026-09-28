import { describe, it, expect } from "vitest";
import type { UnitBackupView } from "../../shared/api-types-backups.ts";
import { backupChip, chosenGeneration, generationLabel, restorableGenerations } from "./backups.ts";

// What the Restore dialog offers of a unit's backup (hostyour-cloud#254).

const gen = (generation: string, over: Partial<UnitBackupView> = {}): UnitBackupView => ({ generation, trigger: "nightly", state: "ok", takenAt: 0, finishedAt: 0, detail: null, ...over });

describe("the generations a restore offers", () => {
  it("offers only written and verified generations, in the book's order", () => {
    const all = [gen("20260928T101500Z", { state: "taking" }), gen("20260928T030000Z"), gen("20260927T030000Z", { state: "failed" }), gen("20260926T030000Z", { state: "pruned" }), gen("20260925T030000Z")];
    expect(restorableGenerations(all).map((g) => g.generation)).toEqual(["20260928T030000Z", "20260925T030000Z"]);
  });

  it("reads a generation as its UTC moment and what took it", () => {
    expect(generationLabel(gen("20260928T030512Z", { trigger: "manual" }))).toBe("2026-09-28 03:05 UTC · manual");
  });

  it("refuses a restore confirmed without a generation", () => {
    expect(chosenGeneration("20260928T030000Z")).toBe("20260928T030000Z");
    expect(() => chosenGeneration(null)).toThrow(/without a backup generation/);
  });
});

describe("what a unit's row says about its backup", () => {
  const unit = { kind: "consumer" as const, unit: "acme", stage: "prod" };
  const latestOf = (over: Partial<UnitBackupView>) => ({ wired: true, latest: [{ ...gen("20260928T030512Z", over), kind: "consumer" as const, unit: "acme", stage: "prod" as const }] });

  it("names the day of the last good generation, and a failed one with its reason", () => {
    expect(backupChip(latestOf({}), unit)).toEqual({ label: "backup 2026-09-28", modifier: "chip--ok", detail: "2026-09-28 03:05 UTC · nightly" });
    expect(backupChip(latestOf({ state: "failed", detail: "job reloc-dump-mongo-acme did not succeed" }), unit)).toEqual({
      label: "backup failed", modifier: "chip--warn", detail: "2026-09-28 03:05 UTC · nightly: job reloc-dump-mongo-acme did not succeed",
    });
  });

  it("says none yet, that backups are off without a Storage Box, or that the book could not be read", () => {
    expect(backupChip({ wired: true, latest: [] }, unit)?.label).toBe("no backup yet");
    expect(backupChip({ wired: false, latest: [] }, unit)).toMatchObject({ label: "backups off", modifier: "chip--warn" });
    expect(backupChip({ error: "HTTP 500" }, unit)).toMatchObject({ label: "backup unknown", detail: "The latest backups could not be read: HTTP 500" });
    expect(backupChip(null, unit)).toBeNull();
  });
});
