import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pino } from "pino";
import { z } from "zod";
import { openDb, type DbHandle } from "../db/client.ts";
import { AppError, errPlanRefused } from "../kernel/errors.ts";
import { CredentialStore } from "../security/store.ts";
import { RunEventBus } from "./bus.ts";
import { Executor } from "./executor.ts";
import { getRun } from "./read.ts";
import { runGuards, assertGuardsArmed, KIND_GUARDS } from "./guards.ts";
import type { AnyRunDefinition, PlanGuard } from "./types.ts";
import type { SshFactory } from "../adapters/ssh/port.ts";
import { RUN_KIND, type RunKind } from "../../shared/enums.ts";

// THE PLAN-TIME GUARD MECHANISM, and the fact that no run kind uses it today.
//
// Three guards used to stand in KIND_GUARDS and all three asked the same first question: is
// `keystore.mode` `plaintext`? They returned unless it was, and no booted manager answers yes — the
// composition root supplies the credential store with a Vault client or with a local data key and
// never with neither (boot/store-backend.ts, proved in boot/store-backend.test.ts). A guard that
// cannot refuse reads as a protection and is none, so the three went.
//
// WHAT IS MEASURED HERE IS THEREFORE THE MECHANISM, not a policy: that the table is total over
// RUN_KIND, that every entry is empty, that a guard placed in it really does refuse on BOTH plan
// paths, and that the attest-target law assertGuardsArmed carries still refuses.

