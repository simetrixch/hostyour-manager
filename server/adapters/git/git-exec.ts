// Shell-free git execution + the GIT_ASKPASS credential bridge for the git adapter.
// Every git the adapter runs goes through runGit: argv arrays via execFile (never
// a shell string, never a shell at all), a hardened child env (prompts off, credential helpers
// off, autocrlf off so bytes round-trip verbatim), and failures surfaced as an AppError that
// carries git's stderr verbatim. withAskpass materializes a read token as a 0700 one-shot
// helper script so the credential NEVER appears in the repo URL, in argv, or in .git/config.
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { AppError, errValidation } from "../../kernel/errors.ts";

const execFileP = promisify(execFile);
const DEFAULT_MAX_BUFFER = 32 * 1024 * 1024;

export interface RunGitOptions {
  cwd: string;
  /** Extra env merged over process.env (e.g. GIT_ASKPASS from withAskpass). */
  env?: Record<string, string>;
  signal?: AbortSignal;
  maxBuffer?: number;
}

// Prompts hard-off (a wedged fetch must fail, not hang), configured credential helpers disabled
// (the ONLY credential path is the askpass helper), byte-verbatim text handling, no signing.
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

function fail(args: readonly string[], e: unknown): never {
  const err = e as NodeJS.ErrnoException & { stderr?: string | Buffer };
  if (err.code === "ABORT_ERR") throw e; // the caller aborted — not a git failure
  const stderr = typeof err.stderr === "string" ? err.stderr : Buffer.isBuffer(err.stderr) ? err.stderr.toString("utf8") : "";
  const reason = stderr.trim() || err.message || "unknown error";
  throw new AppError("UPSTREAM", `git ${args[0] ?? ""} failed: ${reason}`, { detail: { code: String(err.code ?? "") }, cause: e });
}

export async function runGit(args: string[], opts: RunGitOptions): Promise<string> {
  try {
    const { stdout } = await execFileP("git", args, {
      cwd: opts.cwd,
      env: childEnv(opts.env),
      maxBuffer: opts.maxBuffer ?? DEFAULT_MAX_BUFFER,
      windowsHide: true,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    return stdout;
  } catch (e) {
    fail(args, e);
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
