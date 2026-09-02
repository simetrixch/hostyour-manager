// Shell-free git execution + the GIT_ASKPASS credential bridge for the git adapter.
// Every git the adapter runs goes through runGit: argv arrays via execFile (never
// a shell string, never a shell at all), a hardened child env (prompts off, credential helpers
// off, autocrlf off so bytes round-trip verbatim), and failures surfaced as an AppError that
// carries git's stderr verbatim, and a budget beyond which the child is killed. withAskpass
// materializes a read token as a 0700 one-shot helper script so the credential NEVER appears in
// the repo URL, in argv, or in .git/config.
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { AppError, errValidation } from "../../kernel/errors.ts";

const execFileP = promisify(execFile);
const DEFAULT_MAX_BUFFER = 32 * 1024 * 1024;

/** How long any git may run before it is killed. Same budget the helm renderer and the ssh exec
 *  give a child that talks to something outside this process, for the same reason: prompts-off
 *  turns a git WAITING FOR INPUT into a failure, and nothing turns a git waiting for a REMOTE
 *  into one. A network that black-holes rather than refuses, an authenticating proxy, a host whose
 *  route is gone — git waits on all three without a bound of its own. */
const DEFAULT_TIMEOUT_MS = 120_000;

export interface RunGitOptions {
  cwd: string;
  /** Extra env merged over process.env (e.g. GIT_ASKPASS from withAskpass). */
  env?: Record<string, string>;
  signal?: AbortSignal;
  maxBuffer?: number;
  /** Override the budget where the caller can wait less than the default — a check that runs
   *  before the listener stands is not a run somebody is watching. */
  timeoutMs?: number;
}

// Prompts hard-off — that is HALF of "a wedged fetch must fail, not hang": it ends a git waiting
// for input, and the budget above ends a git waiting for a remote. Configured credential helpers
// disabled (the ONLY credential path is the askpass helper), byte-verbatim text, no signing.
// GIT_CONFIG_* outranks every config file, so a host's gitconfig cannot change adapter behavior.
function childEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "3",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "",
    GIT_CONFIG_KEY_1: "core.autocrlf",
    GIT_CONFIG_VALUE_1: "false",
    GIT_CONFIG_KEY_2: "commit.gpgsign",
    GIT_CONFIG_VALUE_2: "false",
    ...(extra ?? {}),
  };
}

function fail(args: readonly string[], e: unknown, budgetMs: number): never {
  const err = e as NodeJS.ErrnoException & { stderr?: string | Buffer; killed?: boolean };
  if (err.code === "ABORT_ERR") throw e; // the caller aborted — not a git failure
  // A killed child said nothing on stderr, so without this the message would be the empty one a
  // remote that never answered produces — the hardest failure to read of the two.
  if (err.killed === true) {
    throw new AppError("UPSTREAM", `git ${args[0] ?? ""} exceeded the ${budgetMs}ms budget`, {
      detail: { code: "TIMEOUT" },
      cause: e,
    });
  }
  const stderr = typeof err.stderr === "string" ? err.stderr : Buffer.isBuffer(err.stderr) ? err.stderr.toString("utf8") : "";
  const reason = stderr.trim() || err.message || "unknown error";
  throw new AppError("UPSTREAM", `git ${args[0] ?? ""} failed: ${reason}`, { detail: { code: String(err.code ?? "") }, cause: e });
}

export async function runGit(args: string[], opts: RunGitOptions): Promise<string> {
  const budgetMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  try {
    const { stdout } = await execFileP("git", args, {
      cwd: opts.cwd,
      env: childEnv(opts.env),
      maxBuffer: opts.maxBuffer ?? DEFAULT_MAX_BUFFER,
      timeout: budgetMs,
      windowsHide: true,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    return stdout;
  } catch (e) {
    fail(args, e, budgetMs);
  }
}

/**
 * Run `fn` with a child env that authenticates via a throwaway GIT_ASKPASS helper (the
 * token reaches git ONLY through the helper's stdout — never the URL, argv, or .git/config).
 * The helper is a 0700 script in a fresh mkdtemp dir, removed in a finally; the opened
 * credential buffer is zeroed as soon as its content has been copied into the script.
 */
export async function withAskpass<T>(
  credentialId: string | undefined,
  openCredential: ((credentialId: string) => Promise<Buffer>) | undefined,
  fn: (env: Record<string, string>) => Promise<T>,
): Promise<T> {
  if (!credentialId) return fn({});
  if (!openCredential) throw errValidation("a credentialId was given but no credential opener is wired into the git adapter");
  const token = await openCredential(credentialId);
  const dir = await mkdtemp(join(tmpdir(), "hostyour-askpass-"));
  try {
    const raw = token.toString("utf8").trim();
    token.fill(0);
    if (raw === "" || /[\r\n\0]/.test(raw)) throw errValidation("the opened git credential is empty or not a single-line token");
    const script = join(dir, "askpass.sh");
    // Single-quoted for sh; embedded single quotes become '\'' so the token can never break out.
    await writeFile(script, `#!/bin/sh\nprintf '%s\\n' '${raw.replace(/'/g, `'\\''`)}'\n`, { mode: 0o700 });
    return await fn({ GIT_ASKPASS: script });
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  }
}
