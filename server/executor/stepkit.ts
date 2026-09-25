// The step-kit: thin combinators every mutating Run step is built from,
// so steps read as intent, not ssh plumbing. All remote helpers wire the session's
// line-buffered stdout/stderr to ctx.log (the one run-output path) and thread ctx.signal
// (no unabortable execs). Operates on any SshSession — the cached ctx.ssh() (key) or the
// first-contact ctx.openPasswordSession() (password).
//
// A step that needs ROOT says so with `elevation` and hands over the password it holds; every
// helper below then raises what it sends (see `raised`). Nothing here reaches root by assuming the
// machine already grants something.
import type { StepCtx } from "./types.ts";
import type { SshSession, ExecResult } from "../adapters/ssh/port.ts";
import type { Db } from "../db/client.ts";
import { errMissingRunSecret } from "../kernel/errors.ts";

/** What a remote helper takes beyond the command itself.
 *
 *  `stdin` AND `elevation` ARE THE SAME CHANNEL, so the type takes one or the other and never both:
 *  a password reaches a command on its standard input and nowhere else, because an argument list is
 *  readable by every process listing on the machine. A call that set both would silently lose
 *  whichever the helper wrote second. */
export type RemoteOpts = { timeoutMs?: number } & (
  | { stdin?: Buffer; elevation?: undefined } // stdin the command itself reads — never logged (redactor covers echoes)
  | { stdin?: undefined; elevation: string } // the password this command is raised to root with
);

/** Raise one command to root with a password the CALLER holds, instead of with a standing rule on
 *  the machine. `-S` makes sudo read the password from standard input, `-p ''` keeps its prompt out
 *  of the run log, and sudo consumes exactly one line and hands the rest of the input to the
 *  command.
 *
 *  ONE `sudo -S` PER THING SENT, which is why an elevated SCRIPT is raised whole rather than line by
 *  line: the first `sudo -S` inside it takes the password, and every later one reads an input that
 *  is already at end of file and prompts a terminal that is not there.
 *
 *  THIS IS THE ONLY FORM ANY COMMAND OF THIS MANAGER TAKES TO ROOT. The other one, `sudo -n`,
 *  answers only where the machine already carries a sudoers rule granting that exact command without
 *  a password — a standing passwordless-root grant, which no run kind here writes and which the
 *  deployment's `remove-sudoers` takes off a machine that still carries one. A machine holding no
 *  such rule refuses `sudo -n` with "interactive authentication is required", which is a closed door
 *  that reads like a broken service, so a call site reaching for one is caught in the source instead
 *  (domains/runs/elevation.test.ts). */
function raised(command: string, opts?: RemoteOpts): string {
  return opts?.elevation === undefined ? command : `sudo -S -p '' ${command}`;
}

/** The password a run holds for its target machine, or the loud refusal a step gives without it.
 *  Run secrets are never stored, so a restart mid-run leaves a step with nothing to raise itself
 *  with, and naming the secret is what tells the operator which one to re-enter.
 *
 *  It stands beside `raised` because it is the other half of the same route: a step that reaches
 *  root asks for the password here and hands it to `elevation` there, and no step of this manager
 *  reaches root any other way. */
export function requirePassword(ctx: StepCtx, secretName: string): string {
  const password = ctx.secrets.get(secretName)?.toString("utf8");
  if (password === undefined || password.length === 0) throw errMissingRunSecret(secretName);
  return password;
}

function execOpts(ctx: StepCtx, opts?: RemoteOpts): {
  signal: AbortSignal;
  onStdout: (line: string) => void;
  onStderr: (line: string) => void;
  timeoutMs?: number;
  stdin?: Buffer;
} {
  const stdin = opts?.elevation !== undefined ? Buffer.from(`${opts.elevation}\n`, "utf8") : opts?.stdin;
  return {
    signal: ctx.signal,
    onStdout: (line: string) => ctx.log("stdout", line),
    onStderr: (line: string) => ctx.log("stderr", line),
    ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(stdin !== undefined ? { stdin } : {}),
  };
}

/** Run a command, stream it to the log, and THROW ExecFailed on a non-zero exit (mustExec).
 *  Use when a non-zero exit is a step failure. */
export function remoteCmd(ctx: StepCtx, session: SshSession, command: string, opts?: RemoteOpts): Promise<ExecResult> {
  return session.mustExec(raised(command, opts), execOpts(ctx, opts));
}

/** Run a command, stream it to the log, and RETURN the result without throwing on non-zero —
 *  the caller inspects `.code` and controls its own pass/fail wording (exec, not mustExec). */
export function remoteExec(ctx: StepCtx, session: SshSession, command: string, opts?: RemoteOpts): Promise<ExecResult> {
  return session.exec(raised(command, opts), execOpts(ctx, opts));
}

/** Run a command, stream it to the log like the two above, and return the FULL collected stdout —
 *  for the steps that PARSE what a machine answered. `ExecResult.stdoutTail` is capped, so a caller
 *  that reads rows out of an answer cannot use it and would otherwise collect the lines itself; it
 *  stands here once because three convergence loops were each collecting them their own way. */
export async function execCapture(
  ctx: StepCtx,
  session: SshSession,
  command: string,
  opts?: RemoteOpts,
): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const r = await session.exec(raised(command, opts), {
    ...execOpts(ctx, opts),
    onStdout: (line: string) => {
      lines.push(line);
      ctx.log("stdout", line);
    },
  });
  return { code: r.code, out: lines.join("\n") };
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
    return await session.exec(raised(`bash ${path}`, opts), execOpts(ctx, opts));
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
    const result = await session.exec(raised(`bash ${path}`, opts), {
      ...execOpts(ctx, opts),
      onStdout: (line: string) => {
        out.push(line);
        ctx.log("stdout", line);
      },
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
