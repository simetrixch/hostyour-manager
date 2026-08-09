import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { openDb, type DbHandle } from "../db/client.ts";
import { createLogger } from "../kernel/logger.ts";
import { parseConfig } from "../kernel/config.ts";
import { CredentialStore } from "../security/store.ts";
import { RunEventBus } from "./bus.ts";
import { Executor } from "./executor.ts";
import { getRun, listRuns } from "./read.ts";
import type { RunDefinition, AnyRunDefinition, Step } from "./types.ts";
import type { RunKind, RunStatus } from "../../shared/enums.ts";
import type { SshFactory } from "../adapters/ssh/port.ts";

const logger = createLogger(
  parseConfig({
    PUBLIC_URL: "https://x.example",
    OIDC_ISSUER: "https://i.example/",
    OIDC_CLIENT_ID: "c",
    OIDC_CLIENT_SECRET: "s",
    CONTROLLER_VERSION: "test",
    DATA_DIR: "/data",
    LOG_LEVEL: "silent",
  } as NodeJS.ProcessEnv),
);
const noSsh: SshFactory = () => Promise.reject(new Error("no ssh"));

// A controllable definition registered under the valid kind "noop": step 1 always logs
// (so every executed run OWNS event rows — exactly what soft-delete must retain), step 2
// fails while `failAct` is set. onTerminal records its calls so the planned-delete
// choreography (parity with discard) is observable.
let failAct = true;
const terminalCalls: RunStatus[] = [];
const testSteps: Step[] = [
  { name: "emit", title: "Emit output", run: async (ctx) => ctx.log("stdout", "hello from emit") },
  {
    name: "act",
    title: "Act",
    run: async () => {
      if (failAct) throw new Error("act-boom");
    },
  },
];
const testDef: RunDefinition = {
  kind: "noop",
  paramsSchema: z.record(z.string(), z.unknown()),
  mutating: false,
  plan: async () => ({
    kind: "noop",
    targetKind: "self",
    targetId: "controller",
    summary: "delete-run test",
    steps: testSteps.map((s) => ({ name: s.name, title: s.title })),
    warnings: [],
    requiredSecrets: [],
  }),
  steps: () => testSteps,
  onTerminal: (status) => void terminalCalls.push(status),
};

