// The step-kit: thin combinators every mutating Run step is built from,
// so steps read as intent, not ssh plumbing. All remote helpers wire the session's
// line-buffered stdout/stderr to ctx.log (the one run-output path) and thread ctx.signal
// (no unabortable execs). Operates on any SshSession — the cached ctx.ssh() (key) or the
// adopt ceremony's ctx.openPasswordSession() (password).
import type { StepCtx } from "./types.ts";
import type { SshSession, ExecResult } from "../adapters/ssh/port.ts";
import type { Db } from "../db/client.ts";

export interface RemoteOpts {
  timeoutMs?: number;
  stdin?: Buffer; // e.g. a sudo -S password — never logged (redactor covers echoes)
}

function execOpts(ctx: StepCtx, opts?: RemoteOpts): {
  signal: AbortSignal;
  onStdout: (line: string) => void;
  onStderr: (line: string) => void;
  timeoutMs?: number;
  stdin?: Buffer;
} {
  return {
    signal: ctx.signal,
    onStdout: (line: string) => ctx.log("stdout", line),
    onStderr: (line: string) => ctx.log("stderr", line),
    ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts?.stdin !== undefined ? { stdin: opts.stdin } : {}),
  };
}

/** Run a command, stream it to the log, and THROW ExecFailed on a non-zero exit (mustExec).
 *  Use when a non-zero exit is a step failure. */
export function remoteCmd(ctx: StepCtx, session: SshSession, command: string, opts?: RemoteOpts): Promise<ExecResult> {
  return session.mustExec(command, execOpts(ctx, opts));
}

/** Run a command, stream it to the log, and RETURN the result without throwing on non-zero —
 *  the caller inspects `.code` and controls its own pass/fail wording (exec, not mustExec). */
export function remoteExec(ctx: StepCtx, session: SshSession, command: string, opts?: RemoteOpts): Promise<ExecResult> {
  return session.exec(command, execOpts(ctx, opts));
}

/** Upload a script to /tmp (0700), run it via `bash`, stream it, then best-effort remove it.
 *  Returns the script's ExecResult (non-throwing on its exit code — the caller decides);
 *  putFile / transport errors propagate. The path is per-run so concurrent runs never clash. */
export async function remoteScript(
  ctx: StepCtx,
  session: SshSession,
  name: string,
  script: string,
  opts?: RemoteOpts,
): Promise<ExecResult> {
  const path = `/tmp/dc-${name}-${ctx.runId}.sh`;
  await session.putFile(path, Buffer.from(script, "utf8"), 0o700, { signal: ctx.signal });
  try {
    return await session.exec(`bash ${path}`, execOpts(ctx, opts));
  } finally {
    try {
      await session.exec(`rm -f ${path}`, { signal: ctx.signal });
    } catch {
      // best-effort cleanup — a leftover /tmp script is harmless
    }
  }
}

/** Like remoteScript, but also returns the FULL collected stdout (not just the capped tail) —
 *  for steps that parse structured output (e.g. the preflight checks' CHECK lines, the
 *  baseline probe). Streams to the log as it goes and cleans up the /tmp script. */
export async function remoteScriptCapture(
  ctx: StepCtx,
  session: SshSession,
  name: string,
  script: string,
  opts?: RemoteOpts,
): Promise<{ result: ExecResult; stdout: string }> {
  const path = `/tmp/dc-${name}-${ctx.runId}.sh`;
  await session.putFile(path, Buffer.from(script, "utf8"), 0o700, { signal: ctx.signal });
  const out: string[] = [];
  try {
    const result = await session.exec(`bash ${path}`, {
      signal: ctx.signal,
      onStdout: (line: string) => {
        out.push(line);
        ctx.log("stdout", line);
      },
      onStderr: (line: string) => ctx.log("stderr", line),
      ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts?.stdin !== undefined ? { stdin: opts.stdin } : {}),
    });
    return { result, stdout: out.join("\n") };
  } finally {
    try {
      await session.exec(`rm -f ${path}`, { signal: ctx.signal });
    } catch {
      // best-effort cleanup
    }
  }
}

/** One inventory transaction (better-sqlite3 is synchronous; a crash between two of these
 *  leaves a consistent, resumable picture). */
export function localTx<T>(ctx: StepCtx, fn: (tx: Db) => T): T {
  return ctx.db.transaction(fn);
}
