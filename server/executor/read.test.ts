import { describe, it, expect, afterEach } from "vitest";
import { openDb, type DbHandle } from "../db/client.ts";
import { getRunStepCheckpoint } from "./read.ts";
import { seedRunRows } from "./run-rows.fixture.ts";

describe("getRunStepCheckpoint", () => {
  let db: DbHandle;
  afterEach(() => {
    db?.sqlite.close();
  });

  it("reads the data member of a step checkpoint", () => {
    db = openDb(":memory:");
    const runId = "run_read_cp_1";
    seedRunRows(db, {
      runId,
      steps: [{ id: "step_1", name: "switch-dns" }],
    });

    // Write checkpoint JSON matching { data, __cleanups? } format
    const checkpointData = {
      switchedAt: 1700000000000,
      records: [{ name: "app.example.com", ttlSeconds: 300 }],
    };
    db.sqlite
      .prepare("UPDATE steps SET checkpoint_json = ? WHERE run_id = ? AND name = ?")
      .run(JSON.stringify({ data: checkpointData, __cleanups: [] }), runId, "switch-dns");

    const result = getRunStepCheckpoint<typeof checkpointData>(db.db, runId, "switch-dns");
    expect(result).toEqual(checkpointData);
  });

  it("returns undefined when step or checkpoint does not exist", () => {
    db = openDb(":memory:");
    const runId = "run_read_cp_2";
    seedRunRows(db, {
      runId,
      steps: [{ id: "step_2", name: "switch-dns" }],
    });

    expect(getRunStepCheckpoint(db.db, runId, "switch-dns")).toBeUndefined();
    expect(getRunStepCheckpoint(db.db, runId, "nonexistent-step")).toBeUndefined();
  });
});