describe("Executor.deleteRun — the status gate + soft delete (row + logs retained)", () => {
  const handles: DbHandle[] = [];
  const dirs: string[] = [];
  function make(): { db: DbHandle; executor: Executor } {
    failAct = true;
    terminalCalls.length = 0;
    const dir = mkdtempSync(join(tmpdir(), "ctrl-del-"));
    dirs.push(dir);
    const db = openDb(join(dir, "controller.db"));
    handles.push(db);
    const store = new CredentialStore({ db: db.db, logger });
    const registry: Map<RunKind, AnyRunDefinition> = new Map([["noop", testDef]]);
    const executor = new Executor({ db: db.db, creds: store, bus: new RunEventBus(), logger, registry, sshFactory: noSsh, actor: () => "op_system" });
    return { db, executor };
  }
  afterEach(() => {
    for (const h of handles.splice(0)) h.sqlite.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  const count = (db: DbHandle, table: "runs" | "steps" | "events" | "run_locks", runId: string): number =>
    (db.sqlite.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${table === "runs" ? "id" : "run_id"}=?`).get(runId) as { n: number }).n;
  const deletedAtOf = (db: DbHandle, runId: string): number | null =>
    (db.sqlite.prepare("SELECT deleted_at AS d FROM runs WHERE id=?").get(runId) as { d: number | null }).d;

  it("soft-deletes a planned run — gone from the list, row + steps retained; onTerminal('cancelled') fired; audited", async () => {
    const { db, executor } = make();
    const { runId } = await executor.plan("noop", {});
    expect(getRun(db.db, runId)?.status).toBe("planned");
    expect(count(db, "steps", runId)).toBe(2);

    await executor.deleteRun(runId);

    // Gone from the operator's view…
    expect(listRuns(db.db).some((r) => r.id === runId)).toBe(false);
    // …but the row and its steps remain, marked deleted, and a direct link still resolves.
    expect(count(db, "runs", runId)).toBe(1);
    expect(count(db, "steps", runId)).toBe(2);
    expect(deletedAtOf(db, runId)).toBeGreaterThan(0);
    const view = getRun(db.db, runId);
    expect(view?.status).toBe("planned");
    expect(view?.deletedAt).toBe(deletedAtOf(db, runId));
    expect(terminalCalls).toEqual(["cancelled"]); // discard-parity choreography for a never-executed run
    const audit = db.sqlite.prepare("SELECT action FROM audit WHERE run_id=? ORDER BY ts").all(runId) as { action: string }[];
    expect(audit.map((a) => a.action)).toContain("run.deleted");
  });

  it("soft-deletes a failed run — its event log stays for retroactive inspection; held locks are cleared", async () => {
    const { db, executor } = make();
    const { runId } = await executor.plan("noop", {});
    await executor.approve(runId);
    await executor.settle(runId);
    expect(getRun(db.db, runId)?.status).toBe("failed");
    const eventsBefore = count(db, "events", runId);
    expect(eventsBefore).toBeGreaterThan(0); // "hello from emit" + meta lines
    terminalCalls.length = 0; // onTerminal("failed") already fired at failure time
    // Simulate the rare crash window where a failed run still holds a lock — a soft-deleted
    // (hidden) run must never keep pinning a resource.
    db.sqlite.prepare("INSERT INTO run_locks (resource, key, run_id) VALUES ('server', 'srv_stuck', ?)").run(runId);

    await executor.deleteRun(runId);

    // Hidden from the list, but the complete record survives in the DB.
    expect(listRuns(db.db).some((r) => r.id === runId)).toBe(false);
    expect(count(db, "runs", runId)).toBe(1);
    expect(count(db, "steps", runId)).toBe(2);
    expect(count(db, "events", runId)).toBe(eventsBefore);
    expect(count(db, "run_locks", runId)).toBe(0); // the lock was released
    expect(deletedAtOf(db, runId)).toBeGreaterThan(0);
    expect(terminalCalls).toEqual([]); // NOT re-fired for a failed run

    // events stays append-only throughout — no trigger was ever touched.
    const trig = db.sqlite.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='trigger' AND name='events_no_delete'").get() as { n: number };
    expect(trig.n).toBe(1);
    expect(() => db.sqlite.prepare("DELETE FROM events WHERE run_id=?").run(runId)).toThrow(/append-only/);
    // And the whole DB is still referentially sound.
    expect(db.sqlite.pragma("foreign_key_check")).toEqual([]);
  });

  it("is idempotent — deleting an already-deleted run is a no-op (one audit entry, one hook)", async () => {
    const { db, executor } = make();
    const { runId } = await executor.plan("noop", {});
    await executor.deleteRun(runId);
    const stamp = deletedAtOf(db, runId);

    await executor.deleteRun(runId); // second delete: succeeds, changes nothing

    expect(deletedAtOf(db, runId)).toBe(stamp);
    expect(terminalCalls).toEqual(["cancelled"]); // hook not re-fired
    const audit = db.sqlite.prepare("SELECT action FROM audit WHERE run_id=? AND action='run.deleted'").all(runId) as { action: string }[];
    expect(audit).toHaveLength(1);
  });

  it("soft-deletes a succeeded run — status stays succeeded, run hidden, row + log retained", async () => {
    const { db, executor } = make();
    failAct = false;
    const { runId } = await executor.plan("noop", {});
    await executor.approve(runId);
    await executor.settle(runId);
    expect(getRun(db.db, runId)?.status).toBe("succeeded");

    await executor.deleteRun(runId);
    // Soft-delete never changes status and never tears anything down; it only hides the run.
    expect(getRun(db.db, runId)?.status).toBe("succeeded");
    expect(deletedAtOf(db, runId)).not.toBeNull();
    expect(listRuns(db.db).some((r) => r.id === runId)).toBe(false);
  });

  it("soft-deletes a cancelled run (a discarded plan) — row + steps retained; terminal hook NOT re-fired", async () => {
    const { db, executor } = make();
    const { runId } = await executor.plan("noop", {});
    await executor.discard(runId); // planned → cancelled; onTerminal("cancelled") fires HERE
    expect(getRun(db.db, runId)?.status).toBe("cancelled");
    expect(terminalCalls).toEqual(["cancelled"]);

    await executor.deleteRun(runId);

    // Gone from the operator's view, complete record retained — exactly like a failed run.
    expect(listRuns(db.db).some((r) => r.id === runId)).toBe(false);
    expect(count(db, "runs", runId)).toBe(1);
    expect(count(db, "steps", runId)).toBe(2);
    expect(deletedAtOf(db, runId)).toBeGreaterThan(0);
    const view = getRun(db.db, runId);
    expect(view?.status).toBe("cancelled");
    expect(view?.deletedAt).toBe(deletedAtOf(db, runId));
    expect(terminalCalls).toEqual(["cancelled"]); // NOT re-fired — discard already ran the choreography
    const audit = db.sqlite.prepare("SELECT action FROM audit WHERE run_id=? ORDER BY ts").all(runId) as { action: string }[];
    expect(audit.map((a) => a.action)).toContain("run.deleted");
  });

  it("soft-deletes a run cancelled mid-execution — its event log stays for retroactive inspection", async () => {
    const { db, executor } = make();
    const { runId } = await executor.plan("noop", {});
    await executor.approve(runId);
    await executor.settle(runId); // executed → the run OWNS event rows
    const eventsBefore = count(db, "events", runId);
    expect(eventsBefore).toBeGreaterThan(0); // "hello from emit" + meta lines
    // Park it at cancelled (as an operator cancel mid-run would) — the log must survive delete.
    db.sqlite.prepare("UPDATE runs SET status='cancelled' WHERE id=?").run(runId);
    terminalCalls.length = 0;

    await executor.deleteRun(runId);

    expect(listRuns(db.db).some((r) => r.id === runId)).toBe(false);
    expect(count(db, "runs", runId)).toBe(1);
    expect(count(db, "steps", runId)).toBe(2);
    expect(count(db, "events", runId)).toBe(eventsBefore);
    expect(deletedAtOf(db, runId)).toBeGreaterThan(0);
    expect(terminalCalls).toEqual([]); // a cancelled run's hook fired at cancel time — never re-fired here
  });

  it("refuses an in-flight run (running/approved/planning) — 409", async () => {
    const { db, executor } = make();
    const { runId } = await executor.plan("noop", {});
    for (const status of ["running", "approved", "planning"]) {
      db.sqlite.prepare("UPDATE runs SET status=? WHERE id=?").run(status, runId);
      await expect(executor.deleteRun(runId)).rejects.toMatchObject({ code: "ILLEGAL_TRANSITION", http: 409 });
      expect(deletedAtOf(db, runId)).toBeNull();
    }
  });

  it("an unknown run id → NOT_FOUND 404", async () => {
    const { executor } = make();
    await expect(executor.deleteRun("run_nope")).rejects.toMatchObject({ code: "NOT_FOUND", http: 404 });
  });

  it("a soft-deleted run cannot be resurrected — approve refuses it", async () => {
    const { executor } = make();
    const { runId } = await executor.plan("noop", {});
    await executor.deleteRun(runId);
    await expect(executor.approve(runId)).rejects.toMatchObject({ code: "VALIDATION" });
  });
});
