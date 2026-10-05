import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Logger } from "pino";
import { openDb, type DbHandle } from "../db/client.ts";
import type { Executor } from "../executor/executor.ts";
import { acquireLocks } from "../executor/locks.ts";
import { seedRunRows } from "../executor/run-rows.fixture.ts";
import { recordBackupStarted } from "../db/unit-backups.ts";
import { startDueNightlyBackup, stopNightlyBackupSchedule } from "./nightly-backup-schedule.ts";

// When the nightly pass starts (hostyour-cloud#254): once per UTC day from 03:00, one family per tick,
// never beside a run that holds a lock, and never twice for a day the book already has.

let db: DbHandle;
let started: string[];
let discarded: string[];
let refuse: string | null;
const logged: string[] = [];
const warned: string[] = [];
const logger = { info: (_o: unknown, m: string) => logged.push(m), warn: (_o: unknown, m: string) => { logged.push(m); warned.push(m); }, error: (_o: unknown, m: string) => logged.push(m) } as unknown as Logger;
const executor = {
  plan: async (kind: string) => {
    if (refuse === kind) throw new Error("requires the Hetzner Storage Box but none is wired");
    return { runId: `run_${kind}` };
  },
  approve: async (runId: string) => { started.push(runId); },
  discard: async (runId: string) => { discarded.push(runId); },
} as unknown as Executor;

beforeEach(() => {
  db = openDb(":memory:");
  started = [];
  discarded = [];
  refuse = null;
  logged.length = 0;
  warned.length = 0;
});
afterEach(() => {
  stopNightlyBackupSchedule();
  db.sqlite.close();
});

const at = (iso: string) => new Date(iso);

describe("the nightly backup schedule", () => {
  it("starts nothing before 03:00 UTC, then one family per tick, and nothing more that day", async () => {
    expect(await startDueNightlyBackup(executor, db.db, logger, at("2026-09-28T02:59:00Z"))).toBeNull();
    expect(await startDueNightlyBackup(executor, db.db, logger, at("2026-09-28T03:00:00Z"))).toBe("consumer-nightly-backup");
    expect(await startDueNightlyBackup(executor, db.db, logger, at("2026-09-28T03:15:00Z"))).toBe("tenant-nightly-backup");
    expect(await startDueNightlyBackup(executor, db.db, logger, at("2026-09-28T03:30:00Z"))).toBeNull();
    expect(started).toEqual(["run_consumer-nightly-backup", "run_tenant-nightly-backup"]);
    // The next day is due again, and a manager that was down at 03:00 starts at its first tick after.
    expect(await startDueNightlyBackup(executor, db.db, logger, at("2026-09-29T07:45:00Z"))).toBe("consumer-nightly-backup");
  });

  it("does not start a family whose units already hold a nightly generation of the day, as after a restart", async () => {
    recordBackupStarted(db.db, { kind: "consumer", unit: "acme", stage: "prod", generation: "20260928T030012Z", folder: "x", trigger: "nightly", runId: "run_before_restart" });
    expect(await startDueNightlyBackup(executor, db.db, logger, at("2026-09-28T05:00:00Z"))).toBe("tenant-nightly-backup");
  });

  it("waits while another run holds a lock, rather than leave a planned run behind", async () => {
    seedRunRows(db, { runId: "run_move", steps: [] });
    acquireLocks(db.db, "run_move", [{ resource: "master-kube", key: "m" }]);
    expect(await startDueNightlyBackup(executor, db.db, logger, at("2026-09-28T03:00:00Z"))).toBeNull();
    expect(started).toEqual([]);
  });

  it("says once a day why a family was not started, and moves on to the other", async () => {
    refuse = "consumer-nightly-backup";
    expect(await startDueNightlyBackup(executor, db.db, logger, at("2026-09-28T03:00:00Z"))).toBeNull();
    // A warning: tonight takes no generation of that family, and master's log alarm reads warnings.
    expect(warned).toEqual(["nightly backup was not started today"]);
    expect(await startDueNightlyBackup(executor, db.db, logger, at("2026-09-28T03:15:00Z"))).toBe("tenant-nightly-backup");
    expect(logged.filter((m) => m === "nightly backup was not started today")).toHaveLength(1);
  });
});
