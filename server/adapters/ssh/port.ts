// SSH transport contract. Only server/adapters/ssh imports ssh2 — the
// .dependency-cruiser.cjs `adapters-own-io-libs` rule enforces it. This file is pure types
// + error classes (no ssh2 import), so the executor can depend on the port, not the lib.

export interface SshTarget {
  host: string;
  port: number;
  username: string;
  auth:
    | { kind: "key"; privateKey: Buffer } // from the credential store (OpenSSH or PEM)
    | { kind: "password"; password: Buffer }; // adopt ceremony ONLY
  /** Pinned host key "SHA256:..." — hard-fail on mismatch. undefined = trust-on-first-use;
   *  the observed fingerprint is then read via hostKeyFingerprint() and recorded by the caller. */
  hostKeyFingerprint?: string;
  timeoutMs?: number; // connect timeout, default 15_000
}

export interface ExecOptions {
  signal: AbortSignal; // REQUIRED — no unabortable execs
  timeoutMs?: number; // per-command wall clock, default 120_000
  onStdout?: (line: string) => void; // line-buffered
  onStderr?: (line: string) => void;
  stdin?: Buffer; // e.g. sudo -S password — never logged
}

export interface ExecResult {
  code: number;
  signal?: string;
  stdoutTail: string;
  stderrTail: string;
}

export interface PortForward {
  localPort: number;
  close(): void;
}

export interface SshSession {
  /** exec + stream. Resolves with the exit code (does NOT throw on non-zero — callers
   *  assert, so a step controls its own pass/fail wording). Throws on transport error,
   *  ExecTimeoutError, or AbortError. */
  exec(command: string, opts: ExecOptions): Promise<ExecResult>;
  /** exec, throw ExecFailedError (with stderr tail) unless code===0. */
  mustExec(command: string, opts: ExecOptions): Promise<ExecResult>;
  putFile(remotePath: string, content: Buffer, mode: number, opts: { signal: AbortSignal }): Promise<void>;
  forwardLocalPort(remoteHost: string, remotePort: number): Promise<PortForward>;
  /** The host-key fingerprint observed on connect (trust-on-first-use recording). */
  hostKeyFingerprint(): string;
  /** Whether the transport is gone — closed here, or torn down by the client after its keepalives
   *  went unanswered. Every call on such a session rejects with the transport's own "not connected"
   *  error, so a caller that CACHES sessions must ask before it hands one out again. */
  isClosed(): boolean;
  close(): void;
}

export type SshFactory = (target: SshTarget) => Promise<SshSession>;

export class ExecFailedError extends Error {
  constructor(
    readonly code: number,
    readonly stderrTail: string,
    command: string,
  ) {
    super(`command failed (exit ${code}): ${command}`);
    this.name = "ExecFailedError";
  }
}

export class ExecTimeoutError extends Error {
  constructor(
    readonly timeoutMs: number,
    command: string,
  ) {
    super(`command timed out after ${timeoutMs}ms: ${command}`);
    this.name = "ExecTimeoutError";
  }
}

export class HostKeyMismatchError extends Error {
  constructor(
    readonly expected: string,
    readonly found: string,
  ) {
    super(`host key mismatch: expected ${expected}, got ${found} (possible MITM)`);
    this.name = "HostKeyMismatchError";
  }
}

export function sshAbortError(): Error {
  const e = new Error("ssh operation aborted");
  e.name = "AbortError";
  return e;
}
