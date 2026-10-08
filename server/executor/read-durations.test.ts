import { describe, it, expect, afterEach } from "vitest";
import { openDb, type DbHandle } from "../db/client.ts";
import { runs } from "../db/schema/runs.ts";
import type { RunStatus } from "../../shared/enums.ts";
import { listRunDurations, listRuns } from "./read.ts";

let db: DbHandle;
afterEach(() => db?.sqlite.close());

let seq = 0;
function seedRun(o: { kind: string; status: RunStatus; minutes?: number; endedAt?: number; deleted?: boolean; startedBy?: string }): void {
  const endedAt = o.endedAt ?? 1_700_000_000_000 + seq * 1000;
  db.db.insert(runs).values({
    id: `run_${++seq}`,
    kind: o.kind,
    targetKind: "server",
    targetId: "srv_1",
    paramsJson: {},
    planJson: {},
    status: o.status,
    startedBy: o.startedBy ?? "op_system",
    startedAt: o.minutes === undefined ? null : new Date(endedAt - o.minutes * 60_000),
    finishedAt: o.minutes === undefined ? null : new Date(endedAt),
    deletedAt: o.deleted ? new Date(endedAt) : null,
  }).run();
}

describe("listRunDurations", () => {
  it("takes the median of the succeeded runs of each kind and says how many it is taken from", () => {
    db = openDb(":memory:");
    for (const minutes of [4, 10, 6]) seedRun({ kind: "cluster-redeploy", status: "succeeded", minutes });
    seedRun({ kind: "noop", status: "succeeded", minutes: 1 });
    seedRun({ kind: "noop", status: "succeeded", minutes: 3 });
    expect(listRunDurations(db.db).sort((a, b) => a.kind.localeCompare(b.kind))).toEqual([
      { kind: "cluster-redeploy", typicalMs: 6 * 60_000, sampleSize: 3 },
      { kind: "noop", typicalMs: 2 * 60_000, sampleSize: 2 },
    ]);
  });

  it("leaves out failed, cancelled, unstarted and deleted runs", () => {
    db = openDb(":memory:");
    seedRun({ kind: "noop", status: "succeeded", minutes: 5 });
    seedRun({ kind: "noop", status: "failed", minutes: 1 });
    seedRun({ kind: "noop", status: "cancelled", minutes: 1 });
    seedRun({ kind: "noop", status: "succeeded", minutes: 1, deleted: true });
    seedRun({ kind: "noop", status: "planned" });
    seedRun({ kind: "tenant-check", status: "failed", minutes: 2 });
    expect(listRunDurations(db.db)).toEqual([{ kind: "noop", typicalMs: 5 * 60_000, sampleSize: 1 }]);
  });

  it("counts only the newest runs of a kind, so an old slow run stops weighing", () => {
    db = openDb(":memory:");
    seedRun({ kind: "noop", status: "succeeded", minutes: 60, endedAt: 1_000_000 });
    seedRun({ kind: "noop", status: "succeeded", minutes: 2, endedAt: 9_000_000 });
    seedRun({ kind: "noop", status: "succeeded", minutes: 2, endedAt: 9_500_000 });
    expect(listRunDurations(db.db, 2)).toEqual([{ kind: "noop", typicalMs: 2 * 60_000, sampleSize: 2 }]);
  });
});

describe("listRuns", () => {
  it("names the operator who started each run by display name", () => {
    db = openDb(":memory:");
    db.sqlite.prepare("INSERT INTO operators (id, username, display_name) VALUES ('op_sample', 'sample', 'Sample Operator')").run();
    seedRun({ kind: "noop", status: "planned", startedBy: "op_sample" });
    seedRun({ kind: "noop", status: "planned" });
    expect(listRuns(db.db).map((r) => r.startedBy).sort()).toEqual(["Sample Operator", "System"]);
  });
});
