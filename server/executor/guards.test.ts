import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pino } from "pino";
import { z } from "zod";
import { openDb, type DbHandle } from "../db/client.ts";
import { AppError } from "../kernel/errors.ts";
import { CredentialStore } from "../security/store.ts";
import { RunEventBus } from "./bus.ts";
import { Executor } from "./executor.ts";
import { getRun } from "./read.ts";
import { runGuards, assertGuardsArmed, KIND_GUARDS } from "./guards.ts";
import type { AnyRunDefinition } from "./types.ts";
import type { SshFactory } from "../adapters/ssh/port.ts";
import type { RunKind } from "../../shared/enums.ts";

describe("crypto gate", () => {
  const handles: DbHandle[] = [];
  const dirs: string[] = [];
  function fresh(mode = "plaintext"): DbHandle {
    const dir = mkdtempSync(join(tmpdir(), "ctrl-gd-"));
    dirs.push(dir);
    const h = openDb(join(dir, "controller.db"));
    handles.push(h);
    h.sqlite.prepare("INSERT INTO meta (key, value) VALUES ('keystore.mode', ?)").run(mode);
    return h;
  }
  afterEach(() => {
    for (const h of handles.splice(0)) h.sqlite.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  const refused = async (fn: () => Promise<void>): Promise<string | undefined> => {
    try {
      await fn();
      return undefined;
    } catch (e) {
      return e instanceof AppError ? e.code : "?";
    }
  };

  it("deploy-slave allowed under plaintext for a rehearsal slave with zero live slaves", async () => {
    const { db } = fresh();
    await expect(runGuards("deploy-slave", { tier: "rehearsal" }, { db })).resolves.toBeUndefined();
  });

  it("deploy-slave refused under plaintext when tier is real", async () => {
    const { db } = fresh();
    expect(await refused(() => runGuards("deploy-slave", { tier: "real" }, { db }))).toBe("PLAN_REFUSED");
  });

  it("deploy-slave refused under plaintext when a live slave already exists", async () => {
    const { db, sqlite } = fresh();
    sqlite.prepare("INSERT INTO servers (id, name, host, ssh_user, role) VALUES ('srv_e','s5','2.2.2.2','root','slave')").run();
    sqlite.prepare("INSERT INTO clusters (id, server_id, stage, domain, status) VALUES ('cls_e','srv_e','prod','s5.example','active')").run();
    expect(await refused(() => runGuards("deploy-slave", { tier: "rehearsal" }, { db }))).toBe("PLAN_REFUSED");
  });

  it("the gate is open once the store is no longer plaintext", async () => {
    const { db, sqlite } = fresh();
    sqlite.prepare("UPDATE meta SET value='passphrase' WHERE key='keystore.mode'").run();
    sqlite.prepare("INSERT INTO servers (id, name, host, ssh_user, role) VALUES ('srv_e','s5','2.2.2.2','root','slave')").run();
    sqlite.prepare("INSERT INTO clusters (id, server_id, stage, domain, status) VALUES ('cls_e','srv_e','prod','s5.example','active')").run();
    await expect(runGuards("deploy-slave", { tier: "real" }, { db })).resolves.toBeUndefined();
  });

  it("onboard refused onto a real cluster under plaintext, allowed onto rehearsal", async () => {
    const { db, sqlite } = fresh();
    sqlite.prepare("INSERT INTO servers (id, name, host, ssh_user, role) VALUES ('srv_e','slave-r','2.2.2.2','root','slave')").run();
    sqlite.prepare("INSERT INTO clusters (id, server_id, stage, domain, tier) VALUES ('cls_r','srv_e','prod','a.example','real')").run();
    sqlite.prepare("INSERT INTO servers (id, name, host, ssh_user, role) VALUES ('srv_f','slave-h','3.3.3.3','root','slave')").run();
    sqlite.prepare("INSERT INTO clusters (id, server_id, stage, domain, tier) VALUES ('cls_h','srv_f','prod','b.example','rehearsal')").run();
    expect(await refused(() => runGuards("onboard", { clusterId: "cls_r" }, { db }))).toBe("PLAN_REFUSED");
    await expect(runGuards("onboard", { clusterId: "cls_h" }, { db })).resolves.toBeUndefined();
  });

  it("create-tenant / add-app are crypto-gated like onboard: refused onto a real cluster, allowed onto rehearsal", async () => {
    const { db, sqlite } = fresh();
    sqlite.prepare("INSERT INTO servers (id, name, host, ssh_user, role) VALUES ('srv_e','slave-r','2.2.2.2','root','slave')").run();
    sqlite.prepare("INSERT INTO clusters (id, server_id, stage, domain, tier) VALUES ('cls_r','srv_e','prod','a.example','real')").run();
    sqlite.prepare("INSERT INTO servers (id, name, host, ssh_user, role) VALUES ('srv_f','slave-h','3.3.3.3','root','slave')").run();
    sqlite.prepare("INSERT INTO clusters (id, server_id, stage, domain, tier) VALUES ('cls_h','srv_f','prod','b.example','rehearsal')").run();
    expect(await refused(() => runGuards("create-tenant", { clusterId: "cls_r" }, { db }))).toBe("PLAN_REFUSED");
    await expect(runGuards("create-tenant", { clusterId: "cls_h" }, { db })).resolves.toBeUndefined();
    // add-app resolves clusterId from its tenant during the plan; the same gate applies to that resolved id.
    expect(await refused(() => runGuards("add-app", { clusterId: "cls_r" }, { db }))).toBe("PLAN_REFUSED");
    await expect(runGuards("add-app", { clusterId: "cls_h" }, { db })).resolves.toBeUndefined();
  });

  it("create-tenant / add-app gates are open once the store is no longer plaintext", async () => {
    const { db, sqlite } = fresh();
    sqlite.prepare("UPDATE meta SET value='passphrase' WHERE key='keystore.mode'").run();
    sqlite.prepare("INSERT INTO servers (id, name, host, ssh_user, role) VALUES ('srv_e','slave-r','2.2.2.2','root','slave')").run();
    sqlite.prepare("INSERT INTO clusters (id, server_id, stage, domain, tier) VALUES ('cls_r','srv_e','prod','a.example','real')").run();
    await expect(runGuards("create-tenant", { clusterId: "cls_r" }, { db })).resolves.toBeUndefined();
    await expect(runGuards("add-app", { clusterId: "cls_r" }, { db })).resolves.toBeUndefined();
  });

  it("create-tenant + add-app are armed and the four tenant-lifecycle kinds carry no guards", async () => {
    const { db } = fresh();
    expect(KIND_GUARDS["create-tenant"]).not.toHaveLength(0);
    expect(KIND_GUARDS["add-app"]).not.toHaveLength(0);
    for (const kind of ["remove-app", "tenant-suspend", "tenant-resume", "tenant-offboard"] as const) {
      expect(KIND_GUARDS[kind]).toHaveLength(0);
      await expect(runGuards(kind, { clusterId: "cls_r" }, { db })).resolves.toBeUndefined();
    }
  });

  it("redeploy carries no crypto gate: it acts on a cluster that is already live", async () => {
    const { db } = fresh();
    expect(KIND_GUARDS.redeploy).toHaveLength(0);
    await expect(runGuards("redeploy", { serverId: "srv_x" }, { db })).resolves.toBeUndefined();
  });

  it("release carries no crypto gate either — the regenerate-branch program exists, and the one shape still without a regeneration (a slave) is the def's own plan-time refusal", async () => {
    const { db } = fresh("keyfile");
    expect(KIND_GUARDS.release).toHaveLength(0);
    await expect(runGuards("release", { serverId: "srv_x" }, { db })).resolves.toBeUndefined();
  });

  it("assertGuardsArmed rejects a runDefinitions once create-tenant's gate is disarmed", () => {
    // Guard against a future edit silently emptying KIND_GUARDS["create-tenant"]: temporarily blank
    // it and confirm the boot self-check now fails on create-tenant (it is in the armed set).
    const original = KIND_GUARDS["create-tenant"];
    (KIND_GUARDS as Record<RunKind, readonly unknown[]>)["create-tenant"] = [];
    try {
      expect(() => assertGuardsArmed(new Map())).toThrow(/create-tenant/);
    } finally {
      (KIND_GUARDS as Record<RunKind, readonly unknown[]>)["create-tenant"] = original;
    }
  });

  it("noop has no guards", async () => {
    const { db } = fresh();
    await expect(runGuards("noop", {}, { db })).resolves.toBeUndefined();
    expect(KIND_GUARDS.noop).toHaveLength(0);
  });

  it("assertGuardsArmed passes an empty runDefinitions and rejects a mutating def without attest-target", () => {
    const empty = new Map<RunKind, AnyRunDefinition>();
    expect(() => assertGuardsArmed(empty)).not.toThrow();
    const bad = new Map<RunKind, AnyRunDefinition>([
      ["adopt", { kind: "adopt", mutating: true, steps: () => [{ name: "not-attest", title: "x", run: async () => undefined }] } as unknown as AnyRunDefinition],
    ]);
    expect(() => assertGuardsArmed(bad)).toThrow(/attest-target/);
  });
});

// A minimal streaming-planned create-tenant def: its planStream resolves params carrying the target
// clusterId (as the real create-tenant slice will), and its plan is a single attest-target step so
// the planned/steps invariant holds. It exercises the runStreamingPlan → runGuards wiring only.
function streamingCreateTenantDef(): AnyRunDefinition {
  return {
    kind: "create-tenant",
    paramsSchema: z.record(z.string(), z.unknown()),
    mutating: true,
    plan: async () => {
      throw new AppError("INTERNAL", "create-tenant is planned via planStream, not plan()");
    },
    planStream: async (rawParams) => {
      const clusterId = (rawParams as { clusterId?: unknown }).clusterId;
      return {
        outcome: "planned",
        params: { clusterId },
        plan: {
          kind: "create-tenant",
          targetKind: "tenant",
          targetId: typeof clusterId === "string" ? clusterId : "unknown",
          summary: "test create-tenant plan",
          steps: [{ name: "attest-target", title: "Attest the target cluster" }],
          warnings: [],
          requiredSecrets: [],
        },
      };
    },
    steps: () => [{ name: "attest-target", title: "Attest the target cluster", run: async () => undefined }],
  };
}

describe("streaming plan path runs the crypto gate (runGuards fix)", () => {
  const handles: DbHandle[] = [];
  const dirs: string[] = [];
  const logger = pino({ level: "silent" });
  const noSsh: SshFactory = () => Promise.reject(new Error("ssh must not be used during planning"));

  function make(mode = "plaintext"): { db: DbHandle; executor: Executor } {
    const dir = mkdtempSync(join(tmpdir(), "ctrl-sp-"));
    dirs.push(dir);
    const db = openDb(join(dir, "controller.db"));
    handles.push(db);
    db.sqlite.prepare("INSERT INTO servers (id, name, host, ssh_user, role) VALUES ('srv_r','r','2.2.2.2','root','slave')").run();
    db.sqlite.prepare("INSERT INTO clusters (id, server_id, stage, domain, tier) VALUES ('cls_real','srv_r','prod','r.example','real')").run();
    db.sqlite.prepare("INSERT INTO servers (id, name, host, ssh_user, role) VALUES ('srv_h','h','3.3.3.3','root','slave')").run();
    db.sqlite.prepare("INSERT INTO clusters (id, server_id, stage, domain, tier) VALUES ('cls_reh','srv_h','prod','h.example','rehearsal')").run();
    const store = new CredentialStore({ db: db.db, logger });
    // CredentialStore's constructor upserts keystore.mode=plaintext, so set the desired mode AFTER it.
    db.sqlite.prepare("UPDATE meta SET value=? WHERE key='keystore.mode'").run(mode);
    const runDefinitions = new Map<RunKind, AnyRunDefinition>([["create-tenant", streamingCreateTenantDef()]]);
    const executor = new Executor({ db: db.db, creds: store, bus: new RunEventBus(), logger, runDefinitions, sshFactory: noSsh, actor: () => "op_system" });
    return { db, executor };
  }
  afterEach(() => {
    for (const h of handles.splice(0)) h.sqlite.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  const runError = (db: DbHandle, runId: string): string =>
    (db.sqlite.prepare("SELECT error FROM runs WHERE id=?").get(runId) as { error: string | null }).error ?? "";

  it("refuses a streamed create-tenant onto a real cluster under plaintext — the gate now fires on the streaming path", async () => {
    const { db, executor } = make();
    const { runId } = await executor.planStreamed("create-tenant", { clusterId: "cls_real" });
    await executor.settle(runId);
    const run = getRun(db.db, runId);
    expect(run?.status).toBe("failed");
    expect(run?.steps).toHaveLength(0); // refused before any plan/steps were frozen
    expect(runError(db, runId)).toContain("keystore");
  });

  it("plans a streamed create-tenant onto a rehearsal cluster (gate open)", async () => {
    const { db, executor } = make();
    const { runId } = await executor.planStreamed("create-tenant", { clusterId: "cls_reh" });
    await executor.settle(runId);
    const run = getRun(db.db, runId);
    expect(run?.status).toBe("planned");
    expect(run?.steps.map((s) => s.name)).toEqual(["attest-target"]);
    expect(run?.targetKind).toBe("tenant");
  });

  it("plans a streamed create-tenant onto a real cluster once the store is no longer plaintext", async () => {
    const { db, executor } = make("passphrase");
    const { runId } = await executor.planStreamed("create-tenant", { clusterId: "cls_real" });
    await executor.settle(runId);
    expect(getRun(db.db, runId)?.status).toBe("planned");
  });
});
