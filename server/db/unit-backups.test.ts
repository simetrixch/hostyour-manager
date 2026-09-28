import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDb, type DbHandle } from "./client.ts";
import { findBackup, findBackupOfRun, listBackups, recordBackupFinished, recordBackupPruned, recordBackupStarted } from "./unit-backups.ts";

// The book of backups: one row per generation of a unit's backup, never a byte of it (hostyour-cloud#254).

let db: DbHandle;
beforeEach(() => { db = openDb(":memory:"); });
afterEach(() => { db.sqlite.close(); });

const unit = { kind: "tenant" as const, unit: "zsjs023ctne0", stage: "prod" as const };
const start = (generation: string, runId: string | null) =>
  recordBackupStarted(db.db, { ...unit, generation, folder: `master.example/prod/tenants/zsjs023ctne0/${generation}`, trigger: runId ? "manual" : "nightly", runId });

describe("the book of backups", () => {
  it("lists a unit's generations newest first, each as it was settled, and keeps other units apart", () => {
    start("20260927T030000Z", null);
    start("20260928T030000Z", null);
    start("20260928T101500Z", "run_1");
    recordBackupStarted(db.db, { ...unit, stage: "test", generation: "20260928T030000Z", folder: "x", trigger: "nightly", runId: null });
    recordBackupFinished(db.db, { ...unit, generation: "20260927T030000Z" }, { state: "ok" });
    recordBackupFinished(db.db, { ...unit, generation: "20260928T030000Z" }, { state: "failed", detail: "job reloc-dump-mongo did not succeed" });
    recordBackupPruned(db.db, { ...unit, generation: "20260927T030000Z" });

    expect(listBackups(db.db, unit).map((b) => [b.generation, b.state, b.detail])).toEqual([
      ["20260928T101500Z", "taking", null],
      ["20260928T030000Z", "failed", "job reloc-dump-mongo did not succeed"],
      ["20260927T030000Z", "pruned", null],
    ]);
    expect(listBackups(db.db, { ...unit, stage: "test" })).toHaveLength(1);
  });

  it("finds a generation by itself and by the run that took it", () => {
    start("20260928T101500Z", "run_1");
    expect(findBackupOfRun(db.db, "run_1")?.generation).toBe("20260928T101500Z");
    expect(findBackupOfRun(db.db, "run_2")).toBeUndefined();
    expect(findBackup(db.db, { ...unit, generation: "20260928T101500Z" })?.folder).toBe("master.example/prod/tenants/zsjs023ctne0/20260928T101500Z");
    expect(findBackup(db.db, { ...unit, generation: "20260101T000000Z" })).toBeUndefined();
  });
});
