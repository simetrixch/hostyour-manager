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
import { seedRunRows } from "../../executor/run-rows.fixture.ts";
import type { AnyRunDefinition, Cleanup, RunDefinition } from "../../executor/types.ts";
import { servers } from "../../db/schema/inventory.ts";
import { serverCredFlags } from "../inventory/write.ts";
import { readServerPasswordLogin } from "../../../shared/password-login.ts";
import type { SshFactory, SshSession, ExecOptions, ExecResult } from "../../adapters/ssh/port.ts";
import { ANSIWISE_ELEVATION_SECRET } from "./defs/ansiwise-run.kit.ts";
import { passwordLoginDisableDef, passwordLoginEnableDef, type PasswordLoginParams } from "./defs/password-login.ts";
import { ALREADY_SHUT, restorePasswordLoginCleanup, type PasswordLoginKind } from "./defs/password-login.kit.ts";

// What a test can and cannot prove about this ticket, stated plainly because the difference is the
// whole point of it.
//
// It CANNOT prove that a host stops taking passwords. That needs a host, an sshd and a second
// login attempt, and the run's own read-back through `sshd -T` is what does it there.
//
// It CAN prove the SHAPE of the act, and the shape is where the previous attempt failed: a file
// called `99-disable-passwords.conf` saying `PasswordAuthentication no` sat on the one host that
// exists for three weeks and did nothing, because `50-cloud-init.conf` stated the keyword first and
// sshd takes the FIRST occurrence. So what is asserted below is exactly the shape that was wrong:
// the drop-in this run writes SORTS FIRST, the configuration is VALIDATED before anything is
// reloaded, the reload is a reload and not a restart, the file goes back unless the daemon both
// accepted it and re-read it, the verdict is read back out of the DAEMON and never off the file
// just written, the key door is proven open — and proven ENOUGH, against
// `AuthenticationMethods` — before the password door shuts, and a compensation is registered so an
// abort does not leave a host nobody can reach.
//
// The scripts are read as the bytes the run SHIPS: the fake session records every putFile, so what
// is measured is what the host would receive.

const logger = createLogger(
  parseConfig({
    PUBLIC_URL: "https://x.example",
    OIDC_ISSUER: "https://i.example/",
    OIDC_CLIENT_ID: "c",
    OIDC_CLIENT_SECRET: "s",
    MANAGER_VERSION: "test",
    DATA_DIR: "/data",
    ADMIN_SOCKET_PATH: "/run/manager/admin.sock",
    LOG_LEVEL: "silent",
  } as NodeJS.ProcessEnv),
);

const SLAVE_ID = "srv_s1";
const MASTER_ID = "srv_m1";
const BOOTSTRAP_FP = "bootstrap-password";
/** What an operator types on the approve card: the machine account's password, which raises every
 *  script these run kinds ship to a host. */
const MACHINE_PASSWORD = "open-sesame";

// Keyed on PasswordLoginKind, not on string: a run kind renamed in shared/enums.ts must break THIS
// file rather than leave the table testing two keys the enum no longer has.
const DEFS: Record<PasswordLoginKind, RunDefinition<PasswordLoginParams>> = {
  "cluster-password-login-disable": passwordLoginDisableDef,
  "cluster-password-login-enable": passwordLoginEnableDef,
};

/** What `sshd -T` says on a host that still takes a password — the state of the one host measured
 *  so far, and the state every freshly installed cloud image is in. */
const TAKES_PASSWORD = ["SSHD effective readable", "SSHD password yes", "SSHD keyboard yes", "SSHD pubkey yes"].join("\n");
/** What it says once the door is shut. Both keywords, because PAM serves passwords through
 *  keyboard-interactive as well. */
const KEY_ONLY = ["SSHD effective readable", "SSHD password no", "SSHD keyboard no", "SSHD pubkey yes"].join("\n");
/** A daemon that would not print its effective configuration at all. */
const UNREADABLE = "SSHD effective unreadable";

interface Recorded {
  /** Every script the run uploaded, by the name remoteScript/remoteScriptCapture gave it. */
  scripts: Map<string, string>;
  commands: string[];
}

