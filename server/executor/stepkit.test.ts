import { describe, it, expect, vi } from "vitest";
import { remoteCmd, remoteExec, remoteScript } from "./stepkit.ts";
import type { StepCtx } from "./types.ts";
import type { SshSession, ExecResult, ExecOptions } from "../adapters/ssh/port.ts";

const ok = (code = 0): ExecResult => ({ code, stdoutTail: "", stderrTail: "" });

function fakeSession(over: Partial<SshSession> = {}): SshSession {
  return {
    exec: vi.fn(async () => ok()),
    mustExec: vi.fn(async () => ok()),
    putFile: vi.fn(async () => undefined),
    forwardLocalPort: vi.fn(async () => ({ localPort: 0, close: () => undefined })),
    hostKeyFingerprint: () => "SHA256:test",
    close: vi.fn(),
    ...over,
  } as unknown as SshSession;
}

function fakeCtx(): { ctx: StepCtx; logs: [string, string][]; checkpoints: unknown[] } {
  const logs: [string, string][] = [];
  const checkpoints: unknown[] = [];
  const ctx = {
    runId: "run_1",
    signal: new AbortController().signal,
    log: (stream: string, text: string) => logs.push([stream, text]),
    checkpoint: (data: unknown) => checkpoints.push(data),
  } as unknown as StepCtx;
  return { ctx, logs, checkpoints };
}

describe("step-kit", () => {
  it("remoteCmd streams stdout/stderr to ctx.log and uses mustExec", async () => {
    const { ctx, logs } = fakeCtx();
    const session = fakeSession({
      mustExec: vi.fn(async (_c: string, o: ExecOptions) => {
        o.onStdout?.("hi");
        o.onStderr?.("warn");
        return ok();
      }),
    });
    await remoteCmd(ctx, session, "echo hi");
    expect(session.mustExec).toHaveBeenCalledOnce();
    expect(logs).toContainEqual(["stdout", "hi"]);
    expect(logs).toContainEqual(["stderr", "warn"]);
  });

  it("remoteExec uses exec (non-throwing) and returns the exit code", async () => {
    const { ctx } = fakeCtx();
    const session = fakeSession({ exec: vi.fn(async () => ok(7)) });
    const r = await remoteExec(ctx, session, "false");
    expect(r.code).toBe(7);
    expect(session.exec).toHaveBeenCalledOnce();
  });

  it("passes stdin + timeout through to the session", async () => {
    const { ctx } = fakeCtx();
    let seen: ExecOptions | undefined;
    const session = fakeSession({
      exec: vi.fn(async (_c: string, o: ExecOptions) => {
        seen = o;
        return ok();
      }),
    });
    const pw = Buffer.from("secret");
    await remoteExec(ctx, session, "sudo -S true", { stdin: pw, timeoutMs: 5000 });
    expect(seen?.stdin).toBe(pw);
    expect(seen?.timeoutMs).toBe(5000);
  });

  it("remoteScript uploads to a per-run /tmp path, runs bash, then cleans up", async () => {
    const { ctx } = fakeCtx();
    const calls: string[] = [];
    const session = fakeSession({
      putFile: vi.fn(async (p: string) => {
        calls.push(`put:${p}`);
      }),
      exec: vi.fn(async (c: string) => {
        calls.push(`exec:${c}`);
        return ok();
      }),
    });
    await remoteScript(ctx, session, "preflight", "echo hi");
    expect(calls).toEqual([
      "put:/tmp/dc-preflight-run_1.sh",
      "exec:bash /tmp/dc-preflight-run_1.sh",
      "exec:rm -f /tmp/dc-preflight-run_1.sh",
    ]);
  });

  it("remoteScript still cleans up when the script exits non-zero", async () => {
    const { ctx } = fakeCtx();
    const removed: string[] = [];
    const session = fakeSession({
      exec: vi.fn(async (c: string) => {
        if (c.startsWith("rm -f")) removed.push(c);
        return c.startsWith("bash") ? ok(1) : ok();
      }),
    });
    const r = await remoteScript(ctx, session, "x", "false");
    expect(r.code).toBe(1); // returned, not thrown
    expect(removed).toEqual(["rm -f /tmp/dc-x-run_1.sh"]);
  });
});
