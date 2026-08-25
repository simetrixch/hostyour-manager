import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { openDb, type DbHandle } from "../db/client.ts";
import { servers } from "../db/schema/inventory.ts";
import { attestMachineId } from "./attest.ts";
import type { SshSession, ExecOptions, ExecResult } from "../adapters/ssh/port.ts";

// A fake Ubuntu session whose only interesting command is `cat /etc/machine-id`: it emits
// the given id (with whatever trailing whitespace the caller passes) on stdout. Mirrors the
// fake-SSH style of adopt.test.ts / context.test.ts.
function fakeSession(machineIdOut: string): SshSession {
  return {
    exec: async (command: string, o: ExecOptions): Promise<ExecResult> => {
      if (command.includes("/etc/machine-id")) o.onStdout?.(machineIdOut);
      return { code: 0, stdoutTail: "", stderrTail: "" };
    },
    mustExec: async () => ({ code: 0, stdoutTail: "", stderrTail: "" }),
    putFile: async () => undefined,
    forwardLocalPort: async () => ({ localPort: 0, close: () => undefined }),
    hostKeyFingerprint: () => "SHA256:x",
    close: () => undefined,
  } as unknown as SshSession;
}

const MID = "0123456789abcdef0123456789abcdef";
const OTHER = "ffffffffffffffffffffffffffffffff";
const signal = new AbortController().signal;

describe("attestMachineId ", () => {
  const handles: DbHandle[] = [];
  const dirs: string[] = [];
  afterEach(() => {
    for (const h of handles.splice(0)) h.sqlite.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function setup(machineId: string | null): { db: DbHandle; serverId: string } {
    const dir = mkdtempSync(join(tmpdir(), "mgr-attest-"));
    dirs.push(dir);
    const db = openDb(join(dir, "c.db"));
    handles.push(db);
    const serverId = "srv_att1";
    db.db
      .insert(servers)
      .values({
        id: serverId,
        name: "s1",
        host: "10.1.1.11",
        sshPort: 22,
        sshUser: "root",
        ...(machineId !== null ? { machineId } : {}),
      })
      .run();
    return { db, serverId };
  }

  function storedMachineId(db: DbHandle, serverId: string): string | null {
    return db.db.select().from(servers).where(eq(servers.id, serverId)).get()?.machineId ?? null;
  }

  it("records the machine-id on a NULL row (backfill after adopt)", async () => {
    const { db, serverId } = setup(null);
    const logs: string[] = [];
    const out = await attestMachineId({ db: db.db, session: fakeSession(MID), serverId, signal, log: (l) => logs.push(l) });

    expect(out).toEqual({ action: "recorded", machineId: MID });
    expect(storedMachineId(db, serverId)).toBe(MID); // the row was actually updated
    expect(logs.join("\n")).toContain("recorded machine-id");
  });

  it("verifies OK when the stored machine-id matches", async () => {
    const { db, serverId } = setup(MID);
    const logs: string[] = [];
    const out = await attestMachineId({ db: db.db, session: fakeSession(MID), serverId, signal, log: (l) => logs.push(l) });

    expect(out).toEqual({ action: "verified", machineId: MID });
    expect(storedMachineId(db, serverId)).toBe(MID); // unchanged
    expect(logs.join("\n")).toContain("machine-id verified");
  });

  it("throws a validation error on a mismatch and never overwrites the recorded id", async () => {
    const { db, serverId } = setup(MID);
    await expect(
      attestMachineId({ db: db.db, session: fakeSession(OTHER), serverId, signal }),
    ).rejects.toMatchObject({ code: "VALIDATION", message: `this is not the machine we adopted: expected ${MID} got ${OTHER}` });
    expect(storedMachineId(db, serverId)).toBe(MID); // the reused-IP stranger did NOT clobber it
  });

  it("trims a trailing newline from /etc/machine-id before comparing", async () => {
    const { db, serverId } = setup(MID);
    const out = await attestMachineId({ db: db.db, session: fakeSession(`${MID}\n`), serverId, signal });
    expect(out.action).toBe("verified");
  });
});
