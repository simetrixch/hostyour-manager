import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pino } from "pino";
import { z } from "zod";
import { openDb, type DbHandle } from "../db/client.ts";
import { CredentialStore } from "../security/store.ts";
import { RunEventBus } from "./bus.ts";
import { Executor } from "./executor.ts";
import { getRun, readEvents } from "./read.ts";
import { listLocks } from "./locks.ts";
import { startQueuedRuns } from "./queue.ts";
import type { SshFactory } from "../adapters/ssh/port.ts";
import type { AnyRunDefinition } from "./types.ts";
import type { RunKind } from "../../shared/enums.ts";

const logger = pino({ level: "silent" });
const noSsh: SshFactory = () => Promise.reject(new Error("no ssh"));
const SECRET = "consumer-secret:ROOT_PASSWORD";
const TYPED = "a-typed-value-never-stored";

const params = z.object({ name: z.string(), locks: z.array(z.string()), secret: z.boolean().optional() });
type Params = z.infer<typeof params>;

/** A world of runs whose one step each test steers by name: `failing` names fail, `blocking` names
 *  wait until the test opens their gate. Every run claims the git branches it names. */
function world() {
  const failing = new Set<string>();
  const blocking = new Map<string, () => void>();
  const started: string[] = [];
  const def: AnyRunDefinition = {
    kind: "noop",
    paramsSchema: params,
    mutating: false,
    plan: async (p: Params) => ({
      kind: "noop", targetKind: "self", targetId: "manager", summary: p.name,
      steps: [{ name: "change", title: "Change" }], warnings: [], requiredSecrets: p.secret ? [SECRET] : [],
      locks: p.locks.map((key) => ({ resource: "git-branch" as const, key })),
    }),
    steps: (p: Params) => [{
      name: "change",
      title: "Change",
      run: async () => {
        started.push(p.name);
        if (blocking.has(p.name)) await new Promise<void>((r) => { blocking.set(p.name, r); });
        if (failing.has(p.name)) throw new Error("half done");
      },
    }],
  } as AnyRunDefinition;
  return { def, failing, blocking, started, open: (name: string) => blocking.get(name)?.() };
}

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
  function managerOver(path: string, def: AnyRunDefinition): { db: DbHandle; executor: Executor } {
    const db = openDb(path);
    handles.push(db);
    const executor = new Executor({
      db: db.db, creds: new CredentialStore({ db: db.db, logger }), bus: new RunEventBus(), logger,
      runDefinitions: new Map<RunKind, AnyRunDefinition>([["noop", def]]), sshFactory: noSsh, actor: () => "op_system",
    });
    return { db, executor };
  }
  const until = async (ok: () => boolean) => { for (let i = 0; i < 400 && !ok(); i++) await new Promise((r) => setTimeout(r, 5)); };
  const status = (db: DbHandle, runId: string) => getRun(db.db, runId)?.status;
  const plan = async (ex: Executor, name: string, locks: string[], secret = false) => (await ex.plan("noop", { name, locks, secret })).runId;
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
    db.sqlite.prepare("DELETE FROM run_locks WHERE run_id = ?").run(a); // the holder's lock goes, nobody dispatches yet
    const second = openDb(path);
    handles.push(second);
    const first = startQueuedRuns(db.db, () => true);
    const again = startQueuedRuns(second.db, () => true);
    expect([first, again]).toEqual([[b], []]);
    expect(listLocks(db.db).map((l) => l.runId)).toEqual([b]);
    w.open("a");
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
    db.sqlite.prepare("DELETE FROM run_locks WHERE run_id = ?").run(a); // a failed run of a Manager that still let its locks go
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
});
