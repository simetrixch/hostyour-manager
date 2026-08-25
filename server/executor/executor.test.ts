import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pino } from "pino";
import { z } from "zod";
import { openDb, type DbHandle } from "../db/client.ts";
import { createLogger } from "../kernel/logger.ts";
import { parseConfig } from "../kernel/config.ts";
import { CredentialStore } from "../security/store.ts";
import { registerSecret } from "../security/redact.ts";
import { RunEventBus } from "./bus.ts";
import { Executor } from "./executor.ts";
import { buildRunDefinitions } from "../domains/runs/run-definitions.ts";
import { getRun, readEvents } from "./read.ts";
import type { SshFactory } from "../adapters/ssh/port.ts";
import type { AnyRunDefinition } from "./types.ts";
import type { RunKind } from "../../shared/enums.ts";

const logger = createLogger(
  parseConfig({
    PUBLIC_URL: "https://x.example",
    OIDC_ISSUER: "https://i.example/",
    OIDC_CLIENT_ID: "c",
    OIDC_CLIENT_SECRET: "s",
    MANAGER_VERSION: "test",
    DATA_DIR: "/data",
    LOG_LEVEL: "silent",
  } as NodeJS.ProcessEnv),
);
const noSsh: SshFactory = () => Promise.reject(new Error("ssh must not be used by noop"));

