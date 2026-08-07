import { describe, it, expect, vi } from "vitest";
import { remoteCmd, remoteExec, remoteScript, installerPhase, DEFAULT_PHASE_TIMEOUT_MS, type RemoteOpts } from "./stepkit.ts";
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

describe("installerPhase", () => {
  const NAME = "install-microk8s";

  it("skip path: probe done ⇒ run NEVER called, verify skipped, phase checkpointed done", async () => {
    const { ctx, logs, checkpoints } = fakeCtx();
    const session = fakeSession();
    const run = vi.fn(async () => undefined);
    const verify = vi.fn(async () => undefined);

    await installerPhase(ctx, session, NAME, { probe: async () => true, run, verify });

    expect(run).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
    expect(logs).toContainEqual(["meta", `phase ${NAME}: already complete (probe) — skipping`]);
    expect(checkpoints).toEqual([
      { phase: NAME, state: "probing" },
      { phase: NAME, state: "done" },
    ]);
  });

  it("happy path: probe not-done ⇒ run streams, gets the phase timeout, verify passes, done", async () => {
    const { ctx, logs, checkpoints } = fakeCtx();
    const session = fakeSession();
    const order: string[] = [];
    let seenTimeout: number | undefined;
    const run = vi.fn(async (c: StepCtx, _s: SshSession, o: RemoteOpts) => {
      order.push("run");
      seenTimeout = o.timeoutMs;
      c.log("stdout", "installing microk8s...");
    });
    const verify = vi.fn(async () => {
      order.push("verify");
    });

    await installerPhase(ctx, session, NAME, { probe: async () => false, run, verify });

    expect(order).toEqual(["run", "verify"]); // run BEFORE verify
    expect(seenTimeout).toBe(DEFAULT_PHASE_TIMEOUT_MS); // generous default threaded into run
    expect(logs).toContainEqual(["stdout", "installing microk8s..."]);
    expect(checkpoints).toEqual([
      { phase: NAME, state: "probing" },
      { phase: NAME, state: "running" },
      { phase: NAME, state: "verifying" },
      { phase: NAME, state: "done" },
    ]);
  });

  it("verify-fail path: run succeeds but verify throws ⇒ installerPhase throws, NOT marked done", async () => {
    const { ctx, checkpoints } = fakeCtx();
    const session = fakeSession();
    const run = vi.fn(async () => undefined);

    await expect(
      installerPhase(ctx, session, NAME, {
        probe: async () => false,
        run,
        verify: async () => {
          throw new Error("node not Ready");
        },
      }),
    ).rejects.toThrow("node not Ready");

    expect(run).toHaveBeenCalledOnce();
    expect(checkpoints.at(-1)).toEqual({ phase: NAME, state: "verifying" }); // stuck at verifying
    expect(checkpoints).not.toContainEqual({ phase: NAME, state: "done" });
  });

  it("resume: a second invocation probe-skips once the phase is complete", async () => {
    const session = fakeSession();
    let complete = false;
    const run = vi.fn(async () => {
      complete = true;
    });
    const verify = vi.fn(async () => undefined);
    const phase = { probe: async () => complete, run, verify };

    // first Run: probe not-done ⇒ runs the phase
    const first = fakeCtx();
    await installerPhase(first.ctx, session, NAME, phase);
    expect(run).toHaveBeenCalledOnce();
    expect(verify).toHaveBeenCalledOnce();

    // second Run (resume after a crash/disconnect): probe now done ⇒ probe-skips
    const second = fakeCtx();
    await installerPhase(second.ctx, session, NAME, phase);
    expect(run).toHaveBeenCalledOnce(); // NOT run again
    expect(verify).toHaveBeenCalledOnce(); // NOT verified again
    expect(second.logs).toContainEqual(["meta", `phase ${NAME}: already complete (probe) — skipping`]);
    expect(second.checkpoints.at(-1)).toEqual({ phase: NAME, state: "done" });
  });
});
