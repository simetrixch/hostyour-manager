import { describe, it, expect } from "vitest";
import { relocationRun, relocationLine } from "./relocationBand.ts";
import type { RunView } from "../../shared/api-types.ts";

const run = (over: Partial<RunView>): RunView =>
  ({ id: "run_1", kind: "consumer-migrate", targetKind: "app", targetId: "app_1", status: "planned", summary: "", steps: [], requiredSecrets: [], requiredInputs: [], createdAt: 0, startedAt: null, endedAt: null, deletedAt: null, ...over }) as RunView;

describe("relocationRun", () => {
  it("surfaces an OPEN relocation run of THIS unit, and ignores other units and other kinds", () => {
    const runs = [
      run({ id: "r_other_unit", targetId: "app_2", status: "running" }),
      run({ id: "r_other_kind", kind: "consumer-offboard", status: "running" }),
      run({ id: "r_mine", kind: "consumer-backup", status: "planned" }),
    ];
    expect(relocationRun("app_1", runs)?.id).toBe("r_mine");
  });

  it("falls back to the most recent FAILED relocation run, and to nothing when the last one settled", () => {
    expect(relocationRun("app_1", [run({ id: "r_failed", status: "failed" })])?.id).toBe("r_failed");
    expect(relocationRun("app_1", [run({ id: "r_done", status: "succeeded" })])).toBeUndefined();
  });
});

describe("relocationLine", () => {
  it("names the run kind in plain words — a migrate reads as a MOVE", () => {
    expect(relocationLine(run({ kind: "tenant-migrate", status: "planned" }))).toBe("A move is planned — approve it");
    expect(relocationLine(run({ kind: "consumer-restore", status: "running" }))).toBe("A restore is running — watch it");
    expect(relocationLine(run({ kind: "tenant-backup", status: "failed" }))).toBe("The last backup failed — open it to retry");
  });
});