/** A session that records the bytes of every script shipped to it and answers the reads a step
 *  parses: the machine-id attest-target verifies, the password-login probe, and whatever the act
 *  script itself prints. Every command succeeds — this file measures what is SENT, not what a host
 *  would do with it. */
function fakeSession(rec: Recorded, probe: () => string, actOut = ""): SshSession {
  const exec = async (command: string, opts: ExecOptions): Promise<ExecResult> => {
    rec.commands.push(command);
    if (command.includes("/etc/machine-id")) opts.onStdout?.("2f8a1c9d4b7e40a1b2c3d4e5f6071829");
    if (command.includes("dc-password-login-probe-")) for (const l of probe().split("\n")) opts.onStdout?.(l);
    if (actOut && command.includes("dc-cluster-password-login-")) for (const l of actOut.split("\n")) opts.onStdout?.(l);
    return { code: 0, stdoutTail: "", stderrTail: "" };
  };
  return {
    exec,
    mustExec: exec,
    putFile: async (path: string, content: Buffer) => {
      const name = /dc-([a-z-]+)-run_/.exec(path)?.[1];
      if (name) rec.scripts.set(name, content.toString("utf8"));
    },
    forwardLocalPort: async () => ({ localPort: 0, close: () => undefined }),
    hostKeyFingerprint: () => "SHA256:x",
    isClosed: () => false,
    close: () => undefined,
  } as unknown as SshSession;
}

/** Assert every marker is present in `script` and in the order given. One helper, because ORDER is
 *  the property under test in three different places: validate before reload, prove the key door
 *  before shutting the password door, read the daemon back after the reload. */
function expectInOrder(script: string, markers: readonly string[]): void {
  const at = markers.map((m) => script.indexOf(m));
  for (const [i, index] of at.entries()) {
    expect(index, `marker not found: ${markers[i]}`).toBeGreaterThanOrEqual(0);
    if (i > 0) expect(index, `${markers[i]} must come after ${markers[i - 1]}`).toBeGreaterThan(at[i - 1] as number);
  }
}

