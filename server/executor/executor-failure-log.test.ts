import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pino } from "pino";
import { z } from "zod";
import { openDb, type DbHandle } from "../db/client.ts";
import { CredentialStore } from "../security/store.ts";
import { registerSecret } from "../security/redact.ts";
import { RunEventBus } from "./bus.ts";
import { Executor } from "./executor.ts";
import { getRun } from "./read.ts";
import type { AnyRunDefinition } from "./types.ts";
import type { RunKind } from "../../shared/enums.ts";

// A failed run reaches master's log alarm only as a line of the process log: the run record alone is
// read by nobody who is not looking at it.

const dirs: string[] = [];
const handles: DbHandle[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) h.sqlite.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const SECRET = "hunter2-secret";
const failing: AnyRunDefinition = {
  kind: "noop",
  paramsSchema: z.record(z.string(), z.unknown()),
  mutating: false,
  plan: async () => ({ kind: "noop", targetKind: "self", targetId: "manager", summary: "fails on purpose", steps: [{ name: "boom", title: "Blow up" }], warnings: [], requiredSecrets: [] }),
  steps: () => [{ name: "boom", title: "Blow up", run: async (ctx) => { registerSecret(ctx.runId, Buffer.from(SECRET, "utf8")); throw new Error(`dump failed for ${SECRET}`); } }],
};

function executorOf(def: AnyRunDefinition): { db: DbHandle; executor: Executor; lines: string[] } {
  const dir = mkdtempSync(join(tmpdir(), "mgr-faillog-"));
  dirs.push(dir);
  const db = openDb(join(dir, "manager.db"));
  handles.push(db);
  const lines: string[] = [];
  const logger = pino({ level: "error" }, { write: (s: string) => { lines.push(s); } });
  const executor = new Executor({
    db: db.db, creds: new CredentialStore({ db: db.db, logger }), bus: new RunEventBus(), logger,
    runDefinitions: new Map<RunKind, AnyRunDefinition>([["noop", def]]), sshFactory: () => Promise.reject(new Error("no ssh")),
  });
  return { db, executor, lines };
}

const runFailedLines = (lines: readonly string[]): Record<string, unknown>[] =>
  lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l["msg"] === "run failed");

describe("a failed run in the process log", () => {
  it("PLANTED DEFECT: is one error line with its run, its kind and its masked reason", async () => {
    const { executor, lines } = executorOf(failing);
    const { runId } = await executor.plan("noop", {});
    await executor.approve(runId);
    await executor.settle(runId);
    const failed = runFailedLines(lines);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ level: 50, runId, kind: "noop" });
    expect(String(failed[0]!["runError"])).toContain("dump failed for •••");
    expect(lines.join("\n")).not.toContain(SECRET);
  });

  it("PLANTED INNOCENT: a run cancelled while its step fails with the abort writes no such line", async () => {
    let entered!: () => void;
    const started = new Promise<void>((r) => { entered = r; });
    const waiting: AnyRunDefinition = {
      ...failing,
      steps: () => [{ name: "boom", title: "Blow up", run: async (ctx) => {
        entered();
        await new Promise<void>((_, reject) => ctx.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
      } }],
    };
    const { db, executor, lines } = executorOf(waiting);
    const { runId } = await executor.plan("noop", {});
    await executor.approve(runId);
    await started;
    await executor.cancel(runId);
    expect(getRun(db.db, runId)?.status).toBe("cancelled");
    expect(runFailedLines(lines)).toEqual([]);
  });
});
