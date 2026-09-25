import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import pino from "pino";
import { openDb, type DbHandle } from "../db/client.ts";
import { CredentialStore } from "../security/store.ts";
import { RunEventBus } from "./bus.ts";
import { Executor } from "./executor.ts";
import { getRun } from "./read.ts";
import { runProbes, type ProbeCtx } from "./probe.ts";
import type { AnyRunDefinition, Step } from "./types.ts";
import type { RunKind } from "../../shared/enums.ts";
import type { SshFactory } from "../adapters/ssh/port.ts";
import type { PreflightCheck } from "../../shared/preflight.ts";

// EVERY STEP MAY PROBE BEFORE THE APPROVE (hostyour-manager#207). Measured here: the probes run in
// step order on both plan paths, every finding is frozen into the plan and logged, a HARD failure
// refuses the plan after every probe has run (the whole picture, not the first refusal), a soft
// failure and a warning ride along, and a probe that throws is a hard finding under its step.

const logger = pino({ level: "silent" });
const noSsh: SshFactory = () => Promise.reject(new Error("no ssh"));
const pass = (id: string, detail = "ok"): PreflightCheck => ({ id, title: `Check ${id}`, severity: "hard", status: "pass", detail });
const fail = (id: string, severity: "hard" | "soft", detail: string, hint?: string): PreflightCheck => ({ id, title: `Check ${id}`, severity, status: "fail", detail, ...(hint ? { hint } : {}) });

function step(name: string, probe?: Step["probe"]): Step {
  return { name, title: `Step ${name}`, run: async () => undefined, ...(probe ? { probe } : {}) };
}

const ctx = (log: string[] = []): ProbeCtx => ({
  db: undefined as unknown as ProbeCtx["db"], creds: { open: async () => Buffer.alloc(0), list: async () => [] },
  params: {}, signal: new AbortController().signal, log: (l) => log.push(l),
});

describe("runProbes — the rule", () => {
  it("runs the probes in step order, skips steps without one, logs every finding and returns them all", async () => {
    const order: string[] = [];
    const log: string[] = [];
    const found = await runProbes([
      step("a", async () => { order.push("a"); return [pass("a.one"), fail("a.two", "soft", "slow", "look later")]; }),
      step("b"),
      step("c", async () => { order.push("c"); return [{ id: "c.warn", title: "Check c.warn", severity: "hard", status: "warn", detail: "odd" }]; }),
    ], ctx(log));
    expect(order).toEqual(["a", "c"]);
    expect(found.map((c) => c.id)).toEqual(["a.one", "a.two", "c.warn"]);
    expect(log).toEqual(["✓ Check a.one: ok", "△ Check a.two: slow — look later", "△ Check c.warn: odd"]);
  });

  it("a HARD failure refuses the plan by name, after every probe has run", async () => {
    const order: string[] = [];
    const log: string[] = [];
    await expect(runProbes([
      step("a", async () => { order.push("a"); return [fail("a.dns", "hard", "zone example.invalid not found", "give the zone's token")]; }),
      step("b", async () => { order.push("b"); return [pass("b.ok")]; }),
    ], ctx(log))).rejects.toThrow(/refused by 1 finding\(s\) measured before the approve: Check a\.dns \(zone example\.invalid not found\)/);
    expect(order).toEqual(["a", "b"]); // b still ran: the log carries the whole picture
    expect(log[0]).toBe("✗ Check a.dns: zone example.invalid not found — give the zone's token");
  });

  it("a probe that throws is a hard finding under its step — a measurement not taken has not passed", async () => {
    await expect(runProbes([step("a", async () => { throw new Error("no route to the registry"); })], ctx()))
      .rejects.toThrow(/Step a \(no route to the registry\)/);
  });
});

describe("the two plan paths freeze the findings", () => {
  const handles: DbHandle[] = [];
  const dirs: string[] = [];
  afterEach(() => {
    for (const h of handles.splice(0)) h.sqlite.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  function makeWith(def: AnyRunDefinition): { db: DbHandle; executor: Executor } {
    const dir = mkdtempSync(join(tmpdir(), "mgr-probe-"));
    dirs.push(dir);
    const db = openDb(join(dir, "manager.db"));
    handles.push(db);
    const executor = new Executor({
      db: db.db, creds: new CredentialStore({ db: db.db, logger }), bus: new RunEventBus(), logger,
      runDefinitions: new Map<RunKind, AnyRunDefinition>([["noop", def]]), sshFactory: noSsh, actor: () => "op_system",
    });
    return { db, executor };
  }
  const plan = { kind: "noop" as const, targetKind: "self" as const, targetId: "manager", summary: "probed", steps: [{ name: "a", title: "Step a" }], warnings: [], requiredSecrets: [] };
  function def(probe: Step["probe"], streaming: boolean): AnyRunDefinition {
    return {
      kind: "noop", paramsSchema: z.record(z.string(), z.unknown()), mutating: false,
      plan: async () => plan,
      ...(streaming ? { planStream: async () => ({ outcome: "planned" as const, params: {}, plan }) } : {}),
      steps: () => [step("a", probe)],
    };
  }

  it("plan(): the findings stand in the frozen plan and on the run view; a hard failure refuses the plan", async () => {
    const { db, executor } = makeWith(def(async () => [pass("a.ok", "zone found")], false));
    const { runId } = await executor.plan("noop", {});
    expect(getRun(db.db, runId)?.findings).toEqual([pass("a.ok", "zone found")]);

    const refused = makeWith(def(async () => [fail("a.dns", "hard", "no zone")], false));
    await expect(refused.executor.plan("noop", {})).rejects.toThrow(/Check a\.dns \(no zone\)/);
  });

  it("planStream(): the findings are gate lines of the stream and stand in the plan; a hard failure settles the run failed", async () => {
    const { db, executor } = makeWith(def(async () => [pass("a.ok", "hook right held")], true));
    const { runId } = await executor.planStreamed("noop", {});
    await executor.settle(runId);
    const run = getRun(db.db, runId);
    expect(run?.status).toBe("planned");
    expect(run?.findings).toEqual([pass("a.ok", "hook right held")]);
    const meta = (db.sqlite.prepare("SELECT text FROM events WHERE run_id=? AND stream='meta'").all(runId) as { text: string }[]).map((r) => r.text);
    expect(meta).toContain("Measuring what the steps will meet…");
    expect(meta).toContain("✓ Check a.ok: hook right held");

    const refused = makeWith(def(async () => [fail("a.pkg", "hard", "package unreadable")], true));
    const second = await refused.executor.planStreamed("noop", {});
    await refused.executor.settle(second.runId);
    const failed = refused.db.sqlite.prepare("SELECT status, error FROM runs WHERE id=?").get(second.runId) as { status: string; error: string };
    expect(failed.status).toBe("failed");
    expect(failed.error).toMatch(/Check a\.pkg \(package unreadable\)/);
  });
});
