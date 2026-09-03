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
import { seedRunRows } from "./run-rows.fixture.ts";
import { createSshSession } from "../adapters/ssh/ssh2-session.ts";
import { startFakeSshServer, type FakeSshServer } from "../adapters/ssh/testing/fake-server.ts";
import { restateMachineIdentity } from "../domains/inventory/machine-identity.ts";
import type { StepCtx } from "./types.ts";

// THE PASSWORD DOOR, measured against a real sshd and a real client.
//
// The question this file exists for cannot be asked of a fake session, because it is a question
// about ORDER on the wire: does the connect refuse a changed host key BEFORE the client sends the
// operator's password, or after? Both orders end in a rejected promise and a session nobody gets, so
// a test that asserts only "the door is refused" is green either way — and in the second order the
// password is already on a machine this manager did not record.
//
// So the assertion is taken from the SERVER's side. startFakeSshServer records every authentication
// method that reached it (authMethodsSeen), and a method appears there only after key exchange has
// completed and the host key has been accepted. An empty record after a refused connect is therefore
// proof that the credential never left this side of the wire.
//
// The second test is what keeps the first from passing for the wrong reason: with the pin agreeing,
// the same password over the same client DOES reach the server and is recorded. A recorder that
// never records would make every "the password was not sent" assertion green.

const logger = createLogger(
  parseConfig({
    PUBLIC_URL: "https://x.example", OIDC_ISSUER: "https://i.example/", OIDC_CLIENT_ID: "c",
    OIDC_CLIENT_SECRET: "s", MANAGER_VERSION: "test", DATA_DIR: "/data",
    ADMIN_SOCKET_PATH: "/run/manager/admin.sock", LOG_LEVEL: "silent",
  } as NodeJS.ProcessEnv),
);

const PASSWORD = "sesame-open-1234";
const SECRET = "machine-password";
const SERVER_ID = "srv_door1";
/** A fingerprint of the right shape that belongs to no machine this suite starts. */
const STRANGER_PIN = "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

