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
import { servers } from "../../db/schema/inventory.ts";
import { seedRunRows } from "../../executor/run-rows.fixture.ts";
import { AuthFailedError, ExecFailedError, HostKeyMismatchError } from "../../adapters/ssh/port.ts";
import type { ExecOptions, ExecResult, SshFactory, SshSession, SshTarget } from "../../adapters/ssh/port.ts";
import type { Step, StepCtx } from "../../executor/types.ts";
import {
  enableNtpStep, generateKeyStep, installKeyStep, openDoor, proveElevationStep,
  removeSudoersStep, verifyKeyLoginStep, SUDOERS_DROP_IN,
} from "./defs/manager-key.kit.ts";

// The first-contact kit, measured on the two properties it is written for.
//
// WHICH DOOR IT OPENS. openDoor picks a credential from three facts — whether this manager holds a
// key, whether the machine took it, and whether the machine is the one whose host key is recorded —
// and the tests below drive each of the outcomes separately. The one that matters most is the
// NEGATIVE pair: a transport failure and a changed host key must NOT produce a password session, and
// each is asserted by what the ssh factory was asked to build rather than by what came back.
//
// WHAT IT WRITES ON A SECOND PASS. Every step is run twice against the same host, and the second
// pass must ship no write at all. The fake host records every command it was sent, so "wrote
// nothing" is read off the wire and not off a return value.

const logger = createLogger(
  parseConfig({
    PUBLIC_URL: "https://x.example", OIDC_ISSUER: "https://i.example/", OIDC_CLIENT_ID: "c",
    OIDC_CLIENT_SECRET: "s", MANAGER_VERSION: "test", DATA_DIR: "/data",
    ADMIN_SOCKET_PATH: "/run/manager/admin.sock", LOG_LEVEL: "silent",
  } as NodeJS.ProcessEnv),
);

const PASSWORD = "sesame-open-1234";
const SECRET = "ansiwise-elevation";
const SERVER_ID = "srv_key1";
const HOST_KEY = "SHA256:themachine";

/** What a machine already carrying this manager's key, a synchronised clock and no sudoers drop-in
 *  answers — the state a second pass of the list meets. */
interface FakeHost {
  authorizedKeys: string[];
  ntp: "yes" | "no";
  sudoersDropIn: boolean;
  /** Every command line the run really shipped, in order. */
  commands: string[];
}

function freshHost(): FakeHost {
  return { authorizedKeys: [], ntp: "no", sudoersDropIn: true, commands: [] };
}

/** A scripted machine: root reaches root, `id -u` answers the account, the authorized_keys file is
 *  real enough for grep and append to disagree, and the two elevated acts read and write the host's
 *  own state so a second pass can see what the first left. */
function hostSession(host: FakeHost, target: SshTarget): SshSession {
  const exec = async (command: string, o: ExecOptions): Promise<ExecResult> => {
    host.commands.push(command);
    const emit = (s: string): void => {
      for (const l of s.split("\n")) o.onStdout?.(l);
    };
    const ok = (out = ""): ExecResult => {
      if (out) emit(out);
      return { code: 0, stdoutTail: out, stderrTail: "" };
    };
    if (command === "id -u") return ok(target.username === "root" ? "0" : "1000");
    if (command === "sudo -S -p '' -- /usr/bin/id -u") return ok("0");
    if (command === "test -f ~/.ssh/authorized_keys") return host.authorizedKeys.length > 0 ? ok() : { code: 1, stdoutTail: "", stderrTail: "" };
    if (command.startsWith("grep -qF '")) {
      const line = /^grep -qF '([^']+)'/.exec(command)?.[1] ?? "";
      return host.authorizedKeys.includes(line) ? ok() : { code: 1, stdoutTail: "", stderrTail: "" };
    }
    if (command.startsWith("echo '") && command.includes(">> ~/.ssh/authorized_keys")) {
      const line = /^echo '([^']+)'/.exec(command)?.[1];
      if (line) host.authorizedKeys.push(line);
      return ok();
    }
    if (command === "timedatectl show -p NTP --value") return ok(host.ntp);
    if (command === "sudo -S -p '' timedatectl set-ntp true") {
      host.ntp = "yes";
      return ok();
    }
    if (command.includes("dc-remove-sudoers-")) {
      if (!host.sudoersDropIn) return ok("SUDOERS absent");
      host.sudoersDropIn = false;
      return ok("SUDOERS removed");
    }
    if (command.includes("dc-authorized-keys-probe-")) {
      return ok(["AKEYS readable", ...host.authorizedKeys.map((l) => `AKEY ${l}`)].join("\n"));
    }
    return ok();
  };
  return {
    hostKeyFingerprint: () => HOST_KEY,
    isClosed: () => false,
    close: () => undefined,
    putFile: async () => undefined,
    forwardLocalPort: async () => ({ localPort: 0, close: () => undefined }),
    openChannel: () => Promise.reject(new Error("no conversation in this fixture")),
    exec,
    mustExec: async (command: string, o: ExecOptions) => {
      const r = await exec(command, o);
      if (r.code !== 0) throw new ExecFailedError(r.code, r.stderrTail, command);
      return r;
    },
  } as unknown as SshSession;
}

