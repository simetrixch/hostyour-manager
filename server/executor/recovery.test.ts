import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { openDb, type DbHandle } from "../db/client.ts";
import { createLogger } from "../kernel/logger.ts";
import { parseConfig } from "../kernel/config.ts";
import { CredentialStore } from "../security/store.ts";
import { errValidation } from "../kernel/errors.ts";
import { RunEventBus } from "./bus.ts";
import { Executor } from "./executor.ts";
import { getRun } from "./read.ts";
import type { RunDefinition, AnyRunDefinition, Cleanup, Step } from "./types.ts";
import type { RunKind } from "../../shared/enums.ts";
import type { SshFactory } from "../adapters/ssh/port.ts";

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
const noSsh: SshFactory = () => Promise.reject(new Error("no ssh"));

// A controllable definition registered under the valid kind "noop": two prep steps each
// register a cleanup, then `act` fails while `failAct` is set — and a FOURTH step follows it,
// so the failure sits in the MIDDLE of the list. That placement is the point: with `act` last
// there are no pending steps left, and the abort-ordering defect cannot be observed.
let failAct = true;
let failVerify = false;
/** When set, the DEFINITION refuses an abort with this message — the seam abortWithCleanup asks before it
 *  schedules a single cleanup step. A compensation is a mutation, and only the definition knows what
 *  un-doing its own steps would take off the world; the executor is domain-agnostic and only relays. */
let refuseAbort: string | null = null;
const cleanupLog: string[] = [];
/** Every execution of the post-failure step — asserts it does NOT re-run on an abort. */
const verifyLog: string[] = [];
const cleanupX: Cleanup = { name: "undo-x", title: "Undo X", run: async () => void cleanupLog.push("undo-x") };
const cleanupY: Cleanup = { name: "undo-y", title: "Undo Y", run: async () => void cleanupLog.push("undo-y") };
const testSteps: Step[] = [
  { name: "prep-x", title: "Prepare X", run: async (ctx) => ctx.registerCleanup(cleanupX) },
  { name: "prep-y", title: "Prepare Y", run: async (ctx) => ctx.registerCleanup(cleanupY) },
  {
    name: "act",
    title: "Act",
    run: async (ctx) => {
      ctx.log("stdout", "acting");
      if (failAct) throw new Error("act-boom");
    },
  },
  // Stands in for create-tenant's `smoke`: a step AFTER the failure that would re-fail against
  // the same broken state if the abort let it run again.
  {
    name: "verify",
    title: "Verify",
    run: async () => {
      verifyLog.push("verify");
      if (failVerify) throw new Error("verify-boom");
    },
  },
];
// A MUTATING definition alongside it, registered under the valid kind "consumer-purge" (whose KIND_GUARDS entry
// is empty, so plan() needs no crypto-gate fixture). guards.assertGuardsArmed pins step 0 of every
// mutating def to attest-target; this one exercises what that step MEANS at run time — a fail-closed
// gate that refuses on the world as it is now (tenant-purge's attest-target re-asks the live-tenant
// rule there), followed by the mutation it stands in front of.
let refuseAttest: string | null = null;
let failMutate = false;
/** Every execution of the step the gate stands in front of — stands in for tenant-purge's
 *  remove-pointer / delete-tenant-cr / delete-namespace. */
const mutateLog: string[] = [];
const gatedSteps: Step[] = [
  {
    name: "attest-target",
    title: "Attest the target",
    run: async () => {
      if (refuseAttest) throw errValidation(refuseAttest);
    },
  },
  {
    name: "mutate",
    title: "Mutate the world",
    run: async () => {
      mutateLog.push("mutate");
      if (failMutate) throw new Error("mutate-boom");
    },
  },
];
const gatedDef: RunDefinition = {
  kind: "consumer-purge",
  paramsSchema: z.record(z.string(), z.unknown()),
  mutating: true, // mutating ⇒ steps()[0] MUST be attest-target
  plan: async () => ({
    kind: "consumer-purge",
    targetKind: "cluster",
    targetId: "cls_1",
    summary: "gated recovery test",
    steps: gatedSteps.map((s) => ({ name: s.name, title: s.title })),
    targets: [],
    warnings: [],
    requiredSecrets: [],
  }),
  steps: () => gatedSteps,
};

