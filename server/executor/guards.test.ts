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
  function fresh(): DbHandle {
    const dir = mkdtempSync(join(tmpdir(), "mgr-gd-"));
    dirs.push(dir);
    const h = openDb(join(dir, "manager.db"));
    handles.push(h);
    h.sqlite.prepare("INSERT INTO meta (key, value) VALUES ('keystore.mode', 'plaintext')").run();
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
    await expect(runGuards("cluster-deploy-slave", { tier: "rehearsal" }, { db })).resolves.toBeUndefined();
  });

  it("deploy-slave refused under plaintext when tier is real", async () => {
    const { db } = fresh();
    expect(await refused(() => runGuards("cluster-deploy-slave", { tier: "real" }, { db }))).toBe("PLAN_REFUSED");
  });

  /** A slave whose deployment finished: a cluster row AND the cluster-admin bearer this manager
   *  sealed off it, which is the thing a plaintext keystore would expose. */
  function seedDeployedSlave(sqlite: DbHandle["sqlite"], id: string, name: string, role = "slave"): void {
    sqlite.prepare("INSERT INTO servers (id, name, host, ssh_user, role) VALUES (?,?,?,'root',?)").run(id, name, `2.2.2.${id.length}`, role);
    sqlite.prepare("INSERT INTO clusters (id, server_id, stage, domain, status) VALUES (?,?,'prod',?,'active')")
      .run(`cls_${id}`, id, `${name}.example`);
    sqlite.prepare("INSERT INTO credentials (id, kind, label, server_id, encrypted_blob, fingerprint) VALUES (?,?,?,?,?,?)")
      .run(`cred_${id}`, "kubeconfig", `${name} cluster bearer (argocd-manager)`, id, "plain:v0:t", "sha256:t");
  }

  it("deploy-slave refused under plaintext once this manager stores ANOTHER machine's cluster key", async () => {
    const { db, sqlite } = fresh();
    seedDeployedSlave(sqlite, "srv_e", "s5");
    expect(await refused(() => runGuards("cluster-deploy-slave", { tier: "rehearsal", serverId: "srv_new" }, { db }))).toBe("PLAN_REFUSED");
  });

  it("a cluster row a stopped deployment left behind refuses nothing — no key was harvested off it", async () => {
    // Step 1 of a deployment inserts the cluster row and onTerminal parks it back; a run that died
    // anywhere before create-mgmt therefore leaves a row and no credential. Counting the row would
    // refuse every plan on this installation, the failed machine's own retry first of all — and
    // finishing a half-finished run by running it again is what every step of it is written for.
    const { db, sqlite } = fresh();
    for (const [i, status] of ["planned", "provisioning"].entries()) {
      sqlite.prepare("INSERT INTO servers (id, name, host, ssh_user, role) VALUES (?,?,?,'root','slave')").run(`srv_h${i}`, `h${i}`, `2.2.2.${i}`);
      sqlite.prepare("INSERT INTO clusters (id, server_id, stage, domain, status) VALUES (?,?,'prod',?,?)")
        .run(`cls_h${i}`, `srv_h${i}`, `h${i}.example`, status);
    }
    await expect(runGuards("cluster-deploy-slave", { tier: "rehearsal", serverId: "srv_h0" }, { db })).resolves.toBeUndefined();
  });

  it("does not count the run's OWN target: deploying a machine whose key is already stored adds none", async () => {
    // sealTokenOnce reuses or rotates the row it finds, so a second deployment of that same machine
    // puts no second key into the store — and refusing it would leave a slave that got as far as
    // create-mgmt with no way to be finished.
    const { db, sqlite } = fresh();
    seedDeployedSlave(sqlite, "srv_e", "s5");
    await expect(runGuards("cluster-deploy-slave", { tier: "rehearsal", serverId: "srv_e" }, { db })).resolves.toBeUndefined();
  });

  it("does not count a machine carrying the MASTER part: nothing is harvested off one", async () => {
    // A cluster carrying the master part is reached over the manager pod's own ServiceAccount, so a
    // credential row against such a server is not a cluster access key of the kind this gate counts.
    const { db, sqlite } = fresh();
    seedDeployedSlave(sqlite, "srv_m", "m1", "master+slave");
    await expect(runGuards("cluster-deploy-slave", { tier: "rehearsal", serverId: "srv_new" }, { db })).resolves.toBeUndefined();
  });

  it("does not gate the MASTER ARM: the machine taking the slave part stores no cluster key at all", async () => {
    // cluster-deploy-slave has two arms and the target's role picks them. Aimed at the master, it
    // regenerates that machine's own branch and composes no create-mgmt, so nothing is harvested and
    // nothing is sealed — while a slave deployed earlier has already put its bearer in the store,
    // which is what the count below would refuse the act on.
    const { db, sqlite } = fresh();
    seedDeployedSlave(sqlite, "srv_e", "s5");
    sqlite.prepare("INSERT INTO servers (id, name, host, ssh_user, role) VALUES ('srv_m','m1','1.1.1.1','root','master')").run();
    sqlite.prepare("INSERT INTO clusters (id, server_id, stage, domain, status) VALUES ('cls_m','srv_m','prod','m1.example','active')").run();
    await expect(runGuards("cluster-deploy-slave", { tier: "rehearsal", serverId: "srv_m" }, { db })).resolves.toBeUndefined();
    // And the TIER says nothing about an act that harvests no key either: a real installation's own
    // control host takes the slave part on the same reasoning.
    await expect(runGuards("cluster-deploy-slave", { tier: "real", serverId: "srv_m" }, { db })).resolves.toBeUndefined();
    // The exemption is the ROLE and not the id: the same plan aimed at a slave is refused.
    expect(await refused(() => runGuards("cluster-deploy-slave", { tier: "rehearsal", serverId: "srv_new" }, { db }))).toBe("PLAN_REFUSED");
  });

  it("the gate is open once the store is no longer plaintext", async () => {
    const { db, sqlite } = fresh();
    sqlite.prepare("UPDATE meta SET value='passphrase' WHERE key='keystore.mode'").run();
    seedDeployedSlave(sqlite, "srv_e", "s5");
    await expect(runGuards("cluster-deploy-slave", { tier: "real", serverId: "srv_new" }, { db })).resolves.toBeUndefined();
  });

  it("onboard refused onto a real cluster under plaintext, allowed onto rehearsal", async () => {
    const { db, sqlite } = fresh();
    sqlite.prepare("INSERT INTO servers (id, name, host, ssh_user, role) VALUES ('srv_e','slave-r','2.2.2.2','root','slave')").run();
    sqlite.prepare("INSERT INTO clusters (id, server_id, stage, domain, tier) VALUES ('cls_r','srv_e','prod','a.example','real')").run();
    sqlite.prepare("INSERT INTO servers (id, name, host, ssh_user, role) VALUES ('srv_f','slave-h','3.3.3.3','root','slave')").run();
    sqlite.prepare("INSERT INTO clusters (id, server_id, stage, domain, tier) VALUES ('cls_h','srv_f','prod','b.example','rehearsal')").run();
    expect(await refused(() => runGuards("consumer-onboard", { clusterId: "cls_r" }, { db }))).toBe("PLAN_REFUSED");
    await expect(runGuards("consumer-onboard", { clusterId: "cls_h" }, { db })).resolves.toBeUndefined();
  });

  it("create-tenant / add-app are crypto-gated like onboard: refused onto a real cluster, allowed onto rehearsal", async () => {
    const { db, sqlite } = fresh();
    sqlite.prepare("INSERT INTO servers (id, name, host, ssh_user, role) VALUES ('srv_e','slave-r','2.2.2.2','root','slave')").run();
    sqlite.prepare("INSERT INTO clusters (id, server_id, stage, domain, tier) VALUES ('cls_r','srv_e','prod','a.example','real')").run();
    sqlite.prepare("INSERT INTO servers (id, name, host, ssh_user, role) VALUES ('srv_f','slave-h','3.3.3.3','root','slave')").run();
    sqlite.prepare("INSERT INTO clusters (id, server_id, stage, domain, tier) VALUES ('cls_h','srv_f','prod','b.example','rehearsal')").run();
    expect(await refused(() => runGuards("tenant-create", { clusterId: "cls_r" }, { db }))).toBe("PLAN_REFUSED");
    await expect(runGuards("tenant-create", { clusterId: "cls_h" }, { db })).resolves.toBeUndefined();
    // add-app resolves clusterId from its tenant during the plan; the same gate applies to that resolved id.
    expect(await refused(() => runGuards("tenant-add-app", { clusterId: "cls_r" }, { db }))).toBe("PLAN_REFUSED");
    await expect(runGuards("tenant-add-app", { clusterId: "cls_h" }, { db })).resolves.toBeUndefined();
  });

  it("create-tenant / add-app gates are open once the store is no longer plaintext", async () => {
    const { db, sqlite } = fresh();
    sqlite.prepare("UPDATE meta SET value='passphrase' WHERE key='keystore.mode'").run();
    sqlite.prepare("INSERT INTO servers (id, name, host, ssh_user, role) VALUES ('srv_e','slave-r','2.2.2.2','root','slave')").run();
    sqlite.prepare("INSERT INTO clusters (id, server_id, stage, domain, tier) VALUES ('cls_r','srv_e','prod','a.example','real')").run();
    await expect(runGuards("tenant-create", { clusterId: "cls_r" }, { db })).resolves.toBeUndefined();
    await expect(runGuards("tenant-add-app", { clusterId: "cls_r" }, { db })).resolves.toBeUndefined();
  });

  it("tenant-create + tenant-add-app are armed and the four tenant-lifecycle kinds carry no guards", async () => {
    const { db } = fresh();
    expect(KIND_GUARDS["tenant-create"]).not.toHaveLength(0);
    expect(KIND_GUARDS["tenant-add-app"]).not.toHaveLength(0);
    for (const kind of ["tenant-remove-app", "tenant-suspend", "tenant-resume", "tenant-offboard"] as const) {
      expect(KIND_GUARDS[kind]).toHaveLength(0);
      await expect(runGuards(kind, { clusterId: "cls_r" }, { db })).resolves.toBeUndefined();
    }
  });

  it("cluster-redeploy carries no crypto gate: it acts on a cluster that is already live", async () => {
    const { db } = fresh();
    expect(KIND_GUARDS["cluster-redeploy"]).toHaveLength(0);
    await expect(runGuards("cluster-redeploy", { serverId: "srv_x" }, { db })).resolves.toBeUndefined();
  });

  it("assertGuardsArmed rejects a runDefinitions once tenant-create's gate is disarmed", () => {
    // Guard against a future edit silently emptying KIND_GUARDS["tenant-create"]: temporarily blank
    // it and confirm the boot self-check now fails on tenant-create (it is in the armed set).
    const original = KIND_GUARDS["tenant-create"];
    (KIND_GUARDS as Record<RunKind, readonly unknown[]>)["tenant-create"] = [];
    try {
      expect(() => assertGuardsArmed(new Map())).toThrow(/tenant-create/);
    } finally {
      (KIND_GUARDS as Record<RunKind, readonly unknown[]>)["tenant-create"] = original;
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

describe("streaming plan path runs the crypto gate (runGuards fix)", () => {
  const handles: DbHandle[] = [];
  const dirs: string[] = [];
  const logger = pino({ level: "silent" });
  const noSsh: SshFactory = () => Promise.reject(new Error("ssh must not be used during planning"));

  function make(mode = "plaintext"): { db: DbHandle; executor: Executor } {
    const dir = mkdtempSync(join(tmpdir(), "mgr-sp-"));
    dirs.push(dir);
    const db = openDb(join(dir, "manager.db"));
    handles.push(db);
    db.sqlite.prepare("INSERT INTO servers (id, name, host, ssh_user, role) VALUES ('srv_r','r','2.2.2.2','root','slave')").run();
    db.sqlite.prepare("INSERT INTO clusters (id, server_id, stage, domain, tier) VALUES ('cls_real','srv_r','prod','r.example','real')").run();
    db.sqlite.prepare("INSERT INTO servers (id, name, host, ssh_user, role) VALUES ('srv_h','h','3.3.3.3','root','slave')").run();
    db.sqlite.prepare("INSERT INTO clusters (id, server_id, stage, domain, tier) VALUES ('cls_reh','srv_h','prod','h.example','rehearsal')").run();
    const store = new CredentialStore({ db: db.db, logger });
    // CredentialStore's constructor upserts keystore.mode=plaintext, so set the desired mode AFTER it.
    db.sqlite.prepare("UPDATE meta SET value=? WHERE key='keystore.mode'").run(mode);
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

  it("refuses a streamed create-tenant onto a real cluster under plaintext — the gate now fires on the streaming path", async () => {
    const { db, executor } = make();
    const { runId } = await executor.planStreamed("tenant-create", { clusterId: "cls_real" });
    await executor.settle(runId);
    const run = getRun(db.db, runId);
    expect(run?.status).toBe("failed");
    expect(run?.steps).toHaveLength(0); // refused before any plan/steps were frozen
    expect(runError(db, runId)).toContain("keystore");
  });

  it("plans a streamed create-tenant onto a rehearsal cluster (gate open)", async () => {
    const { db, executor } = make();
    const { runId } = await executor.planStreamed("tenant-create", { clusterId: "cls_reh" });
    await executor.settle(runId);
    const run = getRun(db.db, runId);
    expect(run?.status).toBe("planned");
    expect(run?.steps.map((s) => s.name)).toEqual(["attest-target"]);
    expect(run?.targetKind).toBe("tenant");
  });

  it("plans a streamed create-tenant onto a real cluster once the store is no longer plaintext", async () => {
    const { db, executor } = make("passphrase");
    const { runId } = await executor.planStreamed("tenant-create", { clusterId: "cls_real" });
    await executor.settle(runId);
    expect(getRun(db.db, runId)?.status).toBe("planned");
  });
});
