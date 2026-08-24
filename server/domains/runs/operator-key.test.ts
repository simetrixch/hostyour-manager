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
import type { AnyRunDefinition } from "../../executor/types.ts";
import { servers } from "../../db/schema/inventory.ts";
import { createOperatorKey } from "../inventory/operator-keys.ts";
import { managerKeyMarker, operatorKeyMarker, readServerAuthorizedKeys } from "../../../shared/operator-keys.ts";
import { fingerprintPublicKey } from "../../security/fingerprint.ts";
import type { SshFactory, SshSession, ExecOptions, ExecResult } from "../../adapters/ssh/port.ts";
import { authorizedKeysReadDef, operatorKeyPlaceDef, operatorKeyRemoveDef } from "./defs/operator-key.ts";

// What a test can and cannot prove about these run kinds, stated plainly because the difference is the
// whole point of them.
//
// It CANNOT prove that a human can then log in, or that a removed key stops working. That needs a
// host, an sshd and a second login attempt from outside.
//
// It CAN prove the SHAPE of the act, and the shape is the entire safety property. The one failure
// that would matter is an edit that takes THIS MANAGER's own key out of the file it is editing —
// the platform would lose its way into the machine and nothing could put it back. So what is
// asserted below is exactly that: the filter deletes by a marker the manager's own line cannot
// carry, the pattern is anchored so one operator's label cannot reach another's, a grep that FAILED
// to read is never treated as a file with nothing in it, the arithmetic is checked before anything
// is written, and every verdict is taken from reading the file back rather than from the exit code
// of the edit.
//
// The scripts are read as the bytes the run SHIPS: the fake session records every putFile, so what
// is measured is what a host would receive.

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

const SLAVE_ID = "srv_s1";
const MASTER_ID = "srv_m1";

const BLOB_MINE = "AAAAC3NzaC1lZDI1NTE5AAAAIManagerOwnKeyAAAAAAAAAAAAAAAAAAAAAAAA";
const BLOB_PAT = "AAAAC3NzaC1lZDI1NTE5AAAAIOperatorPatKeyAAAAAAAAAAAAAAAAAAAAAAAAAA";
const BLOB_HETZ = "AAAAC3NzaC1lZDI1NTE5AAAAICloudImageKeyAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const PAT_KEY = `ssh-ed25519 ${BLOB_PAT}`;
const PAT_FP = fingerprintPublicKey(PAT_KEY);
const MINE_FP = fingerprintPublicKey(`ssh-ed25519 ${BLOB_MINE}`);

/** The line adopt leaves on a host — the one no act here may ever touch. */
const MANAGER_LINE = `ssh-ed25519 ${BLOB_MINE} ${managerKeyMarker("s1")}`;
/** A key the cloud image shipped with: nothing here placed it, and nothing here can remove it. */
const FOREIGN_LINE = `ssh-ed25519 ${BLOB_HETZ} someone@example.com`;
const PAT_LINE = `${PAT_KEY} ${operatorKeyMarker("pat")}`;

interface Recorded {
  scripts: Map<string, string>;
  commands: string[];
}

/** A session that records the bytes of every script shipped to it and answers the two reads a step
 *  parses: the machine-id attest-target verifies, and the authorized-keys probe — whose answer the
 *  test drives, so the file can differ before and after the act. */