describe("manager-key kit", () => {
  const handles: DbHandle[] = [];
  const dirs: string[] = [];
  afterEach(() => {
    for (const h of handles.splice(0)) h.sqlite.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  interface Bench {
    db: DbHandle;
    store: CredentialStore;
    rc: RunContext;
    ctx: (stepName: string) => StepCtx;
    /** Every target the factory was asked to build, so a test can assert which credential a step
     *  offered — including the credential it never offered at all. */
    asked: SshTarget[];
    host: FakeHost;
    meta: () => string[];
  }

  /** One manager, one machine, and an ssh factory whose KEY arm can be told to fail the way a
   *  particular machine fails. */
  function bench(opts: { keyFailure?: Error; sshUser?: string; host?: FakeHost } = {}): Bench {
    const dir = mkdtempSync(join(tmpdir(), "mgr-key-"));
    dirs.push(dir);
    const db = openDb(join(dir, "c.db"));
    handles.push(db);
    const store = new CredentialStore({ db: db.db, logger });
    db.db.insert(servers).values({
      id: SERVER_ID, name: "s5", host: "203.0.113.7", sshPort: 22, sshUser: opts.sshUser ?? "hostyour1",
      preflightJson: { hostKey: HOST_KEY },
    }).run();
    seedRunRows(db, {
      runId: "run_k",
      steps: ["prove-elevation", "generate-key", "install-key", "verify-key-login", "enable-ntp", "remove-sudoers"]
        .map((name, i) => ({ id: `step_${i}`, name })),
    });
    const secrets = new RunSecretsMap("run_k");
    secrets.set(SECRET, Buffer.from(PASSWORD));
    const asked: SshTarget[] = [];
    const host = opts.host ?? freshHost();
    // The run's own lines, taken off the bus rather than out of the events table: the events table
    // belongs to the executor and nothing in a domain may read it.
    const said: string[] = [];
    const bus = new RunEventBus();
    bus.subscribe("run_k", (e) => said.push(e.text));
    const sshFactory: SshFactory = (t) => {
      asked.push(t);
      if (t.auth.kind === "key" && opts.keyFailure) return Promise.reject(opts.keyFailure);
      return Promise.resolve(hostSession(host, t));
    };
    const rc = new RunContext({
      runId: "run_k", db: db.db, creds: store, bus, logger,
      params: { serverId: SERVER_ID }, secrets, signal: new AbortController().signal,
      sshFactory, targetServerId: SERVER_ID,
      declaredTargets: [{ serverId: SERVER_ID, ownsHost: true, label: "s5" }],
    });
    const ids = new Map(
      ["prove-elevation", "generate-key", "install-key", "verify-key-login", "enable-ntp", "remove-sudoers"]
        .map((name, i) => [name, `step_${i}`]),
    );
    return {
      db, store, rc, asked, host,
      ctx: (stepName) => rc.forStep(stepName, ids.get(stepName) ?? "step_0"),
      meta: () => said,
    };
  }

  async function sealKey(store: CredentialStore, publicKey = "ssh-ed25519 AAAAmanager hostyour:s5"): Promise<void> {
    await store.seal({
      kind: "ssh_key", label: "SSH key for s5", plaintext: Buffer.from("dummy"),
      fingerprint: "SHA256:managerkey", serverId: SERVER_ID, publicKey,
    });
  }

  describe("openDoor decides which credential is offered", () => {
    it("offers the password where this manager holds no key at all (first contact)", async () => {
      const b = bench();
      await openDoor(b.ctx("prove-elevation"), SECRET);
      expect(b.asked.map((t) => t.auth.kind)).toEqual(["password"]);
    });

    it("offers the key, and no password, where the machine takes it", async () => {
      const b = bench();
      await sealKey(b.store);
      await openDoor(b.ctx("prove-elevation"), SECRET);
      expect(b.asked.map((t) => t.auth.kind)).toEqual(["key"]);
    });

    it("falls back to the password when the MACHINE refuses the key", async () => {
      const b = bench({ keyFailure: new AuthFailedError("hostyour1", new Error("All configured authentication methods failed")) });
      await sealKey(b.store);
      await openDoor(b.ctx("prove-elevation"), SECRET);
      expect(b.asked.map((t) => t.auth.kind)).toEqual(["key", "password"]);
    });

    it("does NOT fall back on a transport failure — a host that answered nothing has proven nothing", async () => {
      const b = bench({ keyFailure: Object.assign(new Error("connect ECONNREFUSED 203.0.113.7:22"), { level: "client-socket" }) });
      await sealKey(b.store);
      await expect(openDoor(b.ctx("prove-elevation"), SECRET)).rejects.toThrow(/ECONNREFUSED/);
      expect(b.asked.map((t) => t.auth.kind)).toEqual(["key"]);
      expect(b.asked.some((t) => t.auth.kind === "password")).toBe(false);
    });

    it("refuses everything on a changed host key, and names both fingerprints", async () => {
      const b = bench({ keyFailure: new HostKeyMismatchError(HOST_KEY, "SHA256:stranger") });
      await sealKey(b.store);
      await expect(openDoor(b.ctx("prove-elevation"), SECRET)).rejects.toThrow(
        new RegExp(`${HOST_KEY}[\\s\\S]*SHA256:stranger`),
      );
      expect(b.asked.some((t) => t.auth.kind === "password")).toBe(false);
    });
  });

  describe("the steps measure before they act", () => {
    const list = (input: { serverId: string; secretName: string }): Step[] => [
      proveElevationStep(input), generateKeyStep(input), installKeyStep(input, { arm: true }),
      verifyKeyLoginStep(input), enableNtpStep(input), removeSudoersStep(input),
    ];

    async function runAll(b: Bench): Promise<void> {
      for (const step of list({ serverId: SERVER_ID, secretName: SECRET })) await step.run(b.ctx(step.name));
    }

    it("takes a machine from first contact to a key this manager holds, and stamps the row", async () => {
      const b = bench();
      await runAll(b);

      const held = await b.store.list({ serverId: SERVER_ID, kind: "ssh_key", excludeRotated: true });
      expect(held).toHaveLength(1);
      expect(b.host.authorizedKeys).toEqual([held[0]?.publicKey]);
      expect(b.host.ntp).toBe("yes");
      expect(b.host.sudoersDropIn).toBe(false);
      const row = b.db.db.select().from(servers).where(eq(servers.id, SERVER_ID)).get();
      expect(row?.adoptedAt).toBeInstanceOf(Date);
    });

    it("runs a second time against the same machine and ships not one write", async () => {
      const b = bench();
      await runAll(b);
      const key = (await b.store.list({ serverId: SERVER_ID, kind: "ssh_key", excludeRotated: true }))[0];

      b.host.commands.length = 0;
      const second = bench({ host: b.host });
      // The same manager state, re-seeded onto the second bench: the key it holds and the machine it
      // already put it on.
      await sealKey(second.store, key?.publicKey);
      await runAll(second);

      expect(b.host.authorizedKeys).toEqual([key?.publicKey]); // no second copy of the line
      expect((await second.store.list({ serverId: SERVER_ID, kind: "ssh_key", excludeRotated: true }))).toHaveLength(1);
      // Nothing that changes the machine was sent: no append, no set-ntp, and the drop-in script's
      // own measurement found the file already gone.
      expect(b.host.commands.filter((c) => c.includes(">> ~/.ssh/authorized_keys"))).toEqual([]);
      expect(b.host.commands.filter((c) => c.includes("set-ntp"))).toEqual([]);
      expect(second.meta().some((t) => t.includes(`carries no ${SUDOERS_DROP_IN}`))).toBe(true);
    });

    it("says in a full sentence why each step wrote nothing", async () => {
      const b = bench();
      await runAll(b);
      b.host.commands.length = 0;
      const second = bench({ host: b.host });
      const key = (await b.store.list({ serverId: SERVER_ID, kind: "ssh_key", excludeRotated: true }))[0];
      await sealKey(second.store, key?.publicKey);
      await runAll(second);

      const said = second.meta().join("\n");
      expect(said).toMatch(/already holds an unrotated key for s5[\s\S]*so no key is generated/);
      expect(said).toMatch(/already stands in ~\/\.ssh\/authorized_keys, so nothing is appended/);
      expect(said).toMatch(/already synchronises its clock, so nothing is written/);
      expect(said).toMatch(/there is nothing to take back and nothing was written/);
    });

    // WHAT AN ABORT MAY TAKE BACK, and the reason it is the step's own measurement that decides.
    // `remove-installed-key` deletes this manager's key line from the machine, and on a machine
    // whose password door a run already shut and whose sealed bootstrap password that run already
    // destroyed, that line is the last way in. So a run that found the line already standing — the
    // second deploy of the same machine — must arm nothing: what it would delete belongs to the run
    // before it.
    const KEY_LINE = "ssh-ed25519 AAAAmanager hostyour:s5";
    const input = { serverId: SERVER_ID, secretName: SECRET };

    it("arms the removal of the key line it appended", async () => {
      const b = bench();
      await sealKey(b.store, KEY_LINE);
      await installKeyStep(input, { arm: true }).run(b.ctx("install-key"));

      expect(b.host.authorizedKeys).toEqual([KEY_LINE]);
      expect(b.rc.registeredCleanups().map((c) => c.name)).toEqual(["remove-installed-key"]);
    });

    it("arms NOTHING where the line already stands — an abort of this run must not delete an earlier run's key", async () => {
      const b = bench({ host: { ...freshHost(), authorizedKeys: [KEY_LINE] } });
      await sealKey(b.store, KEY_LINE);
      await installKeyStep(input, { arm: true }).run(b.ctx("install-key"));

      expect(b.host.commands.filter((c) => c.includes(">> ~/.ssh/authorized_keys"))).toEqual([]);
      expect(b.rc.registeredCleanups()).toEqual([]);
      expect(b.meta().some((t) => t.includes("no removal of it is armed"))).toBe(true);
    });

    it("arms nothing on a definition that implements no such compensation, even where it appends", async () => {
      // The redeploy definition and the master arm both answer `arm: false`, and the executor
      // resolves a registered name against the definition's own cleanups() — so a step arming one
      // there would end an abort with a step that has no implementation.
      const b = bench();
      await sealKey(b.store, KEY_LINE);
      await installKeyStep(input, { arm: false }).run(b.ctx("install-key"));

      expect(b.host.authorizedKeys).toEqual([KEY_LINE]);
      expect(b.rc.registeredCleanups()).toEqual([]);
    });

    it("prove-elevation writes nothing on a machine whose login account IS root", async () => {
      const b = bench({ sshUser: "root" });
      await proveElevationStep({ serverId: SERVER_ID, secretName: SECRET }).run(b.ctx("prove-elevation"));
      expect(b.host.commands).toEqual(["id -u"]);
      expect(b.meta().some((t) => t.includes("is root itself, so there is nothing to raise"))).toBe(true);
    });
  });
});
