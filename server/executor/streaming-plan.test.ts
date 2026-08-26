import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pino } from "pino";
import { z } from "zod";
import { openDb, type DbHandle } from "../db/client.ts";
import { AppError, errGateIncomplete } from "../kernel/errors.ts";
import { CredentialStore } from "../security/store.ts";
import { RunEventBus } from "./bus.ts";
import { Executor } from "./executor.ts";
import { getRun } from "./read.ts";
import type { SshFactory } from "../adapters/ssh/port.ts";
import type { AnyRunDefinition, PlanStreamResult } from "./types.ts";
import type { RunKind } from "../../shared/enums.ts";

const logger = pino({ level: "silent" });
const noSsh: SshFactory = () => Promise.reject(new Error("ssh must not be used during planning"));

const REJECTION_SUMMARY = "the repository carries no chart";
const REJECTION_REPORT = { checks: [{ name: "chart", expected: "charts/app", found: "nothing" }] };

const planned = (): PlanStreamResult<Record<string, unknown>> => ({
  outcome: "planned",
  params: {},
  plan: {
    kind: "noop",
    targetKind: "self",
    targetId: "manager",
    summary: "validated, ready for approval",
    steps: [{ name: "do-it", title: "Do it" }],
    warnings: [],
    requiredSecrets: [],
  },
});

const rejected = (): PlanStreamResult<Record<string, unknown>> => ({
  outcome: "rejected",
  summary: REJECTION_SUMMARY,
  planJson: REJECTION_REPORT,
});

interface Gate {
  entered: Promise<void>;
  open: () => void;
  released: Promise<void>;
  release: () => void;
}

function gates(): Gate {
  let open!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((r) => { open = r; });
  const released = new Promise<void>((r) => { release = r; });
  return { entered, open, released, release };
}

/** A def whose STREAMING planner blocks until the test releases it — the window in which the
 *  database goes — and then ends the validation the way the test asked for. */
function blockingPlannerDef(gate: Gate, outcome: () => PlanStreamResult<Record<string, unknown>>): AnyRunDefinition {
  return {
    kind: "noop",
    paramsSchema: z.record(z.string(), z.unknown()),
    mutating: false,
    plan: async () => {
      throw new AppError("INTERNAL", "this def is planned via planStream, not plan()");
    },
    planStream: async () => {
      gate.open();
      await gate.released;
      return outcome();
    },
    steps: () => [{ name: "do-it", title: "Do it", run: async () => undefined }],
  };
}

