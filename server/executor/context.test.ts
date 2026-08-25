import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { openDb, type DbHandle } from "../db/client.ts";
import { createLogger } from "../kernel/logger.ts";
import { parseConfig } from "../kernel/config.ts";
import { CredentialStore } from "../security/store.ts";
import { RunEventBus } from "./bus.ts";
import { RunContext } from "./context.ts";
import { RunSecretsMap } from "./secrets.ts";
import { servers } from "../db/schema/inventory.ts";
import { events } from "../db/schema/runs.ts";
import { seedRunRows } from "./run-rows.fixture.ts";
import type { SshFactory, SshTarget, SshSession } from "../adapters/ssh/port.ts";

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

function fakeSession(fp = "SHA256:abc", closed = false): SshSession {
  return {
    exec: async () => ({ code: 0, stdoutTail: "", stderrTail: "" }),
    mustExec: async () => ({ code: 0, stdoutTail: "", stderrTail: "" }),
    putFile: async () => undefined,
    forwardLocalPort: async () => ({ localPort: 0, close: () => undefined }),
    hostKeyFingerprint: () => fp,
    isClosed: () => closed,
    close: () => undefined,
  } as unknown as SshSession;
}

describe("RunContext — adopt password ceremony", () => {
  const handles: DbHandle[] = [];
  const dirs: string[] = [];
  afterEach(() => {
    for (const h of handles.splice(0)) h.sqlite.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function setup(runId: string): { db: DbHandle; store: CredentialStore; bus: RunEventBus; serverId: string } {
    const dir = mkdtempSync(join(tmpdir(), "mgr-ctx-"));
    dirs.push(dir);
    const db = openDb(join(dir, "c.db"));
    handles.push(db);
    const store = new CredentialStore({ db: db.db, logger });
    const bus = new RunEventBus();
    const serverId = "srv_test1";
    db.db.insert(servers).values({ id: serverId, name: "s5", host: "203.0.113.7", sshPort: 22, sshUser: "root" }).run();
    seedRunRows(db, { runId, steps: [{ id: "step_1", name: "step-0" }] });
    return { db, store, bus, serverId };
  }

  it("opens a password session, pins the host key TOFU, and caches it", async () => {
    const { db, store, bus, serverId } = setup("run_x");
    const secrets = new RunSecretsMap("run_x");
    secrets.set("adopt-password", Buffer.from("sesame"));
    let target: SshTarget | undefined;
    const session = fakeSession("SHA256:xyz");
    const sshFactory: SshFactory = (t) => {
      target = t;
      return Promise.resolve(session);
    };
    const rc = new RunContext({
      runId: "run_x", db: db.db, creds: store, bus, logger, params: {}, secrets,
      signal: new AbortController().signal, sshFactory, targetServerId: serverId,
      declaredTargets: [{ serverId, ownsHost: true, label: "s5" }],
    });
    const ctx = rc.forStep("connect-password", "step_1");

    const s1 = await ctx.openPasswordSession();
    expect(target?.host).toBe("203.0.113.7");
    expect(target?.username).toBe("root");
    expect(target?.auth.kind).toBe("password");

    const row = db.db.select().from(servers).where(eq(servers.id, serverId)).get();
    expect((row?.preflightJson as { hostKey?: string } | null)?.hostKey).toBe("SHA256:xyz");

    const s2 = await ctx.openPasswordSession();
    expect(s2).toBe(s1); // cached — no reconnect
  });

  it("throws MissingRunSecret when the adopt password is gone (the state after a crash/restart)", async () => {
    const { db, store, bus, serverId } = setup("run_y");
    const secrets = new RunSecretsMap("run_y"); // password never set
    const sshFactory: SshFactory = () => Promise.resolve(fakeSession());
    const rc = new RunContext({
      runId: "run_y", db: db.db, creds: store, bus, logger, params: {}, secrets,
      signal: new AbortController().signal, sshFactory, targetServerId: serverId,
      declaredTargets: [{ serverId, ownsHost: true, label: "s5" }],
    });
    const ctx = rc.forStep("connect-password", "step_1");
    await expect(ctx.openPasswordSession()).rejects.toMatchObject({ code: "MISSING_RUN_SECRET" });
  });
});

describe("RunContext — multi-target SSH cache (one session per target host and address)", () => {
  const handles: DbHandle[] = [];
  const dirs: string[] = [];
  afterEach(() => {
    for (const h of handles.splice(0)) h.sqlite.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  // A key-auth session tagged with the host it connected to, recording its own close(). Neither
  // target below states a transport, so each resolves to its own row's address and distinct hosts
  // give distinct sessions.
  function trackingFactory(closed: string[]): SshFactory {
    return (t: SshTarget) =>
      Promise.resolve({
        exec: async () => ({ code: 0, stdoutTail: "", stderrTail: "" }),
        mustExec: async () => ({ code: 0, stdoutTail: "", stderrTail: "" }),
        putFile: async () => undefined,
        forwardLocalPort: async () => ({ localPort: 0, close: () => undefined }),
        hostKeyFingerprint: () => "SHA256:x",
        isClosed: () => false,
        close: () => closed.push(t.host),
      } as unknown as SshSession);
  }

  // Two adopted servers (slave = primary/owns-host, master = aux), each with an installed key.
  async function setup(
    closed: string[],
  ): Promise<{ rc: RunContext; slaveId: string; masterId: string }> {
    const dir = mkdtempSync(join(tmpdir(), "mgr-multi-"));
    dirs.push(dir);
    const db = openDb(join(dir, "c.db"));
    handles.push(db);
    const store = new CredentialStore({ db: db.db, logger });
    seedRunRows(db, { runId: "run_z", steps: [{ id: "step_1", name: "step-0" }] });
    const slaveId = "srv_slave";
    const masterId = "srv_master";
    db.db.insert(servers).values({ id: slaveId, name: "s1", host: "10.1.1.11", sshPort: 22, sshUser: "root" }).run();
    db.db.insert(servers).values({ id: masterId, name: "m1", host: "10.1.1.1", sshPort: 22, sshUser: "root" }).run();
    for (const [id, fp] of [[slaveId, "SHA256:slave"], [masterId, "SHA256:master"]] as const) {
      await store.seal({ kind: "ssh_key", label: `key ${id}`, plaintext: Buffer.from("dummy"), fingerprint: fp, serverId: id });
    }
    const rc = new RunContext({
      runId: "run_z", db: db.db, creds: store, bus: new RunEventBus(), logger, params: {},
      secrets: new RunSecretsMap("run_z"), signal: new AbortController().signal,
      sshFactory: trackingFactory(closed), targetServerId: slaveId,
      declaredTargets: [
        { serverId: slaveId, ownsHost: true, label: "s1" },
        { serverId: masterId, ownsHost: false, label: "m1" },
      ],
    });
    return { rc, slaveId, masterId };
  }

  it("returns a DISTINCT, stable session per declared target", async () => {
    const { rc, slaveId, masterId } = await setup([]);
    const ctx = rc.forStep("create-mgmt", "step_1");
    const slave1 = await ctx.ssh(slaveId);
    const master1 = await ctx.ssh(masterId);
    expect(slave1).not.toBe(master1); // two hosts ⇒ two sessions, not one shared cache
    expect(await ctx.ssh(slaveId)).toBe(slave1); // stable on repeat
    expect(await ctx.ssh(masterId)).toBe(master1);
  });

  it("ctx.ssh() with no arg resolves to the primary (owns-host) target", async () => {
    const { rc, slaveId } = await setup([]);
    const ctx = rc.forStep("slave-preflight", "step_1");
    const primary = await ctx.ssh();
    expect(await ctx.ssh(slaveId)).toBe(primary); // undefined === the declared primary
  });

  it("refuses a serverId the plan did not declare (errUndeclaredTarget)", async () => {
    const { rc } = await setup([]);
    const ctx = rc.forStep("create-mgmt", "step_1");
    await expect(ctx.ssh("srv_stranger")).rejects.toMatchObject({ code: "UNDECLARED_TARGET" });
  });

  it("close() closes EVERY cached session", async () => {
    const closed: string[] = [];
    const { rc, slaveId, masterId } = await setup(closed);
    const ctx = rc.forStep("create-mgmt", "step_1");
    await ctx.ssh(slaveId);
    await ctx.ssh(masterId);
    expect(closed).toEqual([]); // nothing closed while open
    rc.close();
    expect(closed.sort()).toEqual(["10.1.1.1", "10.1.1.11"]); // both hosts closed
  });
});

// The seam the tailnet repair run kinds rest on: WHICH of a server's two addresses a session opens on
// is the plan's to state, and the cache is keyed on the address that was actually taken. Measured
// here on the RunContext, because the property is about address selection, not about connectivity —
// taking a network down is not something a test can reach.
describe("RunContext — which address a session opens on", () => {
  const handles: DbHandle[] = [];
  const dirs: string[] = [];
  afterEach(() => {
    for (const h of handles.splice(0)) h.sqlite.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  const PUBLIC_HOST = "203.0.113.7";
  const LAN_HOST = "10.1.1.11";
  /** The address the host holds on the private network. It lives in the tailnet READING and in no
   *  column any target builder reads, so no session may ever come out on it. */
  const TAILNET_ADDRESS = "100.71.4.9";

  async function setup(): Promise<{ db: DbHandle; store: CredentialStore; serverId: string; dialled: string[] }> {
    const dir = mkdtempSync(join(tmpdir(), "mgr-transport-"));
    dirs.push(dir);
    const db = openDb(join(dir, "c.db"));
    handles.push(db);
    const store = new CredentialStore({ db: db.db, logger });
    const serverId = "srv_s1";
    db.db.insert(servers).values({
      id: serverId, name: "s1", host: PUBLIC_HOST, lanHost: LAN_HOST, sshPort: 22, sshUser: "hostyour1",
      tailnetState: "joined",
      tailnetJson: {
        v: 0, observedAt: 1, runId: "run_old", clientVersion: "1.80.2", backendState: "Running",
        address: TAILNET_ADDRESS, coordinator: "https://tailnet.example.com",
      },
    }).run();
    await store.seal({ kind: "ssh_key", label: "key", plaintext: Buffer.from("dummy"), fingerprint: "SHA256:k", serverId });
    seedRunRows(db, { runId: "run_t", steps: [{ id: "step_1", name: "one" }, { id: "step_2", name: "two" }, { id: "step_3", name: "three" }] });
    return { db, store, serverId, dialled: [] };
  }

  function context(
    db: DbHandle, store: CredentialStore, serverId: string, dialled: string[], transport?: "default" | "public",
  ): RunContext {
    return new RunContext({
      runId: "run_t", db: db.db, creds: store, bus: new RunEventBus(), logger, params: {},
      secrets: new RunSecretsMap("run_t"), signal: new AbortController().signal,
      sshFactory: (t: SshTarget) => {
        dialled.push(t.host);
        return Promise.resolve(fakeSession());
      },
      targetServerId: serverId,
      declaredTargets: [{ serverId, ownsHost: false, label: "s1", ...(transport ? { transport } : {}) }],
    });
  }

  it("a target that asks for the public address gets it — never the LAN one, never the tailnet one", async () => {
    const { db, store, serverId, dialled } = await setup();
    const ctx = context(db, store, serverId, dialled, "public").forStep("disconnect", "step_1");
    await ctx.ssh();
    expect(dialled).toEqual([PUBLIC_HOST]);
    expect(dialled).not.toContain(LAN_HOST);
    expect(dialled).not.toContain(TAILNET_ADDRESS);
  });

  it("a target that states no transport keeps the behaviour every run has always had (lanHost ?? host)", async () => {
    const { db, store, serverId, dialled } = await setup();
    const ctx = context(db, store, serverId, dialled).forStep("preflight", "step_1");
    await ctx.ssh();
    expect(dialled).toEqual([LAN_HOST]);
  });

  it("falls back to the public address for a row that carries no LAN one, and says so in the log", async () => {
    const { db, store, serverId, dialled } = await setup();
    db.db.update(servers).set({ lanHost: null }).where(eq(servers.id, serverId)).run();
    const rc = context(db, store, serverId, dialled);
    await rc.forStep("preflight", "step_1").ssh();
    expect(dialled).toEqual([PUBLIC_HOST]);
    const logged = db.db.select().from(events).all().map((e) => e.text);
    expect(logged.some((t) => t.includes(`hostyour1@${PUBLIC_HOST}:22`) && t.includes("public address"))).toBe(true);
  });

  it("drops a session whose transport died and reopens on the SAME address, saying so", async () => {
    const { db, store, serverId, dialled } = await setup();
    // A session that reports its transport gone — what the adapter records after the keepalives go
    // unanswered, which is what a command that takes the host's networking down produces.
    const dead = fakeSession("SHA256:abc", true);
    const alive = fakeSession();
    const opened: SshSession[] = [dead, alive];
    const rc = new RunContext({
      runId: "run_t", db: db.db, creds: store, bus: new RunEventBus(), logger, params: {},
      secrets: new RunSecretsMap("run_t"), signal: new AbortController().signal,
      sshFactory: (t: SshTarget) => {
        dialled.push(t.host);
        return Promise.resolve(opened.shift() ?? alive);
      },
      targetServerId: serverId,
      declaredTargets: [{ serverId, ownsHost: false, label: "s1", transport: "public" }],
    });
    expect(await rc.forStep("one", "step_1").ssh()).toBe(dead);
    expect(await rc.forStep("two", "step_2").ssh()).toBe(alive);
    expect(dialled).toEqual([PUBLIC_HOST, PUBLIC_HOST]); // reopened on the address the plan states
    const logged = db.db.select().from(events).all().map((e) => e.text);
    expect(logged.some((t) => t.includes("is gone — opening a new one"))).toBe(true);
  });

  it("does not hand out a session that was opened on the OTHER address", async () => {
    const { db, store, serverId, dialled } = await setup();
    const rc = context(db, store, serverId, dialled);
    const first = await rc.forStep("one", "step_1").ssh();
    expect(dialled).toEqual([LAN_HOST]);
    // The same server, resolving to the other address: the cache is keyed on the address the
    // session went out on, so this opens a NEW one instead of returning the LAN session.
    db.db.update(servers).set({ lanHost: null }).where(eq(servers.id, serverId)).run();
    const second = await rc.forStep("two", "step_2").ssh();
    expect(second).not.toBe(first);
    expect(dialled).toEqual([LAN_HOST, PUBLIC_HOST]);
    // And each of the two stays cached under its own address.
    expect(await rc.forStep("three", "step_3").ssh()).toBe(second);
    expect(dialled).toEqual([LAN_HOST, PUBLIC_HOST]);
  });
});
