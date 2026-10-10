import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pino, type Logger } from "pino";
import { eq } from "drizzle-orm";
import { openDb, type DbHandle } from "../db/client.ts";
import { runLocks } from "../db/schema/runs.ts";
import { runAsActor } from "../kernel/actor.ts";
import type { Executor } from "./executor.ts";
import { getRun, readEvents } from "./read.ts";
import { listLocks, releaseLocks } from "./locks.ts";
import { findFailedHolder, startQueuedRuns } from "./queue.ts";
import { seedRunRows } from "./run-rows.fixture.ts";
import { SECRET, executorOver, plan, until, world } from "./queue.fixture.ts";
import type { AnyRunDefinition } from "./types.ts";

const TYPED = "a-typed-value-never-stored";

describe("the run queue", () => {
  const handles: DbHandle[] = [];
  const dirs: string[] = [];
  afterEach(() => {
    for (const h of handles.splice(0)) h.sqlite.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function file(): string {
    const dir = mkdtempSync(join(tmpdir(), "mgr-queue-"));
    dirs.push(dir);
    return join(dir, "manager.db");
  }
  function managerOver(path: string, def: AnyRunDefinition, log?: Logger): { db: DbHandle; executor: Executor } {
    const db = openDb(path);
    handles.push(db);
    return { db, executor: executorOver(db, def, log) };
  }
  const status = (db: DbHandle, runId: string) => getRun(db.db, runId)?.status;
  const secrets = () => ({ [SECRET]: Buffer.from(TYPED) });

  it("queues an approve that meets a held lock, and starts the run once the holder ends", async () => {
    const w = world();
    w.blocking.set("a", () => undefined);
    const { db, executor } = managerOver(file(), w.def);
    const a = await plan(executor, "a", ["deploy@main"]);
    const b = await plan(executor, "b", ["deploy@main"]);
    expect(await executor.approve(a)).toEqual({ status: "approved" });
    await until(() => w.started.includes("a"));
    expect(await executor.approve(b)).toEqual({ status: "queued" });
    expect(executor.listQueue()).toEqual([expect.objectContaining({ runId: b, place: 1, needsSecrets: false, waitsFor: [{ resource: "git-branch", key: "deploy@main", holderRunId: a }] })]);
    expect(readEvents(db.db, b).map((e) => e.text)).toContain(`⏳ queued at place 1: it waits for git-branch deploy@main (run ${a})`);
    expect(w.started).toEqual(["a"]);
    w.open("a");
    await executor.settle(b);
    expect(w.started).toEqual(["a", "b"]);
    expect([status(db, a), status(db, b)]).toEqual(["succeeded", "succeeded"]);
    expect(listLocks(db.db)).toEqual([]);
  });

  it("lets no run overtake on a shared lock, and holds back no run that shares nothing", async () => {
    const w = world();
    w.blocking.set("a", () => undefined);
    const { db, executor } = managerOver(file(), w.def);
    const a = await plan(executor, "a", ["one"]);
    const b = await plan(executor, "b", ["one", "two"]);
    const c = await plan(executor, "c", ["two"]);
    const d = await plan(executor, "d", ["three"]);
    await executor.approve(a);
    await until(() => w.started.includes("a"));
    expect(await executor.approve(b)).toEqual({ status: "queued" });
    // `two` is free, but b waits for it ahead of c in line.
    expect(await executor.approve(c)).toEqual({ status: "queued" });
    expect(executor.listQueue().find((q) => q.runId === c)?.waitsFor).toEqual([{ resource: "git-branch", key: "two", holderRunId: b }]);
    expect(await executor.approve(d)).toEqual({ status: "approved" });
    await executor.settle(d);
    expect(status(db, d)).toBe("succeeded");
    w.open("a");
    await executor.settle(c);
    expect(w.started).toEqual(["a", "d", "b", "c"]);
  });

  it("never starts a run twice when two dispatchers meet one queued run", async () => {
    const w = world();
    w.blocking.set("a", () => undefined);
    const path = file();
    const { db, executor } = managerOver(path, w.def);
    const a = await plan(executor, "a", ["deploy@main"]);
    const b = await plan(executor, "b", ["deploy@main"]);
    await executor.approve(a);
    await until(() => w.started.includes("a"));
    await executor.approve(b);
    releaseLocks(db.db, a); // the holder's lock goes, nobody dispatches yet
    const second = openDb(path);
    handles.push(second);
    const first = startQueuedRuns(db.db, () => true);
    const again = startQueuedRuns(second.db, () => true);
    expect([first, again]).toEqual([[b], []]);
    expect(listLocks(db.db).map((l) => l.runId)).toEqual([b]);
    w.open("a");
  });

  it("starts a queued run as its owner, not as the operator whose run freed its claims", async () => {
    const w = world();
    w.blocking.set("a", () => undefined);
    const { db, executor } = managerOver(file(), w.def);
    db.sqlite.prepare("INSERT INTO operators (id, username, display_name, owner, modified_by) VALUES ('op_alice', 'alice', 'Alice', 'op_system', 'op_system'), ('op_bob', 'bob', 'Bob', 'op_system', 'op_system')").run();
    const a = await runAsActor("op_alice", () => plan(executor, "a", ["deploy@main"]));
    const b = await runAsActor("op_bob", () => plan(executor, "b", ["deploy@main"]));
    await runAsActor("op_alice", () => executor.approve(a));
    await until(() => w.started.includes("a"));
    expect(await runAsActor("op_bob", () => executor.approve(b))).toEqual({ status: "queued" });
    w.open("a");
    await executor.settle(b);
    expect(db.db.select({ owner: runLocks.owner }).from(runLocks).where(eq(runLocks.runId, b)).all()).toEqual([{ owner: "op_bob" }]);
  });

  it("keeps the queue across a Manager restart, and starts the run once its failed holder is deleted", async () => {
    const w = world();
    w.failing.add("a");
    const path = file();
    const before = managerOver(path, w.def);
    const a = await plan(before.executor, "a", ["deploy@main"]);
    const b = await plan(before.executor, "b", ["deploy@main"]);
    await before.executor.approve(a);
    await before.executor.settle(a);
    expect(status(before.db, a)).toBe("failed");
    expect(await before.executor.approve(b)).toEqual({ status: "queued" });

    const after = managerOver(path, w.def);
    await after.executor.resumeOnBoot();
    expect(status(after.db, b)).toBe("queued"); // the failed holder still holds deploy@main
    await after.executor.deleteRun(a);
    await after.executor.settle(b);
    expect(status(after.db, b)).toBe("succeeded");
  });

  it("cancels a queued run: it takes no lock, and the run behind it moves up", async () => {
    const w = world();
    w.blocking.set("a", () => undefined);
    const { db, executor } = managerOver(file(), w.def);
    const a = await plan(executor, "a", ["one"]);
    const b = await plan(executor, "b", ["one", "two"]);
    const c = await plan(executor, "c", ["two"]);
    await executor.approve(a);
    await until(() => w.started.includes("a"));
    await executor.approve(b, secrets());
    await executor.approve(c);
    const settledB = executor.settle(b);
    await executor.cancel(b);
    await settledB;
    expect(status(db, b)).toBe("cancelled");
    expect(listLocks(db.db).some((l) => l.runId === b)).toBe(false);
    await executor.settle(c);
    expect(status(db, c)).toBe("succeeded");
    expect(w.started).toEqual(["a", "c"]);
    w.open("a");
  });

  it("decision 1 a: a failed holder keeps its locks; the queue waits until a retry reuses them to the end", async () => {
    const w = world();
    w.failing.add("a");
    const { db, executor } = managerOver(file(), w.def);
    const a = await plan(executor, "a", ["deploy@main"]);
    const b = await plan(executor, "b", ["deploy@main"]);
    await executor.approve(a);
    await executor.settle(a);
    expect(status(db, a)).toBe("failed");
    expect(listLocks(db.db).map((l) => [l.key, l.runId])).toEqual([["deploy@main", a]]);
    expect(await executor.approve(b)).toEqual({ status: "queued" });
    expect(executor.listQueue()[0]?.waitsFor).toEqual([{ resource: "git-branch", key: "deploy@main", holderRunId: a }]);

    w.failing.delete("a");
    w.blocking.set("a", () => undefined);
    await executor.retryFromStep(a);
    await until(() => w.started.length === 2);
    expect(listLocks(db.db).map((l) => [l.key, l.runId])).toEqual([["deploy@main", a]]);
    expect(status(db, b)).toBe("queued");
    w.open("a");
    await executor.settle(a);
    await executor.settle(b);
    expect([status(db, a), status(db, b)]).toEqual(["succeeded", "succeeded"]);
    expect(w.started).toEqual(["a", "a", "b"]);
  });

  it("decision 1 a: an abort with nothing to clean up lets the failed holder's locks go, and the queue moves", async () => {
    const w = world();
    w.failing.add("a");
    const { db, executor } = managerOver(file(), w.def);
    const a = await plan(executor, "a", ["deploy@main"]);
    const b = await plan(executor, "b", ["deploy@main"]);
    await executor.approve(a);
    await executor.settle(a);
    await executor.approve(b);
    await executor.abortWithCleanup(a);
    expect(status(db, a)).toBe("cancelled");
    await executor.settle(b);
    expect(status(db, b)).toBe("succeeded");
  });

  it("a cancel in the middle keeps the locks, and a skip runs on under them", async () => {
    const w = world();
    w.blocking.set("a", () => undefined);
    const { db, executor } = managerOver(file(), w.def);
    const a = await plan(executor, "a", ["deploy@main"]);
    const b = await plan(executor, "b", ["deploy@main"]);
    await executor.approve(a);
    await until(() => w.started.includes("a"));
    const cancelled = executor.cancel(a);
    w.failing.add("a"); // the step ends by throwing, the way a step that honours the abort ends
    w.open("a");
    await cancelled;
    expect(status(db, a)).toBe("cancelled");
    expect(listLocks(db.db).map((l) => l.runId)).toEqual([a]);
    expect(await executor.approve(b)).toEqual({ status: "queued" });
    await executor.skipStep(a, "change", "done by hand on the box");
    await executor.settle(a);
    await executor.settle(b);
    expect([status(db, a), status(db, b)]).toEqual(["succeeded", "succeeded"]);
  });

  it("a retry of a failed run that holds no lock takes its locks, or is refused while another run holds one", async () => {
    const w = world();
    w.failing.add("a");
    w.blocking.set("c", () => undefined);
    const { db, executor } = managerOver(file(), w.def);
    const a = await plan(executor, "a", ["deploy@main"]);
    await executor.approve(a);
    await executor.settle(a);
    releaseLocks(db.db, a); // a failed run of a Manager that still let its locks go
    const c = await plan(executor, "c", ["deploy@main"]);
    await executor.approve(c);
    await until(() => w.started.includes("c"));
    await expect(executor.retryFromStep(a)).rejects.toMatchObject({ code: "RESOURCE_BUSY", detail: { holderRunId: c } });
    expect(status(db, a)).toBe("failed");
    w.open("c");
    await executor.settle(c);
    w.failing.delete("a");
    w.blocking.set("a", () => undefined);
    await executor.retryFromStep(a);
    await until(() => w.started.filter((n) => n === "a").length === 2);
    expect(listLocks(db.db).map((l) => l.runId)).toEqual([a]);
    w.open("a");
    await executor.settle(a);
    expect(status(db, a)).toBe("succeeded");
  });

  it("decision 2 a: after a restart a queued run waits for its secret again, is passed over, and keeps its place", async () => {
    const w = world();
    w.failing.add("a");
    const path = file();
    const before = managerOver(path, w.def);
    const a = await plan(before.executor, "a", ["one"]);
    const b = await plan(before.executor, "b", ["one"], true);
    const c = await plan(before.executor, "c", ["one"]);
    await before.executor.approve(a);
    await before.executor.settle(a);
    await before.executor.approve(b, secrets());
    await before.executor.approve(c);
    expect(before.executor.listQueue().map((q) => [q.runId, q.place, q.needsSecrets])).toEqual([[b, 1, false], [c, 2, false]]);

    const after = managerOver(path, w.def);
    await after.executor.resumeOnBoot();
    expect(after.executor.listQueue().map((q) => [q.runId, q.place, q.needsSecrets])).toEqual([[b, 1, true], [c, 2, false]]);
    expect(readEvents(after.db.db, b).map((e) => e.text).join("\n")).toContain("type them again on the run page");
    // b reserves nothing while it waits for its secret, so c is next on the lock.
    expect(after.executor.listQueue()[1]?.waitsFor).toEqual([{ resource: "git-branch", key: "one", holderRunId: a }]);
    w.blocking.set("c", () => undefined);
    await after.executor.deleteRun(a);
    await until(() => w.started.includes("c"));
    expect(status(after.db, b)).toBe("queued");
    expect(await after.executor.approve(b, secrets())).toEqual({ status: "queued" });
    expect(after.executor.listQueue()).toEqual([expect.objectContaining({ runId: b, place: 1, needsSecrets: false, waitsFor: [{ resource: "git-branch", key: "one", holderRunId: c }] })]);
    w.open("c");
    await after.executor.settle(b);
    expect(status(after.db, b)).toBe("succeeded");

    // No typed value in the database, the run log or the queue's answer.
    const dump = after.db.sqlite.prepare("SELECT group_concat(x, '|') AS all_ FROM (SELECT params_json || plan_json AS x FROM runs UNION ALL SELECT text FROM events UNION ALL SELECT coalesce(detail_json, '') FROM audit)").get() as { all_: string };
    expect(dump.all_).not.toContain(TYPED);
    expect(JSON.stringify(after.executor.listQueue())).not.toContain(TYPED);
  });

  it("refuses an approve of a queued run that has everything it needs", async () => {
    const w = world();
    w.blocking.set("a", () => undefined);
    const { executor } = managerOver(file(), w.def);
    const a = await plan(executor, "a", ["one"]);
    const b = await plan(executor, "b", ["one"]);
    await executor.approve(a);
    await until(() => w.started.includes("a"));
    await executor.approve(b);
    await expect(executor.approve(b)).rejects.toMatchObject({ code: "ILLEGAL_TRANSITION" });
    w.open("a");
  });

  it("refuses instead of queueing where the caller asks for a free start only", async () => {
    const w = world();
    w.blocking.set("a", () => undefined);
    const { db, executor } = managerOver(file(), w.def);
    const a = await plan(executor, "a", ["one"]);
    const b = await plan(executor, "b", ["one"]);
    await executor.approve(a);
    await until(() => w.started.includes("a"));
    await expect(executor.approve(b, undefined, { onlyIfFree: true })).rejects.toMatchObject({ code: "RESOURCE_BUSY", detail: { holderRunId: a } });
    expect(status(db, b)).toBe("planned");
    w.open("a");
  });

  /** A Manager whose process log is kept: the lines it writes at warn level or above, parsed. */
  function managerLogging(def: AnyRunDefinition): { db: DbHandle; executor: Executor; waitLines: () => Record<string, unknown>[] } {
    const lines: string[] = [];
    const { db, executor } = managerOver(file(), def, pino({ level: "warn" }, { write: (s: string) => { lines.push(s); } }));
    const waitLines = () => lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l["msg"] === "a run waits behind a failed run's lock");
    return { db, executor, waitLines };
  }

  it("writes one warn line when a run queues behind a failed holder, and names the holder in the run's log", async () => {
    const w = world();
    w.failing.add("a");
    const { db, executor, waitLines } = managerLogging(w.def);
    const a = await plan(executor, "a", ["deploy@main"]);
    const b = await plan(executor, "b", ["deploy@main"]);
    await executor.approve(a);
    await executor.settle(a);
    expect(waitLines()).toEqual([]);
    expect(await executor.approve(b)).toEqual({ status: "queued" });
    expect(waitLines()).toEqual([expect.objectContaining({
      level: 40, waitingRunId: b, waitingKind: "noop", holderRunId: a, holderKind: "noop", holderStatus: "failed",
      holderFailedStep: "Change", holderError: "half done", resource: "git-branch", key: "deploy@main",
    })]);
    expect(readEvents(db.db, b).map((e) => e.text)).toContain(`⏳ queued at place 1: it waits for git-branch deploy@main (run ${a}, failed at step Change)`);
  });

  it("writes no line for a run that queues behind a holder that is still running", async () => {
    const w = world();
    w.blocking.set("a", () => undefined);
    const { executor, waitLines } = managerLogging(w.def);
    const a = await plan(executor, "a", ["deploy@main"]);
    const b = await plan(executor, "b", ["deploy@main"]);
    await executor.approve(a);
    await until(() => w.started.includes("a"));
    expect(await executor.approve(b)).toEqual({ status: "queued" });
    expect(waitLines()).toEqual([]);
    w.open("a");
    await executor.settle(b);
    expect(waitLines()).toEqual([]);
  });

  it("writes the line when the holder fails while a run already waits behind it", async () => {
    const w = world();
    w.blocking.set("a", () => undefined);
    w.failing.add("a");
    const { executor, waitLines } = managerLogging(w.def);
    const a = await plan(executor, "a", ["deploy@main"]);
    const b = await plan(executor, "b", ["deploy@main"]);
    await executor.approve(a);
    await until(() => w.started.includes("a"));
    await executor.approve(b);
    expect(waitLines()).toEqual([]);
    w.open("a");
    await executor.settle(a);
    expect(waitLines()).toEqual([expect.objectContaining({ waitingRunId: b, holderRunId: a, holderStatus: "failed" })]);
  });

  it("names a holder that was cancelled in the middle, and writes the line once per waiting run and holder", async () => {
    const w = world();
    w.blocking.set("a", () => undefined);
    const { executor, waitLines } = managerLogging(w.def);
    const a = await plan(executor, "a", ["deploy@main"]);
    const b = await plan(executor, "b", ["deploy@main"]);
    const c = await plan(executor, "c", ["deploy@main"]);
    const other = await plan(executor, "other", ["elsewhere"]);
    await executor.approve(a);
    await until(() => w.started.includes("a"));
    const cancelled = executor.cancel(a);
    w.failing.add("a");
    w.open("a");
    await cancelled;
    await executor.approve(b);
    expect(waitLines().map((l) => [l["waitingRunId"], l["holderRunId"], l["holderStatus"]])).toEqual([[b, a, "cancelled"]]);
    // Every run that ends and every approve dispatches again; the pair that was written stays written.
    await executor.approve(other);
    await executor.settle(other);
    await executor.approve(c);
    expect(waitLines().map((l) => [l["waitingRunId"], l["holderRunId"]])).toEqual([[b, a], [c, a]]);
  });

  it("finds a run only once it failed or was cancelled, with the step that failed", async () => {
    const { db } = managerOver(file(), world().def);
    seedRunRows(db, { runId: "run_going", steps: [{ id: "step_going", name: "Change" }] });
    expect(findFailedHolder(db.db, "run_going")).toBeUndefined();
    expect(findFailedHolder(db.db, "run_unknown")).toBeUndefined();
    db.sqlite.prepare("UPDATE runs SET status = 'cancelled' WHERE id = 'run_going'").run();
    expect(findFailedHolder(db.db, "run_going")).toEqual({ runId: "run_going", kind: "noop", status: "cancelled", failedStep: null, error: null });
    db.sqlite.prepare("UPDATE runs SET status = 'failed', error = 'half done' WHERE id = 'run_going'").run();
    db.sqlite.prepare("UPDATE steps SET status = 'failed' WHERE id = 'step_going'").run();
    expect(findFailedHolder(db.db, "run_going")).toEqual({ runId: "run_going", kind: "noop", status: "failed", failedStep: "Change", error: "half done" });
  });
});
