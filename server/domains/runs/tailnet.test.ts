import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { openDb, type DbHandle } from "../../db/client.ts";
import { createLogger } from "../../kernel/logger.ts";
import { parseConfig } from "../../kernel/config.ts";
import { CredentialStore } from "../../security/store.ts";
import { RunEventBus } from "../../executor/bus.ts";
import { RunContext } from "../../executor/context.ts";
import { RunSecretsMap } from "../../executor/secrets.ts";
import { ATTEST_TARGET_STEP } from "../../executor/guards.ts";
import { deriveServerLocks } from "../../executor/locks.ts";
import type { AnyRunDefinition, RunDefinition } from "../../executor/types.ts";
import { servers, clusters } from "../../db/schema/inventory.ts";
import { seedRunRows } from "../../executor/run-rows.fixture.ts";
import type { SshFactory, SshSession, SshTarget, ExecOptions, ExecResult } from "../../adapters/ssh/port.ts";
import { tailnetDisconnectDef, tailnetReconnectDef, tailnetRejoinDef, type TailnetParams } from "./defs/tailnet.ts";

// The proof this ticket can actually give, and it is about ADDRESS SELECTION, not connectivity:
// taking the tailnet down is not something a test can reach, but which address the three repair
// verbs resolve their target to is, and that is the property the whole ticket rests on. A verb
// whose purpose is to repair the private network may not travel over it, and may not travel over
// the LAN address either — the two addresses a run can otherwise be sent to.
//
// Driven through the REAL definitions: each plan is built, its own targets are handed to a
// RunContext, and every step is executed against a fake ssh factory that records the host of every
// session it is asked for. So what is measured is what the executor would dial.

const logger = createLogger(
  parseConfig({
    PUBLIC_URL: "https://x.example",
    OIDC_ISSUER: "https://i.example/",
    OIDC_CLIENT_ID: "c",
    OIDC_CLIENT_SECRET: "s",
    CONTROLLER_VERSION: "test",
    DATA_DIR: "/data",
    LOG_LEVEL: "silent",
  } as NodeJS.ProcessEnv),
);

const SLAVE_ID = "srv_s1";
const MASTER_ID = "srv_m1";
const PUBLIC_HOST = "203.0.113.7";
const LAN_HOST = "10.1.1.11";
/** The address the host holds on the private network. It lives in the tailnet READING and in no
 *  column any target builder reads — so no session may ever come out on it. */
const TAILNET_ADDRESS = "100.71.4.9";
const MASTER_LAN_HOST = "10.1.1.1";

const DEFS: Record<string, RunDefinition<TailnetParams>> = {
  "tailnet-disconnect": tailnetDisconnectDef,
  "tailnet-reconnect": tailnetReconnectDef,
  "tailnet-rejoin": tailnetRejoinDef,
};

/** A session that answers the two commands whose OUTPUT a step parses, and nothing else: the
 *  machine-id read that attest-target verifies, and the master-side mint whose one JSON blob the
 *  rejoin carries to the host. Every other command succeeds silently — none of them is what this
 *  file measures. */
function fakeSession(): SshSession {
  const exec = async (command: string, opts: ExecOptions): Promise<ExecResult> => {
    if (command.includes("/etc/machine-id")) opts.onStdout?.("2f8a1c9d4b7e40a1b2c3d4e5f6071829");
    if (command.includes("--tailnet-mint-join-key")) opts.onStdout?.('{"authkey":"tskey-auth-testtesttest"}');
    return { code: 0, stdoutTail: "", stderrTail: "" };
  };
  return {
    exec,
    mustExec: exec,
    putFile: async () => undefined,
    forwardLocalPort: async () => ({ localPort: 0, close: () => undefined }),
    hostKeyFingerprint: () => "SHA256:x",
    isClosed: () => false,
    close: () => undefined,
  } as unknown as SshSession;
}

