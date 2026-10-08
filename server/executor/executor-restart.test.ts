import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { openDb, type DbHandle } from "../db/client.ts";
import { createLogger } from "../kernel/logger.ts";
import { parseConfig } from "../kernel/config.ts";
import { REQUIRED_ENV } from "../kernel/config.fixture.ts";
import { CredentialStore } from "../security/store.ts";
import { RunEventBus } from "./bus.ts";
import { Executor } from "./executor.ts";
import { getRun, readEvents } from "./read.ts";
import type { SshFactory } from "../adapters/ssh/port.ts";
import type { AnyRunDefinition } from "./types.ts";
import type { RunKind } from "../../shared/enums.ts";

// A Manager restart pauses a run, it never cancels one: the step in flight may end, no further step
// starts, the run stays `running`, and the next Manager resumes it where it stopped.

const logger = createLogger(parseConfig({
  ...REQUIRED_ENV, PUBLIC_URL: "https://x.example", OIDC_ISSUER: "https://i.example/", OIDC_CLIENT_ID: "c", OIDC_CLIENT_SECRET: "s",
  MANAGER_VERSION: "test", DATA_DIR: "/data", ADMIN_SOCKET_PATH: "/run/manager/admin.sock", LOG_LEVEL: "silent",
} as NodeJS.ProcessEnv));
const noSsh: SshFactory = () => Promise.reject(new Error("no ssh"));

/** Two steps: `first` waits until the test releases it, `second` counts its runs. */
function twoSteps(requiredSecrets: string[] = []) {
  const seen = { first: 0, second: 0, aborted: 0 };
  let release: (() => void) | undefined;
  const def: AnyRunDefinition = {
    kind: "noop",
    paramsSchema: z.record(z.string(), z.unknown()),
    mutating: false,
    plan: async () => ({
      kind: "noop", targetKind: "self", targetId: "manager", summary: "two steps",
      steps: [{ name: "first", title: "First" }, { name: "second", title: "Second" }], warnings: [], requiredSecrets,
      // A lock of its own, so a test can see what a cancel does to it.
      locks: [{ resource: "server", key: "planted" }],
    }),
    steps: () => [
      {
        name: "first", title: "First",
        run: (ctx) => new Promise<void>((resolve) => {
          seen.first += 1;
          ctx.signal.addEventListener("abort", () => { seen.aborted += 1; }, { once: true });
          release = resolve;
        }),
      },
      { name: "second", title: "Second", run: async () => { seen.second += 1; } },
    ],
  };
  return { def, seen, release: () => release?.() };
}

