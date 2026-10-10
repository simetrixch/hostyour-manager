import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { openDb, type DbHandle } from "../db/client.ts";
import { runs, steps, events } from "../db/schema/runs.ts";
import { runAsActor } from "../kernel/actor.ts";
import { getRun } from "./read.ts";
import { executorOver, plan, until, world } from "./queue.fixture.ts";

// The stamp columns of the run tables (db/schema/stamps.ts): drizzle writes them on every insert and
// update, from the actor the call chain is bound to, and a run executes bound to its owner. run_locks
// is covered in locks.test.ts, audit in audit-writer.test.ts.

let db: DbHandle;
afterEach(() => db?.sqlite.close());

interface Stamps { creation: number; modified: number; owner: string; modified_by: string }
const ROWS = { runs: "run_1", steps: "stp_1", events: "evt_1" } as const;

function open(): void {
  db = openDb(":memory:");
  db.sqlite.prepare("INSERT INTO operators (id, username, display_name, owner, modified_by) VALUES ('op_a', 'a', 'A', 'op_system', 'op_system'), ('op_b', 'b', 'B', 'op_system', 'op_system')").run();
}
function seed(): void {
  db.db.insert(runs).values({ id: ROWS.runs, kind: "noop", targetKind: "server", targetId: "srv_1", paramsJson: {}, planJson: {}, status: "planned" }).run();
  db.db.insert(steps).values({ id: ROWS.steps, runId: ROWS.runs, ordinal: 0, name: "a", title: "A" }).run();
  db.db.insert(events).values({ id: ROWS.events, runId: ROWS.runs, stream: "stdout", seq: 0, text: "x" }).run();
}
const stampsOf = (table: keyof typeof ROWS): Stamps =>
  db.sqlite.prepare(`SELECT creation, modified, owner, modified_by FROM ${table} WHERE id = ?`).get(ROWS[table]) as Stamps;

describe("the stamps of runs, steps and events", () => {
  it("name the bound operator on all four fields, and equal times, on an insert", () => {
    open();
    runAsActor("op_a", seed);
    for (const table of ["runs", "steps", "events"] as const) {
      const row = stampsOf(table);
      expect({ table, owner: row.owner, modifiedBy: row.modified_by, same: row.modified === row.creation }).toEqual({ table, owner: "op_a", modifiedBy: "op_a", same: true });
      expect(row.creation).toBeGreaterThan(0);
    }
  });

  it("name the system outside any request", () => {
    open();
    seed();
    for (const table of ["runs", "steps", "events"] as const) expect([table, stampsOf(table).owner, stampsOf(table).modified_by]).toEqual([table, "op_system", "op_system"]);
  });

  it("move modified and modified_by only when another operator updates the row", async () => {
    open();
    runAsActor("op_a", seed);
    const before = { runs: stampsOf("runs"), steps: stampsOf("steps") };
    await new Promise((r) => setTimeout(r, 5)); // the clock is read in milliseconds
    runAsActor("op_b", () => {
      db.db.update(runs).set({ status: "approved" }).where(eq(runs.id, ROWS.runs)).run();
      db.db.update(steps).set({ status: "running" }).where(eq(steps.id, ROWS.steps)).run();
    });
    for (const table of ["runs", "steps"] as const) {
      const after = stampsOf(table);
      expect({ table, creation: after.creation, owner: after.owner, modifiedBy: after.modified_by }).toEqual({ table, creation: before[table].creation, owner: "op_a", modifiedBy: "op_b" });
      expect(after.modified).toBeGreaterThan(before[table].modified);
    }
  });

  it("name a queued run's owner on what it writes, whoever's work dispatched it", async () => {
    open();
    const w = world();
    w.blocking.set("a", () => undefined);
    w.failing.add("b");
    const executor = executorOver(db, w.def);
    const a = await runAsActor("op_a", async () => {
      const id = await plan(executor, "a", ["deploy@main"]);
      await executor.approve(id);
      return id;
    });
    await until(() => w.started.includes("a"));
    const b = await runAsActor("op_b", async () => {
      const id = await plan(executor, "b", ["deploy@main"]);
      expect(await executor.approve(id)).toEqual({ status: "queued" });
      return id;
    });
    w.open("a"); // a ends inside its own work, as op_a, and that work dispatches b
    await executor.settle(b);
    expect([getRun(db.db, a)?.status, getRun(db.db, b)?.status]).toEqual(["succeeded", "failed"]);
    expect(db.sqlite.prepare("SELECT DISTINCT modified_by FROM steps WHERE run_id = ?").all(b)).toEqual([{ modified_by: "op_b" }]);
    expect(db.sqlite.prepare("SELECT DISTINCT owner FROM events WHERE run_id = ?").all(b)).toEqual([{ owner: "op_b" }]);
    expect(db.sqlite.prepare("SELECT owner FROM audit WHERE run_id = ? AND action = 'run.failed'").all(b)).toEqual([{ owner: "op_b" }]);
  });
});