describe("Executor — noop happy path + resume", () => {
  const handles: DbHandle[] = [];
  const dirs: string[] = [];
  function make(): { db: DbHandle; executor: Executor; bus: RunEventBus } {
    const dir = mkdtempSync(join(tmpdir(), "mgr-ex-"));
    dirs.push(dir);
    const db = openDb(join(dir, "manager.db"));
    handles.push(db);
    const store = new CredentialStore({ db: db.db, logger });
    const bus = new RunEventBus();
    const runDefinitions = buildRunDefinitions({ db: db.db });
    const executor = new Executor({ db: db.db, creds: store, bus, logger, runDefinitions, sshFactory: noSsh, actor: () => "op_system" });
    return { db, executor, bus };
  }
  afterEach(() => {
    for (const h of handles.splice(0)) h.sqlite.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("plan → approve → execute drives noop to succeeded with all steps ok", async () => {
    const { db, executor } = make();
    const { runId } = await executor.plan("noop", {});
    let run = getRun(db.db, runId);
    expect(run?.status).toBe("planned");
    expect(run?.steps.map((s) => s.name)).toEqual(["log-lines", "checkpoint", "sleep"]);

    await executor.approve(runId);
    await executor.settle(runId);

    run = getRun(db.db, runId);
    expect(run?.status).toBe("succeeded");
    expect(run?.steps.every((s) => s.status === "ok")).toBe(true);
    const events = readEvents(db.db, runId);
    expect(events.filter((e) => e.stream === "stdout").map((e) => e.text)).toEqual([
      "demo line 1", "demo line 2", "demo line 3", "demo line 4", "demo line 5",
    ]);
    expect(events.some((e) => e.stream === "meta" && e.text.includes("Run succeeded"))).toBe(true);
  });

  it("publishes live events on the bus during execution", async () => {
    const { executor, bus } = make();
    const { runId } = await executor.plan("noop", {});
    const seen: string[] = [];
    const unsub = bus.subscribe(runId, (e) => {
      if (e.stream === "stdout") seen.push(e.text);
    });
    await executor.approve(runId);
    await executor.settle(runId);
    unsub();
    expect(seen).toContain("demo line 3");
  });

  it("resumeOnBoot continues a run left mid-flight (running step normalized to pending)", async () => {
    const { db, executor } = make();
    const { runId } = await executor.plan("noop", {});
    await executor.approve(runId);
    await executor.settle(runId);

    // Simulate a crash mid-run: run back to running, its last step back to running.
    db.sqlite.prepare("UPDATE runs SET status='running', finished_at=NULL WHERE id=?").run(runId);
    db.sqlite.prepare("UPDATE steps SET status='running', finished_at=NULL WHERE run_id=? AND name='sleep'").run(runId);

    // A NEW executor (fresh process, empty RunSecrets) resumes.
    const store2 = new CredentialStore({ db: db.db, logger });
    const executor2 = new Executor({ db: db.db, creds: store2, bus: new RunEventBus(), logger, runDefinitions: buildRunDefinitions({ db: db.db }), sshFactory: noSsh, actor: () => "op_system" });
    await executor2.resumeOnBoot();

    const run = getRun(db.db, runId);
    expect(run?.status).toBe("succeeded");
    expect(run?.steps.find((st) => st.name === "sleep")?.status).toBe("ok");
    expect(events(db).some((t) => t.includes("Run resumed"))).toBe(true);
  });

  it("holds no locks for a self-targeted noop (targetKind=self)", async () => {
    const { db, executor } = make();
    const { runId } = await executor.plan("noop", {});
    await executor.approve(runId);
    await executor.settle(runId);
    const n = db.sqlite.prepare("SELECT count(*) AS n FROM run_locks").get() as { n: number };
    expect(n.n).toBe(0);
  });

  it("a step that throws surfaces its error MESSAGE into the visible run log — redacted", async () => {
    // The create-mgmt incident law: the reason a step failed must land in the streamed run
    // log (events), not only in steps.error — and it must pass the same redaction chokepoint
    // as every other log line, so an error that echoes a secret can never leak it.
    const SECRET = "tok-abcdef-super-secret-value";
    const failingDef: AnyRunDefinition = {
      kind: "noop",
      paramsSchema: z.record(z.string(), z.unknown()),
      mutating: false,
      plan: async () => ({
        kind: "noop", targetKind: "self", targetId: "manager", summary: "fails on purpose",
        steps: [{ name: "boom", title: "Blow up" }], warnings: [], requiredSecrets: [],
      }),
      steps: () => [{
        name: "boom",
        title: "Blow up",
        run: async (ctx) => {
          registerSecret(ctx.runId, Buffer.from(SECRET, "utf8"));
          throw new Error(`vault put failed for ${SECRET} (503)`);
        },
      }],
    };
    const dir = mkdtempSync(join(tmpdir(), "mgr-ex-"));
    dirs.push(dir);
    const db = openDb(join(dir, "manager.db"));
    handles.push(db);
    const store = new CredentialStore({ db: db.db, logger });
    const runDefinitions = new Map<RunKind, AnyRunDefinition>([["noop", failingDef]]);
    const executor = new Executor({ db: db.db, creds: store, bus: new RunEventBus(), logger, runDefinitions, sshFactory: noSsh, actor: () => "op_system" });

    const { runId } = await executor.plan("noop", {});
    await executor.approve(runId);
    await executor.settle(runId);

    expect(getRun(db.db, runId)?.status).toBe("failed");
    const evts = readEvents(db.db, runId);
    // the failure reason is a visible log line, right before the ✗ meta — with the secret masked
    const reason = evts.find((e) => e.stream === "stderr" && e.text.includes("vault put failed"));
    expect(reason?.text).toBe("✗ vault put failed for ••• (503)");
    expect(evts.some((e) => e.stream === "meta" && e.text === "✗ failed: Blow up")).toBe(true);
    expect(JSON.stringify(evts)).not.toContain(SECRET);
    // steps.error stays the (redacted) record it always was
    const err = db.sqlite.prepare("SELECT error FROM steps WHERE run_id=? AND name='boom'").get(runId) as { error: string };
    expect(err.error).toBe("vault put failed for ••• (503)");
  });
});

function events(db: DbHandle): string[] {
  return (db.sqlite.prepare("SELECT text FROM events WHERE stream='meta'").all() as { text: string }[]).map((r) => r.text);
}

describe("Executor — a run whose failure the database cannot take", () => {
  // What a run does when the thing supervising it has gone away. In a test that is a closed database
  // handle; in the manager it is a shutdown that closed it, a full disk, or a file the OS took back.
  // Either way execute() lands in its catch-all, failRun cannot write, and the executor's job is to say
  // so where it still can and stop. It must NOT reject: nothing holds execute()'s promise — approve()
  // fires the run and the route answers 202 — so a rejection reaches the process, and Node's answer to
  // an unhandled rejection is to terminate the manager and every other run in flight with it.
  const handles: DbHandle[] = [];
  const dirs: string[] = [];
  afterEach(() => {
    for (const h of handles.splice(0)) { if (h.sqlite.open) h.sqlite.close(); }
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /** A def whose one step blocks until the test releases it — the window in which the database goes. */
  function blockingDef(gate: { started: Promise<void>; release: () => void; open: () => void }): AnyRunDefinition {
    return {
      kind: "noop",
      paramsSchema: z.record(z.string(), z.unknown()),
      mutating: false,
      plan: async () => ({
        kind: "noop", targetKind: "self", targetId: "manager", summary: "blocks, then fails",
        steps: [{ name: "block", title: "Block" }], warnings: [], requiredSecrets: [],
      }),
      steps: () => [{
        name: "block",
        title: "Block",
        run: async () => {
          gate.open();
          await gate.started.then(() => undefined);
          throw new Error("the step failed while nobody was watching");
        },
      }],
    };
  }

  function makeWith(def: AnyRunDefinition): { db: DbHandle; executor: Executor; lines: string[] } {
    const dir = mkdtempSync(join(tmpdir(), "mgr-nodb-"));
    dirs.push(dir);
    const db = openDb(join(dir, "manager.db"));
    handles.push(db);
    const lines: string[] = [];
    const capturing = pino({ level: "error" }, { write: (s: string) => { lines.push(s); } });
    const executor = new Executor({
      db: db.db, creds: new CredentialStore({ db: db.db, logger }), bus: new RunEventBus(),
      logger: capturing, runDefinitions: new Map<RunKind, AnyRunDefinition>([["noop", def]]),
      sshFactory: noSsh, actor: () => "op_system",
    });
    return { db, executor, lines };
  }

  function gates(): { started: Promise<void>; release: () => void; open: () => void; entered: Promise<void> } {
    let release!: () => void;
    let open!: () => void;
    const started = new Promise<void>((r) => { release = r; });
    const entered = new Promise<void>((r) => { open = r; });
    return { started, release, open, entered };
  }

  it("says in the log what it could not write down, and settles instead of rejecting", async () => {
    const g = gates();
    const { db, executor, lines } = makeWith(blockingDef(g));
    const { runId } = await executor.plan("noop", {});
    await executor.approve(runId);
    await g.entered;

    db.sqlite.close(); // the supervisor is gone, mid-step
    g.release();

    await expect(executor.settle(runId)).resolves.toBeUndefined();
    expect(lines.join("\n")).toContain("could not record the run's failure");
    expect(lines.join("\n")).toContain(runId);
  });

  it("counter-probe: with the database open the SAME failure is recorded there and nothing is logged", async () => {
    // Without this the test above would pass just as well against a failRun that wrote nothing at all.
    const g = gates();
    const { db, executor, lines } = makeWith(blockingDef(g));
    const { runId } = await executor.plan("noop", {});
    await executor.approve(runId);
    await g.entered;
    g.release();

    await executor.settle(runId);
    expect(getRun(db.db, runId)?.status).toBe("failed");
    expect(getRun(db.db, runId)?.steps.find((s) => s.name === "block")?.status).toBe("failed");
    expect(events(db).some((t) => t.includes("✗ failed: Block"))).toBe(true);
    expect(lines).toHaveLength(0);
  });
});

const abortErr = (): Error => Object.assign(new Error("aborted"), { name: "AbortError" });

describe("Executor — cancel between steps + concurrent resume", () => {
  const handles: DbHandle[] = [];
  const dirs: string[] = [];
  function makeWith(def: AnyRunDefinition): { db: DbHandle; executor: Executor } {
    const dir = mkdtempSync(join(tmpdir(), "mgr-cx-"));
    dirs.push(dir);
    const db = openDb(join(dir, "manager.db"));
    handles.push(db);
    const store = new CredentialStore({ db: db.db, logger });
    const runDefinitions = new Map<RunKind, AnyRunDefinition>([["noop", def]]);
    const executor = new Executor({ db: db.db, creds: store, bus: new RunEventBus(), logger, runDefinitions, sshFactory: noSsh, actor: () => "op_system" });
    return { db, executor };
  }
  afterEach(() => {
    for (const h of handles.splice(0)) h.sqlite.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("a cancel taken MID-STEP stops the run before the next step — the run settles cancelled, later steps never run", async () => {
    // Step 1 blocks on a deferred and IGNORES ctx.signal, the way most mutating steps do. The
    // cancel lands while it is in flight; the step then finishes normally. The run must stop in
    // the gap before step 2 — without the between-steps signal check it walked on, executed
    // every remaining step and settled "succeeded" after the cancel was acknowledged.
    const executed: string[] = [];
    let releaseSlow!: () => void;
    let startedResolve!: () => void;
    const started = new Promise<void>((r) => { startedResolve = r; });
    const def: AnyRunDefinition = {
      kind: "noop",
      paramsSchema: z.record(z.string(), z.unknown()),
      mutating: false,
      plan: async () => ({
        kind: "noop", targetKind: "self", targetId: "manager", summary: "cancel mid-step",
        steps: [{ name: "slow", title: "Slow" }, { name: "mutate-2", title: "Mutate 2" }, { name: "mutate-3", title: "Mutate 3" }],
        warnings: [], requiredSecrets: [],
      }),
      steps: () => [
        { name: "slow", title: "Slow", run: async () => { executed.push("slow"); startedResolve(); await new Promise<void>((r) => { releaseSlow = r; }); } },
        { name: "mutate-2", title: "Mutate 2", run: async () => { executed.push("mutate-2"); } },
        { name: "mutate-3", title: "Mutate 3", run: async () => { executed.push("mutate-3"); } },
      ],
    };
    const { db, executor } = makeWith(def);
    const { runId } = await executor.plan("noop", {});
    await executor.approve(runId);
    await started;
    const cancelP = executor.cancel(runId); // aborts, then awaits settle — the step is still blocked
    releaseSlow();
    await cancelP;

    const run = getRun(db.db, runId);
    expect(executed).toEqual(["slow"]);
    expect(run?.status).toBe("cancelled");
    expect(run?.steps.find((s) => s.name === "slow")?.status).toBe("ok"); // its work happened
    expect(run?.steps.find((s) => s.name === "mutate-2")?.status).toBe("pending");
    expect(run?.steps.find((s) => s.name === "mutate-3")?.status).toBe("pending");
    expect(events(db).some((t) => t.includes("✕ cancelled before: Mutate 2"))).toBe(true);
    expect(events(db).some((t) => t.includes("Run succeeded"))).toBe(false);
  });

  it("resumeOnBoot starts every resumed run at once, and a cancel on any of them is honest", async () => {
    // Two runs are left approved by a crash. The serial resume held run B until run A finished,
    // so B was in neither `active` nor `inflight`: cancel(B) aborted nothing, settle(B) awaited
    // undefined, and when the loop reached B it executed every step to completion.
    const gates = new Map<string, () => void>(); // runId -> release the blocked step
    const def: AnyRunDefinition = {
      kind: "noop",
      paramsSchema: z.record(z.string(), z.unknown()),
      mutating: false,
      plan: async () => ({
        kind: "noop", targetKind: "self", targetId: "manager", summary: "concurrent resume",
        steps: [{ name: "block", title: "Block" }], warnings: [], requiredSecrets: [],
      }),
      steps: () => [{
        name: "block",
        title: "Block",
        run: async (ctx) => new Promise<void>((resolve, reject) => {
          if (ctx.signal.aborted) { reject(abortErr()); return; }
          ctx.signal.addEventListener("abort", () => reject(abortErr()), { once: true });
          gates.set(ctx.runId, resolve);
        }),
      }],
    };
    const { db, executor } = makeWith(def);
    const { runId: runA } = await executor.plan("noop", {});
    const { runId: runB } = await executor.plan("noop", {});
    // The crash picture resumeOnBoot finds: both approved, steps pending (as planned leaves them).
    db.sqlite.prepare("UPDATE runs SET status='approved'").run();

    const { executor: executor2 } = { executor: new Executor({ db: db.db, creds: new CredentialStore({ db: db.db, logger }), bus: new RunEventBus(), logger, runDefinitions: new Map<RunKind, AnyRunDefinition>([["noop", def]]), sshFactory: noSsh, actor: () => "op_system" }) };
    const resumeP = executor2.resumeOnBoot();
    // Both runs entered their step before resumeOnBoot's first await — the serial loop entered
    // only run A here and held run B back until A finished.
    expect([...gates.keys()].sort()).toEqual([runA, runB].sort());

    await executor2.cancel(runB);
    expect(getRun(db.db, runB)?.status).toBe("cancelled");

    gates.get(runA)!();
    await resumeP;
    expect(getRun(db.db, runA)?.status).toBe("succeeded");
    expect(getRun(db.db, runB)?.status).toBe("cancelled"); // the resume loop must not revive it
  });
});

describe("Executor — a resume the database cannot take", () => {
  // resumeOnBoot runs before the manager serves anything, and boot.ts cannot hold its promise:
  // it resolves only once every resumed run has SETTLED, so awaiting it would keep the listener
  // down for the length of the longest onboarding. A throw out of its three bare database
  // statements therefore reaches the process as an unhandled rejection, Node ends the process, the
  // supervisor restarts it and the same statement fails again — a crash loop out of a condition
  // (SQLITE_BUSY, a slow disk at start-up) that would have cleared by itself.
  //
  // What resume must do instead is carry on: the runs it could not read or normalize are still in
  // the database, and the next boot reads them again. `DROP TABLE runs` and the trigger below are
  // how the tests make one statement fail while the rest of the database answers — the per-statement
  // window SQLITE_FULL and SQLITE_BUSY open — taking the recovery's two ends in turn: the reads that
  // find the interrupted runs, and the write that prepares one for a resume.
  const handles: DbHandle[] = [];
  const dirs: string[] = [];
  afterEach(() => {
    for (const h of handles.splice(0)) { if (h.sqlite.open) h.sqlite.close(); }
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /** One ordinary step that records the run it ran for — so a resumed execution is visible, and so
   *  is its absence. */
  function resumableDef(ran: string[]): AnyRunDefinition {
    return {
      kind: "noop",
      paramsSchema: z.record(z.string(), z.unknown()),
      mutating: false,
      plan: async () => ({
        kind: "noop", targetKind: "self", targetId: "manager", summary: "one step, interrupted by a crash",
        steps: [{ name: "work", title: "Work" }], warnings: [], requiredSecrets: [],
      }),
      steps: () => [{ name: "work", title: "Work", run: async (ctx) => void ran.push(ctx.runId) }],
    };
  }

  /** The run that planned the work and the run that boots after the crash are different processes,
   *  and only the second one's log is measured. */
  function makeResume(def: AnyRunDefinition): { db: DbHandle; before: Executor; booting: Executor; lines: string[] } {
    const dir = mkdtempSync(join(tmpdir(), "mgr-resume-"));
    dirs.push(dir);
    const db = openDb(join(dir, "manager.db"));
    handles.push(db);
    const lines: string[] = [];
    const capturing = pino({ level: "error" }, { write: (s: string) => { lines.push(s); } });
    const runDefinitions = new Map<RunKind, AnyRunDefinition>([["noop", def]]);
    const common = { db: db.db, creds: new CredentialStore({ db: db.db, logger }), bus: new RunEventBus(), runDefinitions, sshFactory: noSsh, actor: () => "op_system" };
    return { db, before: new Executor({ ...common, logger }), booting: new Executor({ ...common, logger: capturing }), lines };
  }

  /** The picture a crash leaves: the run mid-flight, its step still reading `running` because
   *  nothing was left alive to write the outcome. */
  function crashMidRun(db: DbHandle, runId: string): void {
    db.sqlite.prepare("UPDATE runs SET status='running', started_at=?, finished_at=NULL WHERE id=?").run(Date.now(), runId);
    db.sqlite.prepare("UPDATE steps SET status='running', started_at=? WHERE run_id=?").run(Date.now(), runId);
  }

  const stepStatus = (db: DbHandle, runId: string): string =>
    (db.sqlite.prepare("SELECT status FROM steps WHERE run_id=?").get(runId) as { status: string }).status;

  it("a boot that cannot READ what was interrupted says so and carries on", async () => {
    const ran: string[] = [];
    const { db, before, booting, lines } = makeResume(resumableDef(ran));
    const { runId } = await before.plan("noop", {});
    crashMidRun(db, runId);
    // `steps` references `runs`, so the drop would cascade the step rows away with foreign keys on —
    // and those rows are what the assertion below reads to show the crash picture was left untouched.
    db.sqlite.pragma("foreign_keys = OFF");
    db.sqlite.exec("DROP TABLE runs");

    await expect(booting.resumeOnBoot()).resolves.toBeUndefined();

    expect(lines.join("\n")).toContain("boot-time recovery could not read or normalize");
    expect(lines.join("\n")).toContain("no such table: runs");
    expect(ran).toEqual([]);
    expect(stepStatus(db, runId)).toBe("running"); // untouched — nothing was guessed at
  });

  it("a run whose interrupted steps cannot be normalized is LEFT for the next boot, not fired", async () => {
    const ran: string[] = [];
    const { db, before, booting, lines } = makeResume(resumableDef(ran));
    const { runId } = await before.plan("noop", {});
    crashMidRun(db, runId);
    // Only the reset to `pending` is refused; every other write to `steps` still lands, so a run
    // fired despite the refusal really would execute. Measured: it walks execute() into a step still
    // reading `running`, whose legal successors are ok/failed/pending/skipped and never `running`
    // again, and the run ends `failed` carrying `step status running → running` — which is why the
    // run must be left alone instead, for a boot that can normalize it.
    db.sqlite.exec("CREATE TRIGGER steps_no_reset BEFORE UPDATE ON steps WHEN NEW.status='pending' BEGIN SELECT RAISE(ABORT, 'the disk is full'); END");

    await expect(booting.resumeOnBoot()).resolves.toBeUndefined();

    expect(ran).toEqual([]);
    expect(getRun(db.db, runId)?.status).toBe("running");
    expect(stepStatus(db, runId)).toBe("running");
    expect(lines.join("\n")).toContain("boot-time recovery could not read or normalize");
    expect(lines.join("\n")).toContain("the disk is full");
  });

  it("counter-probe: with a healthy database the same crash picture really is resumed", async () => {
    // Without this the two tests above would pass just as well against a resume that fires nothing.
    const ran: string[] = [];
    const { db, before, booting, lines } = makeResume(resumableDef(ran));
    const { runId } = await before.plan("noop", {});
    crashMidRun(db, runId);

    await booting.resumeOnBoot();

    expect(ran).toEqual([runId]);
    expect(getRun(db.db, runId)?.status).toBe("succeeded");
    expect(stepStatus(db, runId)).toBe("ok");
    expect(events(db).some((t) => t.includes("Run resumed"))).toBe(true);
    expect(lines).toHaveLength(0);
  });

  it("counter-probe: with a healthy database a run left validating really is settled", async () => {
    const { db, before, booting, lines } = makeResume(resumableDef([]));
    const { runId } = await before.plan("noop", {});
    db.sqlite.prepare("UPDATE runs SET status='planning' WHERE id=?").run(runId);

    await booting.resumeOnBoot();

    expect(getRun(db.db, runId)?.status).toBe("failed");
    const row = db.sqlite.prepare("SELECT error FROM runs WHERE id=?").get(runId) as { error: string };
    expect(row.error).toContain("validation was interrupted by a manager restart");
    expect(lines).toHaveLength(0);
  });
});