describe("Executor — a restart pauses a run and the next Manager resumes it", () => {
  const handles: DbHandle[] = [];
  const dirs: string[] = [];
  afterEach(() => {
    for (const h of handles.splice(0)) h.sqlite.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  function managerOver(db: DbHandle, def: AnyRunDefinition): Executor {
    return new Executor({ db: db.db, creds: new CredentialStore({ db: db.db, logger }), bus: new RunEventBus(), logger, runDefinitions: new Map<RunKind, AnyRunDefinition>([["noop" as RunKind, def]]), sshFactory: noSsh, actor: () => "op_system" });
  }
  function make(def: AnyRunDefinition): { db: DbHandle; executor: Executor } {
    const dir = mkdtempSync(join(tmpdir(), "mgr-restart-"));
    dirs.push(dir);
    const db = openDb(join(dir, "manager.db"));
    handles.push(db);
    return { db, executor: managerOver(db, def) };
  }
  const log = (db: DbHandle, runId: string) => readEvents(db.db, runId).map((e) => e.text);
  const until = async (ok: () => boolean) => { for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 5)); };

  it("lets the step in flight end, starts no further step, and the next Manager resumes the run to the end", async () => {
    const steps = twoSteps();
    const { db, executor } = make(steps.def);
    const { runId } = await executor.plan("noop", {});
    await executor.approve(runId);
    await until(() => steps.seen.first === 1);

    const shutdown = executor.shutdown(5_000);
    steps.release();
    await shutdown;
    const paused = getRun(db.db, runId);
    expect(paused?.status).toBe("running");
    expect(paused?.steps.map((s) => [s.name, s.status])).toEqual([["first", "ok"], ["second", "pending"]]);
    expect(steps.seen).toEqual({ first: 1, second: 0, aborted: 0 });
    expect(log(db, runId)).toContain("⏸ interrupted by a Manager restart before: Second — the next Manager resumes this run");

    await managerOver(db, steps.def).resumeOnBoot();
    expect(getRun(db.db, runId)?.status).toBe("succeeded");
    expect(steps.seen).toEqual({ first: 1, second: 1, aborted: 0 });
    expect(log(db, runId)).toContain("Run resumed after a Manager restart");
  });

  it("never aborts a step that outlasts the drain: it stays running, and the next Manager runs it again", async () => {
    const steps = twoSteps();
    const { db, executor } = make(steps.def);
    const { runId } = await executor.plan("noop", {});
    await executor.approve(runId);
    await until(() => steps.seen.first === 1);

    await executor.shutdown(30);
    expect(getRun(db.db, runId)?.status).toBe("running");
    expect(getRun(db.db, runId)?.steps.find((s) => s.name === "first")?.status).toBe("running");
    expect(steps.seen.aborted).toBe(0);

    const resumed = managerOver(db, steps.def).resumeOnBoot();
    await until(() => steps.seen.first === 2);
    steps.release();
    await resumed;
    expect(getRun(db.db, runId)?.status).toBe("succeeded");
    expect(steps.seen).toEqual({ first: 2, second: 1, aborted: 0 });
  });

  it("a cancel while the step is in flight during the drain wins: the run ends cancelled and nothing resumes it", async () => {
    const steps = twoSteps();
    const { db, executor } = make(steps.def);
    const { runId } = await executor.plan("noop", {});
    await executor.approve(runId);
    await until(() => steps.seen.first === 1);

    const shutdown = executor.shutdown(5_000);
    const cancelled = executor.cancel(runId);
    steps.release();
    await Promise.all([shutdown, cancelled]);
    expect(getRun(db.db, runId)?.status).toBe("cancelled");
    await managerOver(db, steps.def).resumeOnBoot();
    expect(getRun(db.db, runId)?.status).toBe("cancelled");
    expect(steps.seen.second).toBe(0);
  });

  it("a cancel of a run the drain already paused ends it, keeps its locks, and nothing resumes it", async () => {
    const steps = twoSteps();
    const { db, executor } = make(steps.def);
    const { runId } = await executor.plan("noop", {});
    await executor.approve(runId);
    await until(() => steps.seen.first === 1);
    const shutdown = executor.shutdown(5_000);
    steps.release();
    await shutdown;
    expect(getRun(db.db, runId)?.status).toBe("running");
    const locks = () => (db.sqlite.prepare("SELECT count(*) AS n FROM run_locks WHERE run_id = ?").get(runId) as { n: number }).n;
    expect(locks()).toBe(1);

    await executor.cancel(runId);
    expect(getRun(db.db, runId)?.status).toBe("cancelled");
    expect(log(db, runId)).toContain("✕ cancelled before: Second");
    expect(locks()).toBe(1); // cancelled in the middle: its first step's work stands until it is resolved
    await managerOver(db, steps.def).resumeOnBoot();
    expect(steps.seen.second).toBe(0);
  });

  it("says at the pause that the values typed at approve are not kept, where the run had any", async () => {
    const steps = twoSteps(["consumer-secret:SMTP_PASSWORD"]);
    const { db, executor } = make(steps.def);
    const { runId } = await executor.plan("noop", {});
    await executor.approve(runId, { "consumer-secret:SMTP_PASSWORD": Buffer.from("smtp-password-value") });
    await until(() => steps.seen.first === 1);
    const shutdown = executor.shutdown(5_000);
    steps.release();
    await shutdown;
    expect(log(db, runId).find((t) => t.startsWith("⏸"))).toMatch(/the values typed at approve are not kept across a restart/);
  });

  it("queues a run approved while the Manager shuts down, and the next Manager starts it", async () => {
    const steps = twoSteps();
    const { db, executor } = make(steps.def);
    const { runId } = await executor.plan("noop", {});
    await executor.shutdown(10);
    expect(await executor.approve(runId)).toEqual({ status: "queued" });
    expect(getRun(db.db, runId)?.status).toBe("queued");
    expect(steps.seen.first).toBe(0);
    const next = managerOver(db, steps.def);
    await next.resumeOnBoot();
    await until(() => steps.seen.first === 1);
    steps.release();
    await next.settle(runId);
    expect(getRun(db.db, runId)?.status).toBe("succeeded");
  });
});