const testDef: RunDefinition = {
  kind: "noop",
  paramsSchema: z.record(z.string(), z.unknown()),
  mutating: false,
  plan: async () => ({
    kind: "noop",
    targetKind: "self",
    targetId: "manager",
    summary: "recovery test",
    steps: testSteps.map((s) => ({ name: s.name, title: s.title })),
    warnings: [],
    requiredSecrets: [],
  }),
  steps: () => testSteps,
  cleanups: () => [cleanupX, cleanupY],
  assertAbortable: async () => {
    if (refuseAbort) throw errValidation(refuseAbort);
  },
};

describe("Executor recovery — retry / skip / abort-with-cleanup", () => {
  const handles: DbHandle[] = [];
  const dirs: string[] = [];
  function make(): { db: DbHandle; executor: Executor } {
    failAct = true;
    failVerify = false;
    refuseAbort = null;
    refuseAttest = null;
    failMutate = false;
    cleanupLog.length = 0;
    verifyLog.length = 0;
    mutateLog.length = 0;
    const dir = mkdtempSync(join(tmpdir(), "ctrl-rec-"));
    dirs.push(dir);
    const db = openDb(join(dir, "controller.db"));
    handles.push(db);
    const store = new CredentialStore({ db: db.db, logger });
    const runDefinitions: Map<RunKind, AnyRunDefinition> = new Map([
      ["noop", testDef],
      ["consumer-purge", gatedDef],
    ]);
    const executor = new Executor({ db: db.db, creds: store, bus: new RunEventBus(), logger, runDefinitions, sshFactory: noSsh, actor: () => "op_system" });
    return { db, executor };
  }
  afterEach(() => {
    for (const h of handles.splice(0)) h.sqlite.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  async function planApproveFail(executor: Executor): Promise<string> {
    const { runId } = await executor.plan("noop", {});
    await executor.approve(runId);
    await executor.settle(runId);
    return runId;
  }

  it("a failing step lands the run failed with the step's error", async () => {
    const { db, executor } = make();
    const runId = await planApproveFail(executor);
    const run = getRun(db.db, runId);
    expect(run?.status).toBe("failed");
    expect(run?.steps.find((s) => s.name === "act")?.status).toBe("failed");
    expect(run?.steps.find((s) => s.name === "prep-x")?.status).toBe("ok");
  });

  it("retryFromStep re-runs the failed step and succeeds", async () => {
    const { db, executor } = make();
    const runId = await planApproveFail(executor);
    failAct = false;
    await executor.retryFromStep(runId);
    await executor.settle(runId);
    const run = getRun(db.db, runId);
    expect(run?.status).toBe("succeeded");
    expect(run?.steps.every((s) => s.status === "ok")).toBe(true);
  });

  it("skipStep marks the failed step skipped and the run still succeeds", async () => {
    const { db, executor } = make();
    const runId = await planApproveFail(executor);
    await executor.skipStep(runId, "act", "handled manually on the box");
    await executor.settle(runId);
    const run = getRun(db.db, runId);
    expect(run?.status).toBe("succeeded");
    expect(run?.steps.find((s) => s.name === "act")?.status).toBe("skipped");
  });

  // The fail-closed PRECONDITION of a mutating run (step 0) is not ordinary work: it is the run
  // re-asking the world whether it may mutate at all — which is the only ask that HOLDS, since approve
  // re-validates nothing (tenant-purge's attest-target re-asks the live-tenant refusal for exactly that
  // reason). Every step after it mutates, so a skip there is not "proceed past one step", it is "run the
  // deletions the gate just refused".
  describe("a MUTATING run's precondition", () => {
    /** Plan + approve the gated def and let it settle — the gate refuses, so the run fails at step 0. */
    async function refusedAtGate(executor: Executor, why = "the tenant is live — the purge would deprovision it"): Promise<string> {
      refuseAttest = why;
      const { runId } = await executor.plan("consumer-purge", {});
      await executor.approve(runId);
      await executor.settle(runId);
      return runId;
    }

    it("cannot be skipped — the two-click bypass of the belt it re-asks", async () => {
      const { db, executor } = make();
      const runId = await refusedAtGate(executor);
      expect(getRun(db.db, runId)?.steps.find((s) => s.name === "attest-target")?.status).toBe("failed");

      // The run screen feeds its skip dialog exactly the failed steps, so this is the ONE click that used
      // to turn the refusal into "proceed": the step went skipped, the run went running, and the loop —
      // which passes over skipped rows — walked straight into the mutations the gate refused.
      await expect(executor.skipStep(runId, "attest-target", "I know, proceed anyway")).rejects.toThrow(/cannot be skipped/);
      await executor.settle(runId);

      const run = getRun(db.db, runId);
      expect(run?.status).toBe("failed"); // untouched — not even moved to running
      expect(run?.steps.find((s) => s.name === "attest-target")?.status).toBe("failed");
      expect(run?.steps.find((s) => s.name === "mutate")?.status).toBe("pending");
      expect(mutateLog).toEqual([]); // nothing the gate refused ever ran
    });

    it("is re-asked by a retry aimed at a LATER step — a retry can never walk past it either", async () => {
      // The counterpart proof for retryFromStep: it never marks a step ok or skipped, and execute()
      // re-runs every row that is neither, in ordinal order — so naming a later step leaves the failed
      // precondition at ordinal 0 and the loop walks into it first.
      const { db, executor } = make();
      const runId = await refusedAtGate(executor);
      await executor.retryFromStep(runId, "mutate");
      await executor.settle(runId);
      expect(mutateLog).toEqual([]);
      expect(getRun(db.db, runId)?.steps.find((s) => s.name === "attest-target")?.status).toBe("failed");

      // ...and once the world it refused on has changed, the same retry proceeds — the gate is a state,
      // not a verdict on the run.
      refuseAttest = null;
      await executor.retryFromStep(runId, "mutate");
      await executor.settle(runId);
      expect(mutateLog).toEqual(["mutate"]);
      expect(getRun(db.db, runId)?.status).toBe("succeeded");
    });

    it("does not make a mutating run's ORDINARY steps unskippable", async () => {
      // The refusal is about the precondition, not about mutating runs: a step that failed AFTER the gate
      // held is still the operator's to skip, with its mandatory reason, exactly as before.
      const { db, executor } = make();
      failMutate = true;
      const { runId } = await executor.plan("consumer-purge", {});
      await executor.approve(runId);
      await executor.settle(runId);
      expect(getRun(db.db, runId)?.steps.find((s) => s.name === "mutate")?.status).toBe("failed");

      await executor.skipStep(runId, "mutate", "reaped by hand on the cluster");
      await executor.settle(runId);
      const run = getRun(db.db, runId);
      expect(run?.status).toBe("succeeded");
      expect(run?.steps.find((s) => s.name === "mutate")?.status).toBe("skipped");
    });
  });

  it("abortWithCleanup runs registered cleanups in reverse order and cancels", async () => {
    const { db, executor } = make();
    const runId = await planApproveFail(executor);
    await executor.abortWithCleanup(runId);
    await executor.settle(runId);
    const run = getRun(db.db, runId);
    expect(run?.status).toBe("cancelled");
    expect(cleanupLog).toEqual(["undo-y", "undo-x"]); // reverse registration order
    expect(run?.steps.filter((s) => s.name.startsWith("cleanup:")).length).toBe(2);
    expect(run?.steps.find((s) => s.name === "act")?.status).toBe("skipped");
  });

  it("abortWithCleanup abandons the steps AFTER the failure instead of re-running them", async () => {
    const { db, executor } = make();
    failVerify = true; // `verify` would re-fail against the same broken state, as create-tenant's `smoke` does
    const runId = await planApproveFail(executor);
    expect(getRun(db.db, runId)?.steps.find((s) => s.name === "verify")?.status).toBe("pending");

    await executor.abortWithCleanup(runId);
    await executor.settle(runId);

    const run = getRun(db.db, runId);
    // Before the fix `verify` was still pending and — coming FIRST in ordinal order — re-executed
    // ahead of the appended cleanups, failed the run again, and left the compensation unreachable.
    expect(verifyLog).toEqual([]);
    expect(run?.steps.find((s) => s.name === "verify")?.status).toBe("skipped");
    expect(cleanupLog).toEqual(["undo-y", "undo-x"]);
    expect(run?.status).toBe("cancelled");
  });

  it("a SECOND abortWithCleanup reuses the cleanup rows instead of violating steps_run_name_uq", async () => {
    const { db, executor } = make();
    const runId = await planApproveFail(executor);
    await executor.abortWithCleanup(runId);
    await executor.settle(runId);

    // The run is cancelled but still abortable; a re-abort used to INSERT the same cleanup step
    // names again, throwing out of the transaction into the route and wedging the run for good.
    await expect(executor.abortWithCleanup(runId)).resolves.toBeUndefined();
    await executor.settle(runId);

    const run = getRun(db.db, runId);
    expect(run?.steps.filter((s) => s.name.startsWith("cleanup:")).length).toBe(2);
    expect(run?.status).toBe("cancelled");
    expect(cleanupLog).toEqual(["undo-y", "undo-x", "undo-y", "undo-x"]); // ran once per abort
  });

  it("a definition may REFUSE the abort — nothing is scheduled and the run is left exactly as it was", async () => {
    // The seam that makes an abort refusable at all: abortWithCleanup gates only on
    // the run STATUS, which says the run stopped and nothing about what un-doing it would take off the
    // world. create-tenant's compensations un-deploy a tenant, so a run whose tenant has meanwhile gone
    // live must not be aborted — and the executor must never learn what a tenant is to enforce that. It
    // ASKS the definition, before a single cleanup row exists, and relays the refusal to the caller.
    const { db, executor } = make();
    const runId = await planApproveFail(executor);
    refuseAbort = "the thing this run created is live";
    await expect(executor.abortWithCleanup(runId)).rejects.toThrow(/is live/);

    const refused = getRun(db.db, runId);
    expect(refused?.status).toBe("failed"); // untouched — not even moved to running
    expect(refused?.steps.some((s) => s.name.startsWith("cleanup:"))).toBe(false);
    expect(refused?.steps.find((s) => s.name === "verify")?.status).toBe("pending"); // not even abandoned
    expect(cleanupLog).toEqual([]);

    // ...and the refusal is a state, not a verdict on the run: once it lifts, the abort works as before.
    refuseAbort = null;
    await executor.abortWithCleanup(runId);
    await executor.settle(runId);
    expect(getRun(db.db, runId)?.status).toBe("cancelled");
    expect(cleanupLog).toEqual(["undo-y", "undo-x"]);
  });

  it("abortWithCleanup with no registered cleanups just cancels", async () => {
    const { db, executor } = make();
    // fail immediately at prep-x by making the first step throw — no cleanups registered yet
    const { runId } = await executor.plan("noop", {});
    await executor.approve(runId);
    await executor.settle(runId);
    // (act failed after prep-x/prep-y registered cleanups, so this run HAS cleanups;
    //  to test the empty path, clear them out of the checkpoints)
    db.sqlite.prepare("UPDATE steps SET checkpoint_json=NULL WHERE run_id=?").run(runId);
    // The definition's refusal is NOT asked on this path, and must not be: an abort that compensates
    // nothing mutates nothing, so there is nothing for the definition to refuse — and asking anyway would
    // strand exactly the runs that never got far enough to register a compensation.
    refuseAbort = "would take something off the world";
    await executor.abortWithCleanup(runId);
    const run = getRun(db.db, runId);
    expect(run?.status).toBe("cancelled");
    expect(run?.steps.some((s) => s.name.startsWith("cleanup:"))).toBe(false);
  });
});
