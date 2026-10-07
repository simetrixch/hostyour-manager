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

// A cancel ends a step from outside, and what the step answers afterwards is the cancel seen from
// inside: a watch cut short reads as "did not converge". The run is told it was interrupted, never
// that the step failed for the reason it gave.

const logger = createLogger(parseConfig({
  ...REQUIRED_ENV, PUBLIC_URL: "https://x.example", OIDC_ISSUER: "https://i.example/", OIDC_CLIENT_ID: "c", OIDC_CLIENT_SECRET: "s",
  MANAGER_VERSION: "test", DATA_DIR: "/data", ADMIN_SOCKET_PATH: "/run/manager/admin.sock", LOG_LEVEL: "silent",
} as NodeJS.ProcessEnv));
const noSsh: SshFactory = () => Promise.reject(new Error("no ssh"));

/** One step that waits until the run is cancelled and then throws `answer`. */
function watchingStep(answer: () => Error): AnyRunDefinition {
  return {
    kind: "noop",
    paramsSchema: z.record(z.string(), z.unknown()),
    mutating: false,
    plan: async () => ({ kind: "noop", targetKind: "self", targetId: "manager", summary: "watch", steps: [{ name: "watch", title: "Watch the fan-out" }], warnings: [], requiredSecrets: [] }),
    steps: () => [{
      name: "watch", title: "Watch the fan-out",
      run: (ctx) => new Promise<void>((_resolve, reject) => ctx.signal.addEventListener("abort", () => reject(answer()), { once: true })),
    }],
  };
}

describe("Executor — what a cancelled step's run says", () => {
  const handles: DbHandle[] = [];
  const dirs: string[] = [];
  afterEach(() => {
    for (const h of handles.splice(0)) h.sqlite.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  async function cancelledRun(def: AnyRunDefinition): Promise<{ error: string | undefined; log: string[]; status: string | undefined }> {
    const dir = mkdtempSync(join(tmpdir(), "mgr-cancel-"));
    dirs.push(dir);
    const db = openDb(join(dir, "manager.db"));
    handles.push(db);
    const executor = new Executor({ db: db.db, creds: new CredentialStore({ db: db.db, logger }), bus: new RunEventBus(), logger, runDefinitions: new Map<RunKind, AnyRunDefinition>([["noop" as RunKind, def]]), sshFactory: noSsh, actor: () => "op_system" });
    const { runId } = await executor.plan("noop", {});
    await executor.approve(runId);
    await executor.cancel(runId);
    const run = getRun(db.db, runId);
    const step = db.sqlite.prepare("SELECT error FROM steps WHERE run_id = ?").get(runId) as { error: string | null } | undefined;
    return { status: run?.status, error: step?.error ?? undefined, log: readEvents(db.db, runId).map((e) => e.text) };
  }

  it("names a failure the step gave after the cancel as an interruption, keeping the answer as what came after", async () => {
    const run = await cancelledRun(watchingStep(() => new Error("tenant x fan-out did not converge — 4 of 7 Application(s) are not Synced/Healthy")));
    expect(run.status).toBe("cancelled");
    expect(run.error).toBe("interrupted by a cancel while this step ran — it answered afterwards: tenant x fan-out did not converge — 4 of 7 Application(s) are not Synced/Healthy");
    expect(run.log).toContain("✕ cancelled during: Watch the fan-out");
    expect(run.log.some((l) => l.startsWith("✗ tenant x fan-out did not converge"))).toBe(false);
  });

  it("PLANTED INNOCENT: keeps an AbortError's own words, which already name the interruption", async () => {
    const run = await cancelledRun(watchingStep(() => new DOMException("job dump-acme in acme was interrupted — the run was cancelled while it ran", "AbortError")));
    expect(run.status).toBe("cancelled");
    expect(run.error).toBe("job dump-acme in acme was interrupted — the run was cancelled while it ran");
  });
});