describe("the plan-time guard table", () => {
  const handles: DbHandle[] = [];
  const dirs: string[] = [];
  function fresh(): DbHandle {
    const dir = mkdtempSync(join(tmpdir(), "mgr-gd-"));
    dirs.push(dir);
    const h = openDb(join(dir, "manager.db"));
    handles.push(h);
    return h;
  }
  afterEach(() => {
    for (const h of handles.splice(0)) h.sqlite.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("is total over RUN_KIND, and every run kind carries an empty list", () => {
    expect(Object.keys(KIND_GUARDS).sort()).toEqual([...RUN_KIND].sort());
    const armed = (Object.keys(KIND_GUARDS) as RunKind[]).filter((kind) => KIND_GUARDS[kind].length > 0);
    expect(armed, `a guard stands on ${armed.join(", ")} — a run kind that refuses at plan time needs its own case here`)
      .toEqual([]);
  });

  it("runs nothing for a kind whose list is empty", async () => {
    const { db } = fresh();
    for (const kind of ["noop", "cluster-deploy-slave", "consumer-onboard", "tenant-create"] as const) {
      await expect(runGuards(kind, { clusterId: "cls_x", serverId: "srv_x" }, { db })).resolves.toBeUndefined();
    }
  });

  it("PLANTED DEFECT: a guard placed in the table really is run, and its refusal is what the caller sees", async () => {
    // The counter-probe of the case above. Without it, "every list is empty" and "the mechanism no
    // longer works" look identical from the outside, and the day somebody adds a guard back it would
    // be a guard nothing calls.
    const { db } = fresh();
    const refusing: PlanGuard = async () => {
      throw errPlanRefused("the planted guard refuses");
    };
    const original = KIND_GUARDS.noop;
    (KIND_GUARDS as Record<RunKind, readonly PlanGuard[]>).noop = [refusing];
    try {
      const err = await runGuards("noop", {}, { db }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe("PLAN_REFUSED");
      expect((err as AppError).message).toContain("the planted guard refuses");
    } finally {
      (KIND_GUARDS as Record<RunKind, readonly PlanGuard[]>).noop = original;
    }
  });

  it("assertGuardsArmed passes an empty runDefinitions and rejects a mutating def without attest-target", () => {
    const empty = new Map<RunKind, AnyRunDefinition>();
    expect(() => assertGuardsArmed(empty)).not.toThrow();
    // A FABRICATED def under the fixture literal, never a real one: what is measured is the rule
    // itself — a mutating def whose step 0 is not attest-target — and keying it on a run kind that
    // really is mutating would read as a claim about that run kind's own steps.
    const bad = new Map<RunKind, AnyRunDefinition>([
      ["noop", { kind: "noop", mutating: true, steps: () => [{ name: "not-attest", title: "x", run: async () => undefined }] } as unknown as AnyRunDefinition],
    ]);
    expect(() => assertGuardsArmed(bad)).toThrow(/attest-target/);
  });
});

// A minimal streaming-planned tenant-create def: its planStream resolves params carrying the target
// clusterId (as the real tenant-create slice will), and its plan is a single attest-target step so
// the planned/steps invariant holds. It exercises the runStreamingPlan → runGuards wiring only.
function streamingCreateTenantDef(): AnyRunDefinition {
  return {
    kind: "tenant-create",
    paramsSchema: z.record(z.string(), z.unknown()),
    mutating: true,
    plan: async () => {
      throw new AppError("INTERNAL", "tenant-create is planned via planStream, not plan()");
    },
    planStream: async (rawParams) => {
      const clusterId = (rawParams as { clusterId?: unknown }).clusterId;
      return {
        outcome: "planned",
        params: { clusterId },
        plan: {
          kind: "tenant-create",
          targetKind: "tenant",
          targetId: typeof clusterId === "string" ? clusterId : "unknown",
          summary: "test tenant-create plan",
          steps: [{ name: "attest-target", title: "Attest the target cluster" }],
          warnings: [],
          requiredSecrets: [],
        },
      };
    },
    steps: () => [{ name: "attest-target", title: "Attest the target cluster", run: async () => undefined }],
  };
}

// THE STREAMING PLAN PATH RUNS THE TABLE TOO, and that is the half a caller cannot see: a kind
// planned through planStream resolves its params during the plan, so a guard keyed on a resolved
// field would never fire if only executor.plan() called runGuards.
describe("the streaming plan path runs the guard table", () => {
  const handles: DbHandle[] = [];
  const dirs: string[] = [];
  const logger = pino({ level: "silent" });
  const noSsh: SshFactory = () => Promise.reject(new Error("ssh must not be used during planning"));

  function make(): { db: DbHandle; executor: Executor } {
    const dir = mkdtempSync(join(tmpdir(), "mgr-sp-"));
    dirs.push(dir);
    const db = openDb(join(dir, "manager.db"));
    handles.push(db);
    db.sqlite.prepare("INSERT INTO servers (id, name, host, ssh_user, role) VALUES ('srv_h','h','3.3.3.3','root','slave')").run();
    db.sqlite.prepare("INSERT INTO clusters (id, server_id, stage, domain) VALUES ('cls_h','srv_h','prod','h.example')").run();
    const store = new CredentialStore({ db: db.db, logger });
    const runDefinitions = new Map<RunKind, AnyRunDefinition>([["tenant-create", streamingCreateTenantDef()]]);
    const executor = new Executor({ db: db.db, creds: store, bus: new RunEventBus(), logger, runDefinitions, sshFactory: noSsh, actor: () => "op_system" });
    return { db, executor };
  }
  afterEach(() => {
    for (const h of handles.splice(0)) h.sqlite.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  const runError = (db: DbHandle, runId: string): string =>
    (db.sqlite.prepare("SELECT error FROM runs WHERE id=?").get(runId) as { error: string | null }).error ?? "";

  it("PLANTED DEFECT: a guard reading the RESOLVED params refuses a streamed plan before any step is frozen", async () => {
    const { db, executor } = make();
    const seen: unknown[] = [];
    const refusing: PlanGuard = async (params) => {
      seen.push(params);
      throw errPlanRefused("the planted guard refuses this cluster");
    };
    const original = KIND_GUARDS["tenant-create"];
    (KIND_GUARDS as Record<RunKind, readonly PlanGuard[]>)["tenant-create"] = [refusing];
    try {
      const { runId } = await executor.planStreamed("tenant-create", { clusterId: "cls_h" });
      await executor.settle(runId);
      const run = getRun(db.db, runId);
      expect(run?.status).toBe("failed");
      expect(run?.steps).toHaveLength(0); // refused before any plan/steps were frozen
      expect(runError(db, runId)).toContain("the planted guard refuses this cluster");
      // The RESOLVED params reached it — the whole reason the streaming path calls the table itself.
      expect(seen).toEqual([{ clusterId: "cls_h" }]);
    } finally {
      (KIND_GUARDS as Record<RunKind, readonly PlanGuard[]>)["tenant-create"] = original;
    }
  });

  it("PLANTED INNOCENT: with the table as it ships, the same streamed plan is planned", async () => {
    const { db, executor } = make();
    const { runId } = await executor.planStreamed("tenant-create", { clusterId: "cls_h" });
    await executor.settle(runId);
    const run = getRun(db.db, runId);
    expect(run?.status).toBe("planned");
    expect(run?.steps.map((s) => s.name)).toEqual(["attest-target"]);
    expect(run?.targetKind).toBe("tenant");
  });
});