function fakeSession(rec: Recorded, file: () => string[] | null, probeFails = false): SshSession {
  const exec = async (command: string, opts: ExecOptions): Promise<ExecResult> => {
    rec.commands.push(command);
    if (command.includes("/etc/machine-id")) opts.onStdout?.("2f8a1c9d4b7e40a1b2c3d4e5f6071829");
    if (command.includes("dc-authorized-keys-probe-")) {
      // A probe that did not RUN is a different thing from a file that could not be READ: the first
      // measured nothing, the second measured that the file is closed to this login.
      if (probeFails) return { code: 127, stdoutTail: "", stderrTail: "" };
      const lines = file();
      if (lines === null) opts.onStdout?.("AKEYS unreadable");
      else {
        opts.onStdout?.("AKEYS readable");
        for (const l of lines) opts.onStdout?.(`AKEY ${l}`);
      }
    }
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

/** Assert every marker is present in `script` and in the order given. ORDER is the property under
 *  test in two places: the read failure is told apart before anything is written, and the line
 *  arithmetic is checked before the install. */
function expectInOrder(script: string, markers: readonly string[]): void {
  const at = markers.map((m) => script.indexOf(m));
  for (const [i, index] of at.entries()) {
    expect(index, `marker not found: ${markers[i]}`).toBeGreaterThanOrEqual(0);
    if (i > 0) expect(index, `${markers[i]} must come after ${markers[i - 1]}`).toBeGreaterThan(at[i - 1] as number);
  }
}

const DEFS: Record<string, AnyRunDefinition> = {
  "operator-key-place": operatorKeyPlaceDef as unknown as AnyRunDefinition,
  "operator-key-remove": operatorKeyRemoveDef as unknown as AnyRunDefinition,
  "authorized-keys-read": authorizedKeysReadDef as unknown as AnyRunDefinition,
};

describe("the operator-key run kinds — one line of one file, and never this manager's own", () => {
  const handles: DbHandle[] = [];
  const dirs: string[] = [];
  afterEach(() => {
    for (const h of handles.splice(0)) h.sqlite.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /** An adopted slave and the master, both with the manager's own key sealed, plus one operator
   *  key on file. The master is here because it is the machine an operator most needs to reach by
   *  hand — and it is never adopted, so it carries no adoptedAt at all. */
  async function setup(): Promise<{ db: DbHandle; store: CredentialStore; keyId: string }> {
    const dir = mkdtempSync(join(tmpdir(), "ctrl-opkey-"));
    dirs.push(dir);
    const db = openDb(join(dir, "c.db"));
    handles.push(db);
    const store = new CredentialStore({ db: db.db, logger });
    db.db.insert(servers).values({
      id: SLAVE_ID, name: "s1", host: "203.0.113.7", lanHost: "10.1.1.11", sshPort: 22, sshUser: "hostyour1",
      role: "slave", status: "healthy", adoptedAt: new Date(1), preflightJson: { hostKey: "SHA256:x" },
    }).run();
    db.db.insert(servers).values({
      id: MASTER_ID, name: "m1", host: "198.51.100.4", sshPort: 22, sshUser: "hostyour",
      role: "master", status: "healthy", preflightJson: { hostKey: "SHA256:x" },
    }).run();
    for (const id of [SLAVE_ID, MASTER_ID]) {
      await store.seal({
        kind: "ssh_key", label: `key ${id}`, plaintext: Buffer.from("dummy"), fingerprint: MINE_FP, serverId: id,
        publicKey: `ssh-ed25519 ${BLOB_MINE}`,
      });
    }
    const key = createOperatorKey(db.db, "op_test", { label: "pat", publicKey: `${PAT_KEY} pat@example.com` });
    return { db, store, keyId: key.id };
  }

  /** Plan the run kind, then run every one of its steps against the plan's own targets. `file` is asked
   *  on every probe, so a test can hand back one file before the act and another after it. */
  async function runOfKind(
    kind: string,
    db: DbHandle,
    store: CredentialStore,
    opts: { keyId?: string; serverId?: string; file?: () => string[] | null; probeFails?: boolean } = {},
  ): Promise<{ rec: Recorded; cleanups: string[]; stepNames: string[] }> {
    const def = DEFS[kind];
    if (!def) throw new Error(`no definition for ${kind}`);
    const serverId = opts.serverId ?? SLAVE_ID;
    const params = kind === "authorized-keys-read"
      ? { serverId }
      : { serverId, operatorKeyId: opts.keyId ?? "" };
    const plan = await def.plan(params, { db: db.db });
    const runId = `run_${kind}`;
    const stepDefs = def.steps(params);
    seedRunRows(db, {
      runId, kind: def.kind, targetId: serverId,
      steps: stepDefs.map((s, ordinal) => ({ id: `step_${kind}_${ordinal}`, name: s.name })),
    });
    const rec: Recorded = { scripts: new Map(), commands: [] };
    const file = opts.file ?? (() => [MANAGER_LINE]);
    const sshFactory: SshFactory = () => Promise.resolve(fakeSession(rec, file, opts.probeFails ?? false));
    const rc = new RunContext({
      runId, db: db.db, creds: store, bus: new RunEventBus(), logger, params, secrets: new RunSecretsMap(runId),
      signal: new AbortController().signal, sshFactory, targetServerId: serverId,
      declaredTargets: plan.targets ?? [],
    });
    try {
      for (const [ordinal, step] of stepDefs.entries()) {
        await step.run(rc.forStep(step.name, `step_${kind}_${ordinal}`));
      }
    } finally {
      rc.close();
    }
    return { rec, cleanups: rc.registeredCleanups().map((c) => c.name), stepNames: stepDefs.map((s) => s.name) };
  }

  /** The file as it stands before the act, then as it stands after — what a host would look like if
   *  the edit had actually run. */
  function twoStage(before: string[] | null, after: string[] | null): () => string[] | null {
    let call = 0;
    return () => (call++ === 0 ? before : after);
  }

  it("deletes by a marker this manager's own line cannot carry", async () => {
    const { db, store, keyId } = await setup();
    const { rec } = await runOfKind("operator-key-remove", db, store, {
      keyId, file: twoStage([MANAGER_LINE, PAT_LINE], [MANAGER_LINE]),
    });
    const script = rec.scripts.get("operator-key-remove") ?? "";
    expect(script).toContain("hostyour-operator:pat");
    // The manager's own marker is `hostyour` and then a colon. It appears nowhere in an act,
    // so no pattern here can reach the line adopt wrote.
    expect(script).not.toContain("hostyour:");
    // Anchored at the end of the line, or removing "pat" would also take "pat-laptop" off.
    expect(script).toContain("hostyour-operator:pat[[:space:]]*$");
  });

  it("filters with grep -v, so every other line survives byte for byte", async () => {
    const { db, store, keyId } = await setup();
    const { rec } = await runOfKind("operator-key-place", db, store, {
      keyId, file: twoStage([MANAGER_LINE, FOREIGN_LINE], [MANAGER_LINE, FOREIGN_LINE, PAT_LINE]),
    });
    const script = rec.scripts.get("operator-key-place") ?? "";
    expect(script).toContain('grep -v -e "$pattern" "$ak"');
    // An in-place editor would rewrite every line it passed; the copy-and-install shape means the
    // lines that stay were never touched at all.
    expect(script).not.toContain("sed -i");
    expect(script).toContain('install -m 600 "$tmp" "$ak"');
  });

  it("tells a grep that FAILED apart from one that selected nothing, before it writes", async () => {
    const { db, store, keyId } = await setup();
    const { rec } = await runOfKind("operator-key-place", db, store, {
      keyId, file: twoStage([MANAGER_LINE], [MANAGER_LINE, PAT_LINE]),
    });
    const script = rec.scripts.get("operator-key-place") ?? "";
    // grep exits 1 for "nothing selected", which for an inverted match is a legitimate empty result,
    // and 2 or more when it could not read. Installing the empty output of the second would delete
    // every key on the machine.
    expectInOrder(script, ['grep -v -e "$pattern"', '[ "$rc" -le 1 ]', 'install -m 600 "$tmp" "$ak"']);
    expect(script).toContain("NOTHING was written");
  });

  it("re-reads the file and checks the arithmetic BEFORE the install, so a human's key is not lost", async () => {
    const { db, store, keyId } = await setup();
    const { rec } = await runOfKind("operator-key-remove", db, store, {
      keyId, file: twoStage([MANAGER_LINE, PAT_LINE], [MANAGER_LINE]),
    });
    const script = rec.scripts.get("operator-key-remove") ?? "";
    // The host lock keeps other RUNS out and nobody's shell: a key appended by an ssh-copy-id in
    // the window between the copy and the install would be dropped by the install. The counts are
    // read from the file AFTER the copy was made, so such a write makes them disagree and the
    // install is refused.
    expectInOrder(script, [
      'grep -v -e "$pattern" "$ak" > "$tmp"',
      'hits="$(grep -c -e "$pattern" "$ak"',
      '[ "$((before - hits))" = "$after" ]',
      'install -m 600 "$tmp" "$ak"',
    ]);
  });

  it("places ONE line and replaces its own predecessor, so a rotated key leaves nothing working", async () => {
    const { db, store, keyId } = await setup();
    const { rec } = await runOfKind("operator-key-place", db, store, {
      keyId, file: twoStage([MANAGER_LINE], [MANAGER_LINE, PAT_LINE]),
    });
    const script = rec.scripts.get("operator-key-place") ?? "";
    // The filter runs first and the append second: placing the same label twice leaves one line.
    expectInOrder(script, ['grep -v -e "$pattern"', `printf '%s\\n' '${PAT_LINE}' >> "$tmp"`, 'install -m 600']);
    expect([...script.matchAll(/>> "\$tmp"/g)]).toHaveLength(1);
  });

  it("takes its verdict from the file read back, not from the exit code of the edit", async () => {
    const { db, store, keyId } = await setup();
    // The removal deletes by marker; this key sits under a comment nothing here wrote, so the line
    // survives — and the run must say so instead of reporting a removal that did not happen.
    const stillThere = [MANAGER_LINE, `${PAT_KEY} pat@his-own-laptop`];
    await expect(runOfKind("operator-key-remove", db, store, { keyId, file: () => stillThere }))
      .rejects.toThrow(/STILL in the file/);
  });

  it("fails a placement the read-back cannot confirm", async () => {
    const { db, store, keyId } = await setup();
    await expect(runOfKind("operator-key-place", db, store, { keyId, file: () => [MANAGER_LINE] }))
      .rejects.toThrow(/is not in the file after the write/);
  });

  it("refuses to report success when this manager's own key has gone from the file", async () => {
    const { db, store, keyId } = await setup();
    // The one catastrophic outcome: the platform's own way into the machine is gone. It is checked
    // before the script's exit code, because it is the more serious answer.
    await expect(runOfKind("operator-key-place", db, store, {
      keyId, file: twoStage([MANAGER_LINE], [PAT_LINE]),
    })).rejects.toThrow(/this manager's own key is no longer in the file/);
  });

  it("arms the compensation unless it MEASURED the key already there", async () => {
    for (const [before, expected] of [
      [[MANAGER_LINE], ["remove-operator-key"]],
      [null, ["remove-operator-key"]], // an unreadable file is not a file we know the key is in
      [[MANAGER_LINE, PAT_LINE], []],
    ] as const) {
      const { db, store, keyId } = await setup();
      const { cleanups } = await runOfKind("operator-key-place", db, store, {
        keyId, file: twoStage(before as string[] | null, [MANAGER_LINE, PAT_LINE]),
      });
      expect(cleanups).toEqual(expected);
    }
  });

  it("names its compensation in cleanups(), so an abort can resolve the persisted name", async () => {
    // The executor resolves a run's registered names against def.cleanups(); a name it cannot
    // resolve gets a row with no implementation behind it.
    expect(operatorKeyPlaceDef.cleanups?.({ serverId: SLAVE_ID, operatorKeyId: "opk_1" }).map((c) => c.name))
      .toEqual(["remove-operator-key"]);
    // A removal registers none: it is itself the compensation, and putting a key back would be a
    // placement nobody approved.
    expect(operatorKeyRemoveDef.cleanups).toBeUndefined();
    expect(authorizedKeysReadDef.cleanups).toBeUndefined();
  });

  it("writes the reading back on the row, naming every line and who it belongs to", async () => {
    const { db, store, keyId } = await setup();
    await runOfKind("operator-key-place", db, store, {
      keyId, file: twoStage([MANAGER_LINE, FOREIGN_LINE], [MANAGER_LINE, FOREIGN_LINE, PAT_LINE]),
    });
    const row = db.db.select().from(servers).where(eq(servers.id, SLAVE_ID)).get();
    // A key nothing here placed is still on the host, so the row must NOT read as clean.
    expect(row?.authorizedKeysState).toBe("unaccounted");
    const read = readServerAuthorizedKeys(row?.authorizedKeysJson);
    expect(read.kind).toBe("v0");
    if (read.kind === "v0") {
      expect(read.facts.runId).toBe("run_operator-key-place");
      expect(read.facts.keys.map((k) => k.kind)).toEqual(["manager", "foreign", "operator"]);
      expect(read.facts.keys.find((k) => k.kind === "operator")).toMatchObject({ fingerprint: PAT_FP, label: "pat" });
    }
  });

  it("the read run kind changes nothing and records what it found", async () => {
    const { db, store } = await setup();
    const { rec, stepNames, cleanups } = await runOfKind("authorized-keys-read", db, store, {
      file: () => [MANAGER_LINE, PAT_LINE],
    });
    expect(stepNames).toEqual([ATTEST_TARGET_STEP, "read-authorized-keys"]);
    // The only script it ships is the probe — no filter, no install, nothing written.
    expect([...rec.scripts.keys()]).toEqual(["authorized-keys-probe"]);
    expect(cleanups).toEqual([]);
    expect(db.db.select().from(servers).where(eq(servers.id, SLAVE_ID)).get()?.authorizedKeysState).toBe("accounted");
  });

  it("records an unreadable file as a MEASUREMENT, not as a run that did nothing", async () => {
    const { db, store } = await setup();
    // The host answered and said the file cannot be opened. That is a reading, and it is written —
    // reporting it as "no keys found" would state as fact the exact thing the run failed to measure.
    await runOfKind("authorized-keys-read", db, store, { file: () => null });
    expect(db.db.select().from(servers).where(eq(servers.id, SLAVE_ID)).get()?.authorizedKeysState).toBe("unreadable");
  });

  it("fails the read run kind when the PROBE did not run — a reading IS the run", async () => {
    const { db, store } = await setup();
    await expect(runOfKind("authorized-keys-read", db, store, { probeFails: true }))
      .rejects.toThrow(/could not be read/);
    // Nothing is written when the probe never ran: the row keeps what it had, rather than a guess.
    expect(db.db.select().from(servers).where(eq(servers.id, SLAVE_ID)).get()?.authorizedKeysState).toBe("unknown");
  });

  for (const kind of Object.keys(DEFS)) {
    it(`${kind} starts with ${ATTEST_TARGET_STEP} and owns its host`, async () => {
      const { db, keyId } = await setup();
      const params = kind === "authorized-keys-read" ? { serverId: SLAVE_ID } : { serverId: SLAVE_ID, operatorKeyId: keyId };
      const def = DEFS[kind] as AnyRunDefinition;
      expect(def.steps(params)[0]?.name).toBe(ATTEST_TARGET_STEP);
      // mutating ⇒ the executor refuses to let an operator skip that first step: a run that changes
      // who a machine lets in — or writes a reading about one — proves first which machine it is.
      expect(def.mutating).toBe(true);
      const plan = await def.plan(params, { db: db.db });
      // Without the lock, two placements could rewrite the same file at once and the second install
      // would drop the first's line.
      expect(deriveServerLocks(plan.targets ?? [])).toEqual([{ resource: "server", key: SLAVE_ID }]);
      expect(plan.requiredSecrets).toEqual([]);
    });

    it(`${kind} refuses a host this manager holds no key for — there is no session to edit over`, async () => {
      const { db, keyId } = await setup();
      const params = kind === "authorized-keys-read" ? { serverId: SLAVE_ID } : { serverId: SLAVE_ID, operatorKeyId: keyId };
      for (const status of ["bare", "adopting"] as const) {
        db.db.update(servers).set({ status }).where(eq(servers.id, SLAVE_ID)).run();
        await expect(DEFS[kind]!.plan(params, { db: db.db })).rejects.toMatchObject({ code: "VALIDATION" });
      }
    });

    it(`${kind} accepts the MASTER — the machine an operator most needs to reach by hand`, async () => {
      const { db, keyId } = await setup();
      // The master carries no adoptedAt at all: it self-registers at boot and is never adopted.
      expect(db.db.select().from(servers).where(eq(servers.id, MASTER_ID)).get()?.adoptedAt).toBeNull();
      const params = kind === "authorized-keys-read" ? { serverId: MASTER_ID } : { serverId: MASTER_ID, operatorKeyId: keyId };
      await expect(DEFS[kind]!.plan(params, { db: db.db })).resolves.toBeTruthy();
    });
  }

  it("keeps an operator key OUT of the credential store, so no by-server lookup can ever reach it", async () => {
    const { db, store } = await setup();
    // The finding this design is built on: a credential of kind ssh_key is looked up BY SERVER,
    // newest wins (executor/context.ts getSsh, and adopt's install-key). A human's key filed there
    // would become the identity this manager tries to log in with — a different key, the same
    // lookup. It lives in its own table instead, so the collision cannot be reached at all.
    const all = await store.list();
    expect(all.map((c) => c.fingerprint)).not.toContain(PAT_FP);
    for (const id of [SLAVE_ID, MASTER_ID]) {
      const keys = await store.list({ serverId: id, kind: "ssh_key" });
      expect(keys).toHaveLength(1);
      expect(keys[0]?.fingerprint).toBe(MINE_FP);
    }
    // And the row is where it belongs, reachable only by its own id.
    expect(db.db.select().from(servers).all()).toHaveLength(2);
  });

  it("refuses to plan against an operator key that is no longer stored", async () => {
    const { db } = await setup();
    await expect(operatorKeyPlaceDef.plan({ serverId: SLAVE_ID, operatorKeyId: "opk_gone" }, { db: db.db }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