const handles: DbHandle[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) { if (h.sqlite.open) h.sqlite.close(); }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeWith(def: AnyRunDefinition): { db: DbHandle; executor: Executor; lines: string[] } {
  const dir = mkdtempSync(join(tmpdir(), "mgr-sp-nodb-"));
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

const runRow = (db: DbHandle, runId: string): { status: string; error: string | null; plan_json: string | null } =>
  db.sqlite.prepare("SELECT status, error, plan_json FROM runs WHERE id=?").get(runId) as { status: string; error: string | null; plan_json: string | null };

const metaLines = (db: DbHandle, runId: string): string[] =>
  (db.sqlite.prepare("SELECT text FROM events WHERE run_id=? AND stream='meta'").all(runId) as { text: string }[]).map((r) => r.text);

describe("streaming plan — a plan whose outcome the database cannot take", () => {
  // What a validation does when the database it must settle into has gone away. In a test that is a
  // closed handle; in the manager it is a shutdown that closed it, a full disk, or SQLITE_BUSY.
  // Nothing holds this promise — POST /api/runs/:id/plan answers as soon as the run row exists and
  // SSE takes over — so a throw while settling reaches the process as an unhandled rejection, and
  // Node's answer to that is to terminate the manager with every other run in flight.

  it("a validation that PASSED and cannot be written down says so in the log and settles instead of rejecting", async () => {
    const g = gates();
    const { db, executor, lines } = makeWith(blockingPlannerDef(g, planned));
    const { runId } = await executor.planStreamed("noop", {});
    await g.entered;

    db.sqlite.close(); // the database is gone, mid-validation
    g.release();

    await expect(executor.settle(runId)).resolves.toBeUndefined();
    expect(lines.join("\n")).toContain("could not record the plan's outcome");
    expect(lines.join("\n")).toContain(runId);
  });

  it("a validation that REJECTED and cannot be written down keeps its reason in the log and settles instead of rejecting", async () => {
    const g = gates();
    const { db, executor, lines } = makeWith(blockingPlannerDef(g, rejected));
    const { runId } = await executor.planStreamed("noop", {});
    await g.entered;

    db.sqlite.close();
    g.release();

    await expect(executor.settle(runId)).resolves.toBeUndefined();
    expect(lines.join("\n")).toContain("could not record the plan's outcome");
    expect(lines.join("\n")).toContain(runId);
    // The rejection the operator will never read off the run row is the one thing the log must keep.
    expect(lines.join("\n")).toContain(REJECTION_SUMMARY);
  });

  it("counter-probe: with the database open a PASSED validation is written planned, with its steps, and nothing is logged", async () => {
    // Without this the first test would pass just as well against a settling that wrote nothing at all.
    const g = gates();
    const { db, executor, lines } = makeWith(blockingPlannerDef(g, planned));
    const { runId } = await executor.planStreamed("noop", {});
    await g.entered;
    g.release();

    await executor.settle(runId);
    expect(runRow(db, runId).status).toBe("planned");
    expect(getRun(db.db, runId)?.steps.map((s) => s.name)).toEqual(["do-it"]);
    expect(metaLines(db, runId)).toContain("✓ Validation passed — the plan is ready for approval");
    expect(lines).toHaveLength(0);
  });

  it("counter-probe: with the database open a REJECTED validation is written failed, with its report, and nothing is logged", async () => {
    const g = gates();
    const { db, executor, lines } = makeWith(blockingPlannerDef(g, rejected));
    const { runId } = await executor.planStreamed("noop", {});
    await g.entered;
    g.release();

    await executor.settle(runId);
    const row = runRow(db, runId);
    expect(row.status).toBe("failed");
    expect(row.error).toBe(REJECTION_SUMMARY);
    expect(JSON.parse(row.plan_json ?? "null")).toEqual(REJECTION_REPORT);
    expect(getRun(db.db, runId)?.steps).toHaveLength(0); // nothing was planned
    expect(metaLines(db, runId)).toContain(`✗ ${REJECTION_SUMMARY}`);
    expect(lines).toHaveLength(0);
  });
});

/** A def whose streaming planner must never be reached: the prologue below fails before it. If it
 *  ever runs, the run is failed with THIS message instead of the database's, and the assertions on
 *  the recorded reason say so. */
function unreachedPlannerDef(): AnyRunDefinition {
  return {
    kind: "noop",
    paramsSchema: z.record(z.string(), z.unknown()),
    mutating: false,
    plan: async () => {
      throw new AppError("INTERNAL", "this def is planned via planStream, not plan()");
    },
    planStream: async () => {
      throw new AppError("INTERNAL", "the planner ran although the prologue had already failed");
    },
    steps: () => [{ name: "do-it", title: "Do it", run: async () => undefined }],
  };
}

describe("streaming plan — a prologue the database cannot take", () => {
  // The first two statements of a validation are database statements: seeding the run log's seq
  // counter READS `events`, and the first log line INSERTS into it. They are not reachable by a
  // database that dies over time — no await separates them from the `runs` insert that opened the
  // run — but they are reachable per STATEMENT: SQLITE_FULL, SQLITE_BUSY and a table the schema no
  // longer offers are all decided one statement at a time, so the `runs` insert lands and the two
  // `events` statements do not. Nothing holds this promise, so a throw there reaches the process as
  // an unhandled rejection, and Node's answer to that is to terminate the manager with every
  // other run in flight.
  //
  // `DROP TABLE events` is how the test makes exactly those two statements fail while `runs` stays
  // writable; the trigger in the second test does the same to the recording's own UPDATE.

  it("a prologue that cannot read the run log fails the run with the reason and settles instead of rejecting", async () => {
    const { db, executor, lines } = makeWith(unreachedPlannerDef());
    db.sqlite.exec("DROP TABLE events");

    const { runId } = await executor.planStreamed("noop", {});

    await expect(executor.settle(runId)).resolves.toBeUndefined();
    const row = runRow(db, runId);
    expect(row.status).toBe("failed");
    expect(row.error).toContain("no such table: events");
    // The run row could still take the reason, so nothing had to fall back to the process log.
    expect(lines).toHaveLength(0);
  });

  it("a prologue whose failure cannot be recorded either keeps the reason in the log and settles instead of rejecting", async () => {
    const { db, executor, lines } = makeWith(unreachedPlannerDef());
    db.sqlite.exec("DROP TABLE events");
    // Now the recording of the failure fails too: every UPDATE on `runs` aborts, which is what
    // SQLITE_FULL does to one statement while the rows already written stay readable.
    db.sqlite.exec("CREATE TRIGGER runs_no_update BEFORE UPDATE ON runs BEGIN SELECT RAISE(ABORT, 'the disk is full'); END");

    const { runId } = await executor.planStreamed("noop", {});

    await expect(executor.settle(runId)).resolves.toBeUndefined();
    expect(runRow(db, runId).status).toBe("planning"); // nothing could be written; resumeOnBoot settles it
    expect(lines.join("\n")).toContain("could not record the plan's outcome");
    expect(lines.join("\n")).toContain(runId);
    expect(lines.join("\n")).toContain("no such table: events");
  });

  it("counter-probe: with the run log intact the prologue writes its first line and nothing is logged", async () => {
    // Without this the two tests above would pass just as well against a prologue that wrote nothing.
    const g = gates();
    const { db, executor, lines } = makeWith(blockingPlannerDef(g, planned));
    const { runId } = await executor.planStreamed("noop", {});
    await g.entered;
    g.release();

    await executor.settle(runId);
    expect(metaLines(db, runId)[0]).toBe("Validating the repository in the sandbox…");
    expect(runRow(db, runId).status).toBe("planned");
    expect(lines).toHaveLength(0);
  });
});

/** A def whose streaming planner throws the way the gate-runner adapter does when a gate-run produced
 *  no report. */
function throwingPlannerDef(message: string): AnyRunDefinition {
  return {
    kind: "noop",
    paramsSchema: z.record(z.string(), z.unknown()),
    mutating: false,
    plan: async () => {
      throw new AppError("INTERNAL", "this def is planned via planStream, not plan()");
    },
    planStream: async () => {
      throw errGateIncomplete(message);
    },
    steps: () => [{ name: "do-it", title: "Do it", run: async () => undefined }],
  };
}

/** The shape TektonGateRunner.poll raises when the report ConfigMap carries incomplete.json: one fact
 *  per line — the sentence that says nothing was judged, the case, the runner's own reason, and the
 *  TaskRun statuses the reap would otherwise have destroyed. */
const GATE_INCOMPLETE_LINES = [
  "gate-runner (tekton): the gate-run did not run to completion — NO gate report exists, so nothing was judged about the repository under validation.",
  "the report ConfigMap gate-report-gr1 carries incomplete.json instead of report.json: the gate task produced no report file",
  "the gate-run's own reason: gate task produced no report file (killed before it wrote one)",
  "what the gate-run's TaskRuns ended as:",
  `  gate: FAILED — Failed: "step-gate" exited with code 137 (OOMKilled)`,
];

describe("streaming plan — a many-line failure reaching the operator", () => {
  // What an operator reads of a failed validation is the run log: runs.error never leaves the server
  // (RunView carries no error field), so the log lines ARE the surface. RunContext.emit writes ONE
  // events row per newline, which is what lets a failure carry a reason and its evidence instead of
  // one flattened sentence — and what this asserts, because a join anywhere on that path would leave
  // the operator with a blob no screen wraps.

  it("every line of the failure becomes its own run-log line, none of them lost or joined", async () => {
    const { db, executor } = makeWith(throwingPlannerDef(GATE_INCOMPLETE_LINES.join("\n")));
    const { runId } = await executor.planStreamed("noop", {});
    await executor.settle(runId);

    const row = runRow(db, runId);
    expect(row.status).toBe("failed");
    for (const line of GATE_INCOMPLETE_LINES) expect(row.error).toContain(line);

    const meta = metaLines(db, runId);
    // The first line is prefixed by the catch; the rest arrive verbatim, one row each.
    expect(meta).toContain(`✗ validation failed: ${GATE_INCOMPLETE_LINES[0]}`);
    for (const line of GATE_INCOMPLETE_LINES.slice(1)) expect(meta).toContain(line);
  });

  it("counter-probe: a ONE-line failure arrives as exactly one added run-log line", async () => {
    // Without this the test above would pass just as well against a log that wrote every failure as
    // one row per word, or one that wrote each failure five times.
    const { db, executor } = makeWith(throwingPlannerDef("the gate-run did not run to completion"));
    const { runId } = await executor.planStreamed("noop", {});
    await executor.settle(runId);

    const meta = metaLines(db, runId);
    expect(meta).toEqual(["Validating the repository in the sandbox…", "✗ validation failed: the gate-run did not run to completion"]);
  });
});