describe("the password-login run kinds — the shape of an act that cannot be tested against a host", () => {
  const handles: DbHandle[] = [];
  const dirs: string[] = [];
  afterEach(() => {
    for (const h of handles.splice(0)) h.sqlite.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /** An adopted slave with a key and a stored bootstrap password — the second door — plus the
   *  master, which these run kinds may target like any other internet-facing machine. */
  async function setup(): Promise<{ db: DbHandle; store: CredentialStore }> {
    const dir = mkdtempSync(join(tmpdir(), "mgr-pwlogin-"));
    dirs.push(dir);
    const db = openDb(join(dir, "c.db"));
    handles.push(db);
    const store = new CredentialStore({ db: db.db, logger });
    db.db.insert(servers).values({
      id: SLAVE_ID, name: "s1", host: "203.0.113.7", lanHost: "10.1.1.11", sshPort: 22, sshUser: "hostyour1",
      role: "slave", status: "healthy", adoptedAt: new Date(1), preflightJson: { hostKey: "SHA256:x" },
    }).run();
    db.db.insert(servers).values({
      // No adoptedAt: seed-master registers the master at boot and never adopts it.
      id: MASTER_ID, name: "m1", host: "198.51.100.4", sshPort: 22, sshUser: "hostyour",
      role: "master", status: "healthy", preflightJson: { hostKey: "SHA256:x" },
    }).run();
    for (const id of [SLAVE_ID, MASTER_ID]) {
      await store.seal({ kind: "ssh_key", label: `key ${id}`, plaintext: Buffer.from("dummy"), fingerprint: `SHA256:${id}`, serverId: id });
    }
    await store.seal({
      kind: "other", label: "adopt password for s1", plaintext: Buffer.from("sesame"),
      fingerprint: BOOTSTRAP_FP, serverId: SLAVE_ID,
    });
    return { db, store };
  }

  /** Plan the run kind, then run every one of its steps against the plan's own targets, collecting the
   *  scripts it shipped and the cleanups it registered. */
  async function runOfKind(
    kind: PasswordLoginKind,
    db: DbHandle,
    store: CredentialStore,
    probe: () => string = () => TAKES_PASSWORD,
    serverId = SLAVE_ID,
    actOut = "",
  ): Promise<{ rec: Recorded; cleanups: string[]; stepNames: string[] }> {
    const def = DEFS[kind];
    if (!def) throw new Error(`no definition for ${kind}`);
    const params: PasswordLoginParams = { serverId };
    const plan = await def.plan(params, { db: db.db });
    const runId = `run_${kind}`;
    const stepDefs = def.steps(params);
    seedRunRows(db, {
      runId, kind: def.kind, targetId: serverId,
      steps: stepDefs.map((s, ordinal) => ({ id: `step_${kind}_${ordinal}`, name: s.name })),
    });
    const rec: Recorded = { scripts: new Map(), commands: [] };
    const sshFactory: SshFactory = () => Promise.resolve(fakeSession(rec, probe, actOut));
    // The one secret both run kinds declare: every script they ship is raised whole with it, because
    // a machine this platform deployed grants this manager no standing passwordless-root rule.
    const secrets = new RunSecretsMap(runId);
    secrets.set(ANSIWISE_ELEVATION_SECRET, Buffer.from(MACHINE_PASSWORD, "utf8"));
    const rc = new RunContext({
      runId, db: db.db, creds: store, bus: new RunEventBus(), logger, params, secrets,
      signal: new AbortController().signal, sshFactory, targetServerId: serverId,
      declaredTargets: plan.targets ?? [],
    });
    for (const [ordinal, step] of stepDefs.entries()) {
      await step.run(rc.forStep(step.name, `step_${kind}_${ordinal}`));
    }
    rc.close();
    return { rec, cleanups: rc.registeredCleanups().map((c) => c.name), stepNames: stepDefs.map((s) => s.name) };
  }

  it("writes ONE drop-in and it sorts FIRST — a 99- file is the bug, not the fix", async () => {
    const { db, store } = await setup();
    const { rec } = await runOfKind("cluster-password-login-disable", db, store);
    const script = rec.scripts.get("cluster-password-login-disable") ?? "";
    expect(script).toContain("/etc/ssh/sshd_config.d/00-hostyour-passwords.conf");
    // Nothing this run writes may sort after cloud-init's file, which states the keyword `yes`.
    expect(script).not.toMatch(/sshd_config\.d\/[1-9]\d?-/);
    // One file, in one place: the path appears only as this platform's own drop-in.
    expect([...script.matchAll(/sshd_config\.d\/00-hostyour-passwords\.conf/g)].length).toBeGreaterThan(0);
  });

  it("states BOTH keywords, because keyboard-interactive is the same door through PAM", async () => {
    const { db, store } = await setup();
    const { rec } = await runOfKind("cluster-password-login-disable", db, store);
    const script = rec.scripts.get("cluster-password-login-disable") ?? "";
    expect(script).toContain("PasswordAuthentication no");
    expect(script).toContain("KbdInteractiveAuthentication no");
  });

  it("validates BEFORE it reloads, and reloads rather than restarts", async () => {
    const { db, store } = await setup();
    const { rec } = await runOfKind("cluster-password-login-disable", db, store);
    const script = rec.scripts.get("cluster-password-login-disable") ?? "";
    // `sshd -t` refuses a configuration the daemon could not start on; the reload is the moment a
    // bad drop-in would otherwise take sshd down.
    expectInOrder(script, ['-t; then', "if ! reload_sshd"]);
    // A restart drops every established session, including this run's own and the operator's.
    expect(script).not.toContain("systemctl restart");
    // A configuration that does not validate is put back before anything is reloaded.
    expect(script).toContain("NOTHING was reloaded");
  });

  it("puts the drop-in back when the daemon could not be told to re-read it", async () => {
    const { db, store } = await setup();
    const { rec } = await runOfKind("cluster-password-login-disable", db, store);
    const script = rec.scripts.get("cluster-password-login-disable") ?? "";
    // `sshd -T` parses the FILES and has no channel to the running process, so a valid drop-in the
    // daemon never read would be reported by the very next reading as a shut door. Both failure
    // paths therefore end in put_back, and neither leaves the file stating more than the daemon
    // resolved.
    expect([...script.matchAll(/put_back "\$prev"/g)].length).toBe(2);
    expect(script).toContain("a reading of the new one would claim a door the daemon still opens");
    // Ubuntu 24.04 runs sshd from ssh.socket: ssh.service is inactive and no sshd unit exists, so
    // both reloads fail while nothing is wrong — every connection starts its own daemon.
    expectInOrder(script, ["systemctl reload ssh ", "systemctl reload sshd", "is-active --quiet ssh.socket"]);
  });

  it("refuses a host whose AuthenticationMethods still names a password method, before writing", async () => {
    const { db, store } = await setup();
    const { rec } = await runOfKind("cluster-password-login-disable", db, store);
    const script = rec.scripts.get("cluster-password-login-disable") ?? "";
    // A host with `publickey,keyboard-interactive` — the usual PAM two-factor setup — has one
    // method list, and turning both keywords off leaves sshd nothing it can complete. `sshd -t`
    // accepts the file and the read-back agrees with it: the contradiction only shows at the next
    // login, by which time nobody can log in. So the check runs on the reading taken BEFORE the act.
    expect(script).toContain("authenticationmethods");
    expectInOrder(script, ["survives_without_passwords ||", "| apply no"]);
    expect(script).toContain("NOTHING was written");
    // "any" is sshd's own word for its default, and the one value that needs no reasoning.
    expect(script).toContain('[ "$methods" = "any" ]');
    for (const method of ["password", "keyboard-interactive"]) expect(script).toContain(`${method}|${method}:*`);
  });

  it("reads keyboard-interactive under BOTH names sshd prints it by", async () => {
    const { db, store } = await setup();
    const { rec } = await runOfKind("cluster-password-login-disable", db, store);
    const script = rec.scripts.get("cluster-password-login-disable") ?? "";
    // OpenSSH 8.7 renamed the dumped keyword. On 8.6 and earlier — Ubuntu 20.04 is 8.2, which the
    // preflight only warns about — only `challengeresponseauthentication` is printed, and reading
    // the new name alone would call a door that did shut still open.
    expect(script).toContain('$1 == "kbdinteractiveauthentication" || $1 == "challengeresponseauthentication"');
  });

  it("proves the KEY door is open before it shuts the password door", async () => {
    const { db, store } = await setup();
    const { rec, stepNames } = await runOfKind("cluster-password-login-disable", db, store);
    // Its own step in the plan, so the operator sees the order before approving.
    expect(stepNames.indexOf("verify-key-login")).toBeLessThan(stepNames.indexOf("disable-password-login"));
    const script = rec.scripts.get("cluster-password-login-disable") ?? "";
    // And again inside the act, against the daemon: reading the row's `hasKey` would prove only
    // that a key was once installed, not that sshd still accepts one.
    expectInOrder(script, ['[ "$pubkey" = "yes" ]', "| apply no"]);
    // The key door is checked again after the reload — a drop-in that turned it off would leave a
    // machine that answers nobody.
    expect([...script.matchAll(/\[ "\$pubkey" = "yes" \]/g)].length).toBe(2);
  });

  it("takes its verdict from the DAEMON after the reload, never from the file it just wrote", async () => {
    const { db, store } = await setup();
    const { rec } = await runOfKind("cluster-password-login-disable", db, store);
    const script = rec.scripts.get("cluster-password-login-disable") ?? "";
    // read_effective is `sshd -T` and nothing else (password-login-probe.ts SSHD_HELPERS), and the
    // assertion on the result comes after the write. A grep of the drop-in would have passed on the
    // one host that carried a `99-` file for three weeks.
    expect(script).toContain('effective() { as_root "$(sshd_bin)" -T; }');
    expectInOrder(script, ["| apply no", "cannot be read after the reload", "the daemon still takes a password after the reload"]);
    // The other files are named so a disagreement is visible, and never edited.
    expect(script).toContain("files stating either keyword, in the order sshd reads them");
    expect(script).not.toContain("50-cloud-init");
  });

  it("registers the compensation unless it MEASURED the door already shut", async () => {
    for (const [probe, expected] of [
      [TAKES_PASSWORD, ["restore-password-login"]],
      [UNREADABLE, ["restore-password-login"]], // an unmeasured door is not a shut one
      [KEY_ONLY, []],
    ] as const) {
      const { db, store } = await setup();
      const { cleanups } = await runOfKind("cluster-password-login-disable", db, store, () => probe);
      expect(cleanups).toEqual(expected);
    }
  });

  /** Every script this kit ships is run by `bash /tmp/dc-<name>-<runId>.sh`; the removal afterwards
   *  names the same path and is not one. */
  const shippedScriptRuns = (rec: Recorded): string[] => rec.commands.filter((c) => /(^|\s)bash \/tmp\/dc-/.test(c));

  for (const kind of Object.keys(DEFS) as PasswordLoginKind[]) {
    it(`${kind} raises every script it ships with the run's own password`, async () => {
      // The deployment takes the standing passwordless-root grant off the machine
      // (defs/manager-key.kit.ts remove-sudoers), so `sshd -T`, the write, the validation and the
      // reload have exactly one route to root left: `sudo -S` with the password the run carries.
      // Raised WHOLE, because the first sudo of a send consumes the password.
      const { db, store } = await setup();
      const { rec } = await runOfKind(kind, db, store);
      const shipped = shippedScriptRuns(rec);
      expect(shipped.length).toBeGreaterThan(0);
      for (const c of shipped) expect(c, c).toMatch(/^sudo -S -p '' bash \/tmp\/dc-/);
    });
  }

  it("shuts the door with the SAME password it proved reaches root, one step earlier", async () => {
    const { db, store } = await setup();
    const { rec, stepNames } = await runOfKind("cluster-password-login-disable", db, store);
    // verify-key-login asks sudo one question with that password before the act writes anything: a
    // password that does not reach root would otherwise be met inside a script that has already
    // written a file.
    expect(stepNames.indexOf("verify-key-login")).toBeLessThan(stepNames.indexOf("disable-password-login"));
    expect(rec.commands).toContain("sudo -S -p '' -- /usr/bin/true");
  });

  it("writes nothing and reloads nothing on a host that already answers what the drop-in states", async () => {
    // The same list runs against a machine it has already taken through — a redeploy re-runs it on a
    // live slave — so the act measures first and says what it found. Reloading the sshd of a running
    // machine for a state just measured as correct is the write this guard takes away.
    const { db, store } = await setup();
    const { rec, cleanups } = await runOfKind(
      "cluster-password-login-disable", db, store, () => KEY_ONLY, SLAVE_ID, `${ALREADY_SHUT}: nothing was written`,
    );
    const script = rec.scripts.get("cluster-password-login-disable") ?? "";
    // BOTH facts decide it: the daemon takes neither keyword, and this platform's own drop-in is
    // what says so — a door shut by somebody else's file is one the next cloud-init rewrite reopens.
    expectInOrder(script, ['[ "$pw" = "no" ] && [ "$kbd" = "no" ]', ALREADY_SHUT, "| apply no"]);
    expect(script).toContain(`[ "$(as_root cat "/etc/ssh/sshd_config.d/00-hostyour-passwords.conf"`);
    // One probe, not two: the second reading exists to replace a row describing a host the act
    // changed, and this act changed none.
    expect(shippedScriptRuns(rec).filter((c) => c.includes("dc-password-login-probe-")).length).toBe(1);
    expect(cleanups).toEqual([]);
  });

  /** Run one compensating action the way an abort does: its own step row, the same store, the same
   *  fake host — and the secrets an abort was handed, which is what decides whether it can reach
   *  root at all. */
  async function runCleanup(
    db: DbHandle, store: CredentialStore, cleanup: Cleanup, secrets: Record<string, string>,
  ): Promise<Recorded> {
    const runId = "run_abort";
    seedRunRows(db, { runId, kind: "cluster-password-login-disable", targetId: SLAVE_ID, steps: [{ id: "step_c0", name: cleanup.name }] });
    const rec: Recorded = { scripts: new Map(), commands: [] };
    const map = new RunSecretsMap(runId);
    for (const [name, value] of Object.entries(secrets)) map.set(name, Buffer.from(value, "utf8"));
    const rc = new RunContext({
      runId, db: db.db, creds: store, bus: new RunEventBus(), logger, params: { serverId: SLAVE_ID }, secrets: map,
      signal: new AbortController().signal, sshFactory: () => Promise.resolve(fakeSession(rec, () => TAKES_PASSWORD)),
      targetServerId: SLAVE_ID, declaredTargets: [{ serverId: SLAVE_ID, ownsHost: true, label: "s1" }],
    });
    try {
      await cleanup.run(rc.forStep(cleanup.name, "step_c0"));
    } finally {
      rc.close();
    }
    return rec;
  }

  it("puts the door back over the SAME route the act took — the compensation is raised too", async () => {
    // An abort of a first install has to leave the machine as reachable as it was found, and the
    // machine grants this manager nothing standing: a compensation reaching root any other way
    // would be a route the run itself does not have, so it would fail on its own first command and
    // take every compensation behind it down with it.
    const { db, store } = await setup();
    const rec = await runCleanup(db, store, restorePasswordLoginCleanup(ANSIWISE_ELEVATION_SECRET), { [ANSIWISE_ELEVATION_SECRET]: MACHINE_PASSWORD });
    const shipped = shippedScriptRuns(rec);
    expect(shipped.length).toBeGreaterThan(0);
    for (const c of shipped) expect(c, c).toMatch(/^sudo -S -p '' bash \/tmp\/dc-/);
    expect(rec.scripts.get("cluster-password-login-enable")).toContain("PasswordAuthentication yes");
  });

  it("refuses the compensation BY NAME when the password is gone, rather than part way through a file", async () => {
    // Run secrets are never stored, so an abort after a restart has none until the operator enters
    // it again. Saying which one is missing is what tells them that.
    const { db, store } = await setup();
    await expect(runCleanup(db, store, restorePasswordLoginCleanup(ANSIWISE_ELEVATION_SECRET), {}))
      .rejects.toMatchObject({ code: "MISSING_RUN_SECRET" });
  });

  it("names its compensation in cleanups(), so an abort can resolve the persisted name", async () => {
    // The executor resolves a run's registered names against def.cleanups(); a name it cannot
    // resolve gets a row with no implementation behind it.
    expect(passwordLoginDisableDef.cleanups?.({ serverId: SLAVE_ID }).map((c) => c.name)).toEqual(["restore-password-login"]);
    // The enable run kind registers none: opening a door cannot lock anybody out.
    expect(passwordLoginEnableDef.cleanups).toBeUndefined();
  });

  it("destroys the SECOND door — the bootstrap password sealed beside the server row", async () => {
    const { db, store } = await setup();
    expect((await serverCredFlags(store)).get(SLAVE_ID)?.hasPassword).toBe(true);
    await runOfKind("cluster-password-login-disable", db, store);
    // Purged, not revoked: a revoked row keeps the encrypted blob, and the blob IS the password.
    expect((await serverCredFlags(store)).get(SLAVE_ID)?.hasPassword).toBe(false);
    expect((await store.list({ serverId: SLAVE_ID, kind: "other" }))).toHaveLength(0);
    // The key it was replaced by is untouched.
    expect(await store.list({ serverId: SLAVE_ID, kind: "ssh_key" })).toHaveLength(1);
  });

  it("writes the reading back on the row, so the card stops showing the state before the change", async () => {
    const { db, store } = await setup();
    let call = 0;
    // Before the act the daemon takes a password; after it, it does not.
    await runOfKind("cluster-password-login-disable", db, store, () => (call++ === 0 ? TAKES_PASSWORD : KEY_ONLY));
    const row = db.db.select().from(servers).where(eq(servers.id, SLAVE_ID)).get();
    expect(row?.passwordLoginState).toBe("off");
    const read = readServerPasswordLogin(row?.passwordLoginJson);
    expect(read.kind).toBe("v0");
    if (read.kind === "v0") {
      expect(read.facts.runId).toBe("run_cluster-password-login-disable");
      expect(read.facts.passwordAuthentication).toBe("no");
      expect(read.facts.kbdInteractiveAuthentication).toBe("no");
      expect(read.facts.pubkeyAuthentication).toBe("yes");
    }
  });

  it("the enable run kind opens the same one file, validates the same way, and arms nothing", async () => {
    const { db, store } = await setup();
    const { rec, cleanups, stepNames } = await runOfKind("cluster-password-login-enable", db, store, () => KEY_ONLY);
    const script = rec.scripts.get("cluster-password-login-enable") ?? "";
    expect(script).toContain("/etc/ssh/sshd_config.d/00-hostyour-passwords.conf");
    expect(script).toContain("PasswordAuthentication yes");
    expectInOrder(script, ['-t; then', "if ! reload_sshd", "cannot be read after the reload", '[ "$pw" = "yes" ]']);
    expect(cleanups).toEqual([]);
    // No key-login proof and no second door: this run seals no password, it only reopens the daemon.
    expect(stepNames).toEqual([ATTEST_TARGET_STEP, "enable-password-login"]);
  });

  for (const kind of Object.keys(DEFS) as PasswordLoginKind[]) {
    it(`${kind} starts with ${ATTEST_TARGET_STEP} and owns its host`, async () => {
      const { db, store } = await setup();
      const { stepNames } = await runOfKind(kind, db, store);
      expect(stepNames[0]).toBe(ATTEST_TARGET_STEP);
      // mutating ⇒ the executor refuses to let an operator skip that first step: a run that
      // changes which credentials a machine accepts proves first which machine it is talking to.
      expect((DEFS[kind] as AnyRunDefinition).mutating).toBe(true);
      const plan = await DEFS[kind].plan({ serverId: SLAVE_ID }, { db: db.db });
      // Without the lock this could shut the password door on a machine an adopt in flight is
      // still using a password on.
      expect(deriveServerLocks(plan.targets ?? [])).toEqual([{ resource: "server", key: SLAVE_ID }]);
      // Reading and writing an sshd configuration are root acts and the machine carries no standing
      // rule for either, so the run asks for the password that raises every script it ships.
      expect(plan.requiredSecrets).toEqual([ANSIWISE_ELEVATION_SECRET]);
    });

    it(`${kind} refuses a host no ssh_key credential stands for — there would be nothing to fall back on`, async () => {
      const { db, store } = await setup();
      for (const c of await store.list({ serverId: SLAVE_ID, kind: "ssh_key" })) await store.purge(c.id);
      // The row is untouched and still says `healthy`, which is where a deployment leaves every
      // machine it reached: what refuses is the credential, and it is the same fact ctx.ssh() would
      // look for at the run's first step.
      expect(db.db.select().from(servers).where(eq(servers.id, SLAVE_ID)).get()?.status).toBe("healthy");
      await expect(DEFS[kind].plan({ serverId: SLAVE_ID }, { db: db.db })).rejects.toMatchObject({ code: "VALIDATION" });
    });

    it(`${kind} accepts a host whose row says 'bare' while a key stands for it`, async () => {
      // A deployment writes `provisioning` before it opens a session and parks the row when the run
      // ends, so no status says which credentials this manager holds. A machine whose key was
      // installed by a run that then died elsewhere is reachable, and these run kinds are how its
      // doors are put right.
      const { db } = await setup();
      db.db.update(servers).set({ status: "bare" }).where(eq(servers.id, SLAVE_ID)).run();
      await expect(DEFS[kind].plan({ serverId: SLAVE_ID }, { db: db.db })).resolves.toBeTruthy();
    });

    it(`${kind} accepts the MASTER — it is an internet-facing machine with an sshd like any other`, async () => {
      const { db, store } = await setup();
      // The master carries no adoptedAt at all: it is never adopted, it self-registers at boot
      // (server/boot/seed-master.ts). Keying the refusal on that column would have locked these
      // run kinds out of the one host whose password door was actually measured.
      expect(db.db.select().from(servers).where(eq(servers.id, MASTER_ID)).get()?.adoptedAt).toBeNull();
      await expect(DEFS[kind].plan({ serverId: MASTER_ID }, { db: db.db })).resolves.toBeTruthy();
      const { stepNames } = await runOfKind(kind, db, store, () => TAKES_PASSWORD, MASTER_ID);
      expect(stepNames[0]).toBe(ATTEST_TARGET_STEP);
    });
  }
});