describe("the tailnet repair verbs — which address they reach a host on", () => {
  const handles: DbHandle[] = [];
  const dirs: string[] = [];
  afterEach(() => {
    for (const h of handles.splice(0)) h.sqlite.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /** A live slave that carries BOTH addresses and a tailnet reading, plus the master a rejoin
   *  needs. Both addresses are present on purpose: a verb that resolved to the LAN one would look
   *  identical on a row that has only a public address. */
  async function setup(): Promise<{ db: DbHandle; store: CredentialStore }> {
    const dir = mkdtempSync(join(tmpdir(), "ctrl-tailnet-"));
    dirs.push(dir);
    const db = openDb(join(dir, "c.db"));
    handles.push(db);
    const store = new CredentialStore({ db: db.db, logger });
    db.db.insert(servers).values({
      id: SLAVE_ID, name: "s1", host: PUBLIC_HOST, lanHost: LAN_HOST, sshPort: 22, sshUser: "hostyour1",
      role: "slave", status: "healthy", tailnetState: "joined",
      tailnetJson: {
        v: 0, observedAt: 1, runId: "run_old", clientVersion: "1.80.2", backendState: "Running",
        address: TAILNET_ADDRESS, coordinator: "https://tailnet.example.com",
      },
    }).run();
    db.db.insert(servers).values({
      id: MASTER_ID, name: "m1", host: "198.51.100.4", lanHost: MASTER_LAN_HOST, sshPort: 22, sshUser: "hostyour",
      role: "master", status: "healthy",
      // The context refuses to open a session to the master without a recorded host key, so a
      // rejoin's master leg only reaches it on a row that carries the pin.
      preflightJson: { hostKey: "SHA256:x" },
    }).run();
    db.db.insert(clusters).values({
      id: "cls_1", serverId: SLAVE_ID, stage: "prod", domain: "s1.example.com", status: "active", slaveId: 1,
    }).run();
    for (const id of [SLAVE_ID, MASTER_ID]) {
      await store.seal({ kind: "ssh_key", label: `key ${id}`, plaintext: Buffer.from("dummy"), fingerprint: `SHA256:${id}`, serverId: id });
    }
    return { db, store };
  }

  /** Plan the verb, then run every one of its steps against the plan's OWN targets, collecting the
   *  host of each session the steps asked for. */
  async function runVerb(kind: string, db: DbHandle, store: CredentialStore): Promise<{ dialled: string[]; stepNames: string[] }> {
    const def = DEFS[kind];
    if (!def) throw new Error(`no definition for ${kind}`);
    const params: TailnetParams = { serverId: SLAVE_ID };
    const plan = await def.plan(params, { db: db.db });
    const runId = `run_${kind}`;
    const stepDefs = def.steps(params);
    seedRunRows(db, {
      runId, kind: def.kind, targetId: SLAVE_ID,
      steps: stepDefs.map((s, ordinal) => ({ id: `step_${kind}_${ordinal}`, name: s.name })),
    });
    const dialled: string[] = [];
    const sshFactory: SshFactory = (t: SshTarget) => {
      dialled.push(t.host);
      return Promise.resolve(fakeSession());
    };
    const rc = new RunContext({
      runId, db: db.db, creds: store, bus: new RunEventBus(), logger, params, secrets: new RunSecretsMap(runId),
      signal: new AbortController().signal, sshFactory, targetServerId: SLAVE_ID,
      declaredTargets: plan.targets ?? [],
    });
    for (const [ordinal, step] of stepDefs.entries()) {
      await step.run(rc.forStep(step.name, `step_${kind}_${ordinal}`));
    }
    rc.close();
    return { dialled, stepNames: stepDefs.map((s) => s.name) };
  }

  for (const kind of Object.keys(DEFS)) {
    it(`${kind} reaches the host on its PUBLIC address — never the tailnet one, never the LAN one`, async () => {
      const { db, store } = await setup();
      const { dialled } = await runVerb(kind, db, store);
      expect(dialled).toContain(PUBLIC_HOST);
      expect(dialled).not.toContain(TAILNET_ADDRESS);
      expect(dialled).not.toContain(LAN_HOST);
    });

    it(`${kind} states the public address on its own plan target, so the frozen plan records it`, async () => {
      const { db } = await setup();
      const plan = await DEFS[kind]!.plan({ serverId: SLAVE_ID }, { db: db.db });
      const host = plan.targets?.find((t) => t.serverId === SLAVE_ID);
      expect(host?.transport).toBe("public");
      expect(plan.summary).toContain(PUBLIC_HOST);
    });

    it(`${kind} owns the host it repairs, so it takes the same server lock every host verb takes`, async () => {
      const { db } = await setup();
      const plan = await DEFS[kind]!.plan({ serverId: SLAVE_ID }, { db: db.db });
      // Without this a repair could run its logout on a host a deploy-slave in flight was joining.
      // A run that has settled holds no lock at all (the executor releases them on every terminal
      // path), so the broken deploy these verbs exist for still cannot block them.
      expect(deriveServerLocks(plan.targets ?? [])).toEqual([{ resource: "server", key: SLAVE_ID }]);
      // The master is driven, not owned — only the host being repaired is claimed.
      expect(plan.targets?.filter((t) => t.ownsHost).map((t) => t.serverId)).toEqual([SLAVE_ID]);
      expect(plan.locks ?? []).toEqual([]);
    });

    it(`${kind} starts with ${ATTEST_TARGET_STEP} and ends by reading the membership back`, async () => {
      const { db, store } = await setup();
      const { stepNames } = await runVerb(kind, db, store);
      expect(stepNames[0]).toBe(ATTEST_TARGET_STEP);
      expect(stepNames.at(-1)).toBe("read-membership");
      // mutating ⇒ the executor refuses to let an operator skip that first step.
      expect((DEFS[kind] as AnyRunDefinition).mutating).toBe(true);
    });
  }

  it("a rejoin reaches the MASTER on its usual address — only the host being repaired moves", async () => {
    const { db, store } = await setup();
    const { dialled } = await runVerb("tailnet-rejoin", db, store);
    expect(dialled).toContain(MASTER_LAN_HOST);
    const plan = await tailnetRejoinDef.plan({ serverId: SLAVE_ID }, { db: db.db });
    expect(plan.targets?.find((t) => t.serverId === MASTER_ID)?.transport).toBeUndefined();
  });

  it("only a rejoin declares the master at all — the other two touch one host", async () => {
    const { db, store } = await setup();
    for (const kind of ["tailnet-disconnect", "tailnet-reconnect"]) {
      const plan = await DEFS[kind]!.plan({ serverId: SLAVE_ID }, { db: db.db });
      expect(plan.targets?.map((t) => t.serverId)).toEqual([SLAVE_ID]);
      const { dialled } = await runVerb(kind, db, store);
      expect(dialled).not.toContain(MASTER_LAN_HOST);
    }
  });

  it("writes the membership back through the one writer, so the card stops showing the old reading", async () => {
    const { db, store } = await setup();
    await runVerb("tailnet-disconnect", db, store);
    const row = db.db.select().from(servers).where(eq(servers.id, SLAVE_ID)).get();
    // The fake host answers the probe with nothing, which reads as a host carrying no client — the
    // point here is that the stale "joined" reading was replaced, whatever the new one says.
    expect(row?.tailnetState).toBe("no-client");
    expect((row?.tailnetJson as { runId?: string } | null)?.runId).toBe("run_tailnet-disconnect");
  });

  it("refuses the master: it runs the coordinator, so taking it off its own network is no repair", async () => {
    const { db } = await setup();
    for (const def of Object.values(DEFS)) {
      await expect(def.plan({ serverId: MASTER_ID }, { db: db.db })).rejects.toMatchObject({ code: "VALIDATION" });
    }
  });

  it("refuses a rejoin on a host with no live cluster — the credential is minted per slave", async () => {
    const { db } = await setup();
    db.db.update(clusters).set({ status: "planned" }).where(eq(clusters.id, "cls_1")).run();
    await expect(tailnetRejoinDef.plan({ serverId: SLAVE_ID }, { db: db.db })).rejects.toMatchObject({ code: "VALIDATION" });
    // The other two need no cluster at all: they drive the client on the host and nothing else.
    await expect(tailnetDisconnectDef.plan({ serverId: SLAVE_ID }, { db: db.db })).resolves.toBeTruthy();
    await expect(tailnetReconnectDef.plan({ serverId: SLAVE_ID }, { db: db.db })).resolves.toBeTruthy();
  });
});