describe("the password door and the pinned host key", () => {
  const handles: DbHandle[] = [];
  const dirs: string[] = [];
  const running: FakeSshServer[] = [];
  const contexts: RunContext[] = [];
  afterEach(async () => {
    // The sessions go first: an ssh2 server does not finish closing while a connection it accepted
    // is still open, so a context left holding one would hang the teardown rather than fail a test.
    for (const rc of contexts.splice(0)) rc.close();
    for (const s of running.splice(0)) await s.close();
    for (const h of handles.splice(0)) h.sqlite.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /** One manager wired to a real in-process sshd through the real ssh2 adapter, with the server row
   *  carrying whatever host key this test wants pinned on it. */
  async function setup(pinned: string | undefined): Promise<{ db: DbHandle; ctx: StepCtx; srv: FakeSshServer }> {
    const srv = await startFakeSshServer({ acceptPassword: PASSWORD, execTable: { whoami: { stdout: "root\n", code: 0 } } });
    running.push(srv);
    const dir = mkdtempSync(join(tmpdir(), "mgr-door-"));
    dirs.push(dir);
    const db = openDb(join(dir, "c.db"));
    handles.push(db);
    db.db.insert(servers).values({
      id: SERVER_ID, name: "s5", host: "127.0.0.1", sshPort: srv.port, sshUser: "root",
      ...(pinned ? { preflightJson: { hostKey: pinned, checkedAt: 1 } } : {}),
    }).run();
    seedRunRows(db, { runId: "run_door", steps: [{ id: "step_1", name: "step-0" }] });
    const secrets = new RunSecretsMap("run_door");
    secrets.set(SECRET, Buffer.from(PASSWORD));
    const rc = new RunContext({
      runId: "run_door", db: db.db, creds: new CredentialStore({ db: db.db, logger }), bus: new RunEventBus(),
      logger, params: { serverId: SERVER_ID }, secrets, signal: new AbortController().signal,
      sshFactory: createSshSession, targetServerId: SERVER_ID,
      declaredTargets: [{ serverId: SERVER_ID, ownsHost: true, label: "s5" }],
    });
    contexts.push(rc);
    return { db, ctx: rc.forStep("attest-target", "step_1"), srv };
  }

  function pinOf(db: DbHandle): string | undefined {
    const row = db.db.select().from(servers).where(eq(servers.id, SERVER_ID)).get();
    return (row?.preflightJson as { hostKey?: string } | null)?.hostKey;
  }

  it("refuses a machine whose host key differs from the pin, and the password never reaches it", async () => {
    const { db, ctx, srv } = await setup(STRANGER_PIN);

    // The refusal is CAUGHT rather than asserted first, and the reason is the whole point of the
    // file: a door that refuses after the password has gone out refuses just as loudly as one that
    // refuses before, so an assertion about the error is not an assertion about the order. What
    // reached the machine is read first, and the error is judged afterwards.
    const refusal = await ctx.openPasswordSession(SECRET).then(() => undefined, (e: unknown) => e);

    // THE ASSERTION THIS FILE EXISTS FOR: nothing was offered. The refusal happened during key
    // exchange, so the machine never saw a credential of any kind — not the password, and not the
    // keyboard-interactive answer the adapter is prepared to give in its place.
    expect(srv.authMethodsSeen).toEqual([]);

    // The refusal names the two numbers that disagree and the act that settles them, because the
    // operator reading it is the only party that can tell a machine they rebuilt from one they did
    // not (domains/inventory/machine-identity.ts).
    expect((refusal as Error).message).toContain(STRANGER_PIN);
    expect((refusal as Error).message).toContain(srv.hostKeyFingerprint);
    expect((refusal as Error).message).toMatch(/rebuilt/);
    // And the row keeps the pin it had. A refused machine must never become the recorded one.
    expect(pinOf(db)).toBe(STRANGER_PIN);
  });

  it("offers the password where the pin agrees — which is what makes the assertion above mean something", async () => {
    const { db, ctx, srv } = await setup(undefined);
    // Pin the row on the machine the suite actually started, so the connect is a verification.
    db.db.update(servers).set({ preflightJson: { hostKey: srv.hostKeyFingerprint } }).where(eq(servers.id, SERVER_ID)).run();

    const session = await ctx.openPasswordSession(SECRET);
    expect(session.hostKeyFingerprint()).toBe(srv.hostKeyFingerprint);
    expect(srv.authMethodsSeen).toContain("password");
    // Verified, not rewritten: the pin the row carried is the pin it still carries.
    expect(pinOf(db)).toBe(srv.hostKeyFingerprint);
  });

  it("records the host key of a machine the row pins none for, and opens the door", async () => {
    const { db, ctx, srv } = await setup(undefined);

    const session = await ctx.openPasswordSession(SECRET);
    await session.mustExec("whoami", { signal: new AbortController().signal });

    expect(pinOf(db)).toBe(srv.hostKeyFingerprint);
    expect(srv.authMethodsSeen).toContain("password");
  });

  // THE WAY BACK FROM A MACHINE THAT WAS REBUILT, and the proof that it is a way back for that
  // machine only. The refusal above is what an operator meets after reinstalling a slave: the box is
  // theirs, it answers, and this manager offers it nothing. What moves the pin is a person stating
  // the fingerprint the machine presents now (domains/inventory/machine-identity.ts) — so the two
  // tests below are one act with the two statements a person can make, and only one of them opens
  // anything.
  it("opens the door on a machine a person stated the new host key for, and never before that", async () => {
    const { db, ctx, srv } = await setup(STRANGER_PIN);
    await ctx.openPasswordSession(SECRET).then(() => undefined, () => undefined);
    expect(srv.authMethodsSeen).toEqual([]);

    restateMachineIdentity(db.db, "op_test", SERVER_ID, { hostKeyFingerprint: srv.hostKeyFingerprint });

    const session = await ctx.openPasswordSession(SECRET);
    expect(session.hostKeyFingerprint()).toBe(srv.hostKeyFingerprint);
    expect(srv.authMethodsSeen).toContain("password");
    // Verified against the statement, not recorded off the connection: the pin is what the person
    // typed, and the machine matched it.
    expect(pinOf(db)).toBe(srv.hostKeyFingerprint);
  });

  it("goes on refusing a machine whose new host key is not the one stated, and the password stays here", async () => {
    const { db, ctx, srv } = await setup(STRANGER_PIN);
    // A statement of the right shape about a machine that is not the one answering. It is the same
    // act, made about the wrong machine — which is the case this manager cannot tell from the right
    // one and therefore leaves to the wire to settle.
    const OTHER_MACHINE = `SHA256:${"B".repeat(43)}`;
    restateMachineIdentity(db.db, "op_test", SERVER_ID, { hostKeyFingerprint: OTHER_MACHINE });

    const refusal = await ctx.openPasswordSession(SECRET).then(() => undefined, (e: unknown) => e);

    expect(srv.authMethodsSeen).toEqual([]);
    expect(pinOf(db)).toBe(OTHER_MACHINE);
    // The machine's own number is in the refusal, so the person who has to state it can read it off
    // the run rather than guess at what disagreed.
    expect((refusal as Error).message).toContain(srv.hostKeyFingerprint);
    expect((refusal as Error).message).toContain(OTHER_MACHINE);
  });
});
