import { describe, it, expect, afterEach } from "vitest";
import { createSshSession } from "./ssh2-session.ts";
import { generateServerKeypair } from "./keygen.ts";
import { startFakeSshServer, type FakeSshServer, type FakeServerOptions } from "./testing/fake-server.ts";
import { ExecFailedError, ExecTimeoutError, HostKeyMismatchError, type SshTarget } from "./port.ts";

const key = generateServerKeypair("test@m1");

describe("ssh2 session against a real in-process ssh2.Server", () => {
  const servers: FakeSshServer[] = [];
  async function start(opts: FakeServerOptions): Promise<FakeSshServer> {
    const s = await startFakeSshServer(opts);
    servers.push(s);
    return s;
  }
  afterEach(async () => {
    for (const s of servers.splice(0)) await s.close();
  });

  const pwTarget = (port: number, extra?: Partial<SshTarget>): SshTarget => ({
    host: "127.0.0.1",
    port,
    username: "u",
    auth: { kind: "password", password: Buffer.from("pw") },
    ...extra,
  });

  it("password auth + exec streams stdout in line order and returns the exit code", async () => {
    const srv = await start({ acceptPassword: "pw", execTable: { "echo hi": { stdout: "line1\nline2\n", code: 0 } } });
    const session = await createSshSession(pwTarget(srv.port));
    const lines: string[] = [];
    const res = await session.exec("echo hi", { signal: new AbortController().signal, onStdout: (l) => lines.push(l) });
    expect(res.code).toBe(0);
    expect(lines).toEqual(["line1", "line2"]);
    session.close();
  });

  it("key auth with a generated keygen key is accepted", async () => {
    const srv = await start({ authorizedKeys: [key.publicLine], execTable: { whoami: { stdout: "root\n", code: 0 } } });
    const session = await createSshSession({
      host: "127.0.0.1",
      port: srv.port,
      username: "root",
      auth: { kind: "key", privateKey: key.privateOpenSsh },
    });
    const res = await session.mustExec("whoami", { signal: new AbortController().signal });
    expect(res.stdoutTail.trim()).toBe("root");
    session.close();
  });

  it("mustExec throws ExecFailedError with the stderr tail on a non-zero exit", async () => {
    const srv = await start({ acceptPassword: "pw", execTable: { false: { stderr: "boom\n", code: 1 } } });
    const session = await createSshSession(pwTarget(srv.port));
    await expect(session.mustExec("false", { signal: new AbortController().signal })).rejects.toBeInstanceOf(ExecFailedError);
    session.close();
  });

  it("exec rejects immediately with AbortError when the signal is already aborted", async () => {
    const srv = await start({ acceptPassword: "pw" });
    const session = await createSshSession(pwTarget(srv.port));
    const ac = new AbortController();
    ac.abort();
    await expect(session.exec("echo x", { signal: ac.signal })).rejects.toMatchObject({ name: "AbortError" });
    session.close();
  });

  it("exec rejects with ExecTimeoutError when a command exceeds its timeout", async () => {
    const srv = await start({ acceptPassword: "pw", execTable: { "sleep 999": { hang: true } } });
    const session = await createSshSession(pwTarget(srv.port));
    await expect(session.exec("sleep 999", { signal: new AbortController().signal, timeoutMs: 200 })).rejects.toBeInstanceOf(ExecTimeoutError);
    session.close();
  });

  it("exec rejects with AbortError when the signal fires mid-command", async () => {
    const srv = await start({ acceptPassword: "pw", execTable: { "sleep 999": { hang: true } } });
    const session = await createSshSession(pwTarget(srv.port));
    const ac = new AbortController();
    const p = session.exec("sleep 999", { signal: ac.signal });
    setTimeout(() => ac.abort(), 50);
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    session.close();
  });

  it("putFile releases its SFTP channel: repeated putFile+exec cycles under a MaxSessions cap all pass (the verify-slave channel-exhaustion regression)", async () => {
    // Before the fix, every putFile leaked its SFTP session channel; with sshd's
    // MaxSessions-style cap this refused the 3rd/4th channel open ("(SSH) Channel open
    // failure") — how a long verify-slave (a diagnostic-script upload per minute) died on
    // its final poll. 8 cycles against a cap of 3 stay green only if each putFile
    // end()s its channel.
    const srv = await start({ acceptPassword: "pw", maxSessions: 3, execTable: { "echo ok": { stdout: "ok\n", code: 0 } } });
    const session = await createSshSession(pwTarget(srv.port));
    for (let i = 0; i < 8; i++) {
      await session.putFile(`/tmp/dc-leak-${i}.sh`, Buffer.from("#!/bin/bash\n"), 0o700, { signal: new AbortController().signal });
      const r = await session.exec("echo ok", { signal: new AbortController().signal });
      expect(r.code).toBe(0);
    }
    session.close();
  });

  it("records the host-key fingerprint and hard-fails on a pinned mismatch", async () => {
    const srv = await start({ acceptPassword: "pw" });
    const first = await createSshSession(pwTarget(srv.port));
    expect(first.hostKeyFingerprint()).toBe(srv.hostKeyFingerprint);
    first.close();
    await expect(
      createSshSession(pwTarget(srv.port, { hostKeyFingerprint: "SHA256:wrongwrongwrongwrongwrongwrongwrongwrong00" })),
    ).rejects.toBeInstanceOf(HostKeyMismatchError);
  });
});
