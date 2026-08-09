// gate-runner/src/exec.ts
// The runner's ONE way to run a subprocess (helm, kubeconform). NEVER a shell — execFile with an
// argv array, so a consumer-controlled string can never be interpreted by a shell. Output is
// size-capped (fail-closed against a stdout-flood) and time-boxed to the phase budget; on breach
// the child is killed and the call rejects with a typed ExecError the pipeline turns into a gate/job
// failure. No matches are ever parsed out of stdout — each gate inspects files/rendered YAML directly.
import { execFile } from "node:child_process";

export interface ExecResult {
  stdout: string;
  stderr: string;
}

export type ExecFailureKind = "timeout" | "oversize" | "exit";

export class ExecError extends Error {
  constructor(
    message: string,
    readonly kind: ExecFailureKind,
    readonly code: number | null,
    readonly stderr: string,
  ) {
    super(message);
    this.name = "ExecError";
  }
}

export interface ExecOptions {
  cwd?: string;
  timeoutMs: number;
  maxBytes: number; // cap on combined stdout/stderr; exceeding it fails closed
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
}

export function run(bin: string, args: string[], opts: ExecOptions): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      {
        timeout: opts.timeoutMs,
        maxBuffer: opts.maxBytes,
        windowsHide: true,
        ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
        ...(opts.env !== undefined ? { env: opts.env } : {}),
      },
      (err, stdout, stderr) => {
        const out = String(stdout);
        const errText = String(stderr);
        if (err === null) {
          resolve({ stdout: out, stderr: errText });
          return;
        }
        const e = err as NodeJS.ErrnoException & { killed?: boolean };
        if (e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
          reject(new ExecError(`${bin} output exceeded ${opts.maxBytes} bytes (fail-closed)`, "oversize", null, errText));
        } else if (e.killed) {
          reject(new ExecError(`${bin} exceeded the ${opts.timeoutMs}ms budget`, "timeout", null, errText));
        } else {
          const code = typeof e.code === "number" ? e.code : null;
          reject(new ExecError(`${bin} exited ${code ?? "abnormally"}: ${errText.slice(0, 500)}`, "exit", code, errText));
        }
      },
    );
  });
}
