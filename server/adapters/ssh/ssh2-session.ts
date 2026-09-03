import { createServer, type Socket } from "node:net";
import { createHash } from "node:crypto";
import { Client, type ConnectConfig, type ClientChannel, type SFTPWrapper } from "ssh2";
import type { SshTarget, SshSession, ExecOptions, ExecResult, PortForward, SshFactory, ChannelOptions, SshChannel } from "./port.ts";
import { AuthFailedError, ExecFailedError, ExecTimeoutError, HostKeyMismatchError, sshAbortError } from "./port.ts";

const CONNECT_TIMEOUT_DEFAULT = 15_000;
const EXEC_TIMEOUT_DEFAULT = 120_000;
const TAIL_CAP = 4_000;

function hostKeyFp(key: Buffer): string {
  return "SHA256:" + createHash("sha256").update(key).digest("base64").replace(/=+$/, "");
}

function appendTail(tail: string, chunk: string): string {
  const combined = tail + chunk;
  return combined.length > TAIL_CAP ? combined.slice(combined.length - TAIL_CAP) : combined;
}

interface Connected {
  client: Client;
  fingerprint: string;
}

/** WHICH failure a connect met, read off the one field that says so. ssh2 reports every failure as a
 *  bare `Error` and puts the kind in a non-standard `level` property (node_modules/ssh2/lib/client.js).
 *  `client-authentication` is the level the MACHINE decided: the socket connected, the host key
 *  passed the verifier, and the server turned down every method, which the library reports as "All
 *  configured authentication methods failed". Every other level — `client-socket`, `client-dns`,
 *  `client-timeout`, `protocol`, `handshake` — is the transport failing to reach any verdict, and it
 *  is left as the bare Error it arrives as, because that is the distinction a caller falls back on:
 *  a second credential may be offered to a machine that refused the first, and never to a machine
 *  that was never reached. */
function classifyConnectError(err: Error, target: SshTarget): Error {
  const level = (err as { level?: string }).level;
  return level === "client-authentication" ? new AuthFailedError(target.username, err) : err;
}

function connect(target: SshTarget): Promise<Connected> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let fingerprint = "";
    let mismatch: HostKeyMismatchError | undefined;
    const password = target.auth.kind === "password" ? target.auth.password : undefined;

    const cfg: ConnectConfig = {
      host: target.host,
      port: target.port,
      username: target.username,
      readyTimeout: target.timeoutMs ?? CONNECT_TIMEOUT_DEFAULT,
      keepaliveInterval: 10_000,
      keepaliveCountMax: 3,
      hostVerifier: (key: Buffer): boolean => {
        fingerprint = hostKeyFp(key);
        if (target.hostKeyFingerprint && target.hostKeyFingerprint !== fingerprint) {
          mismatch = new HostKeyMismatchError(target.hostKeyFingerprint, fingerprint);
          return false;
        }
        return true;
      },
    };
    if (target.auth.kind === "key") cfg.privateKey = target.auth.privateKey;
    else {
      cfg.password = target.auth.password.toString("utf8");
      cfg.tryKeyboard = true;
    }

    if (password) {
      // Ubuntu sshd often has PasswordAuthentication no but keyboard-interactive on, so a password
      // door that answers at all may answer only here.
      client.on("keyboard-interactive", (_name, _instr, _lang, _prompts, finish) => finish([password.toString("utf8")]));
    }
    client.on("ready", () => resolve({ client, fingerprint }));
    // The mismatch WINS over whatever the library says next. A verifier that refuses ends the
    // connection, and the error the client then emits describes the ending rather than the reason
    // for it — so the reason is held from the verifier and handed back in its place.
    client.on("error", (err: Error) => reject(mismatch ?? classifyConnectError(err, target)));
    client.connect(cfg);
    // ssh2 leaves Nagle on and writes one SSH packet as several small TCP segments,
    // so without TCP_NODELAY every packet can stall behind the peer's delayed ACK
    // (~40ms each). OpenSSH sets it on its sockets; match it.
    client.setNoDelay(true);
  });
}

class Ssh2Session implements SshSession {
  // ssh2 ends the client after keepaliveCountMax unanswered keepalives (see connect), and a command
  // that takes the host's own networking down outlives that window. From that moment every exec and
  // every putFile rejects with "Not connected", so the teardown is remembered here — a cache that
  // could not ask would go on handing the dead client to every remaining step of the run.
  private gone = false;

  constructor(
    private readonly client: Client,
    private readonly fp: string,
  ) {
    client.on("close", () => {
      this.gone = true;
    });
    client.on("error", () => {
      this.gone = true;
    });
  }

  hostKeyFingerprint(): string {
    return this.fp;
  }

  isClosed(): boolean {
    return this.gone;
  }

  exec(command: string, opts: ExecOptions): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
      if (opts.signal.aborted) {
        reject(sshAbortError());
        return;
      }
      const timeoutMs = opts.timeoutMs ?? EXEC_TIMEOUT_DEFAULT;
      // The abort listener goes on BEFORE client.exec: the channel open is a real
      // network round trip, and an abort that fires during it would otherwise land on
      // an already-aborted signal inside the callback and never fire — the exec would
      // then sit out its full timeout. The stream does not exist yet at that point,
      // so the callback releases a late-arriving channel itself.
      let stream: ClientChannel | undefined;
      let timer: NodeJS.Timeout | undefined;
      let settled = false;
      const done = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        opts.signal.removeEventListener("abort", onAbort);
        fn();
      };
      const onAbort = (): void =>
        done(() => {
          stream?.close();
          reject(sshAbortError());
        });
      opts.signal.addEventListener("abort", onAbort);
      this.client.exec(command, (err, s) => {
        if (err) {
          done(() => reject(err));
          return;
        }
        if (settled) {
          s.close(); // aborted while the open was in flight — release the channel
          return;
        }
        stream = s;
        let outBuf = "";
        let errBuf = "";
        let outTail = "";
        let errTail = "";
        timer = setTimeout(
          () =>
            done(() => {
              s.close();
              reject(new ExecTimeoutError(timeoutMs, command));
            }),
          timeoutMs,
        );

        s.on("data", (d: Buffer) => {
          const text = d.toString("utf8");
          outTail = appendTail(outTail, text);
          const lines = (outBuf + text).split("\n");
          outBuf = lines.pop() ?? "";
          for (const line of lines) opts.onStdout?.(line);
        });
        s.stderr.on("data", (d: Buffer) => {
          const text = d.toString("utf8");
          errTail = appendTail(errTail, text);
          const lines = (errBuf + text).split("\n");
          errBuf = lines.pop() ?? "";
          for (const line of lines) opts.onStderr?.(line);
        });
        s.on("close", (code: number | null, signal?: string) =>
          done(() => {
            if (outBuf) opts.onStdout?.(outBuf);
            if (errBuf) opts.onStderr?.(errBuf);
            resolve({ code: code ?? -1, ...(signal ? { signal } : {}), stdoutTail: outTail, stderrTail: errTail });
          }),
        );
        s.on("error", (e: Error) => done(() => reject(e)));
        if (opts.stdin) s.end(opts.stdin);
        else s.end();
      });
    });
  }

  async mustExec(command: string, opts: ExecOptions): Promise<ExecResult> {
    const r = await this.exec(command, opts);
    if (r.code !== 0) throw new ExecFailedError(r.code, r.stderrTail, command);
    return r;
  }

  /** The conversation form of exec (see the port): the channel is handed back with stdin OPEN,
   *  and it stays open until close() or abort. No timeout — a conversation has no single command
   *  to time; the caller bounds its own work. The abort listener goes on before client.exec for
   *  the same reason exec()'s does, and it stays on for the channel's whole life: an abort after
   *  the open must still tear the conversation down, or the remote command outlives the run that
   *  started it on the manager's side of the wire. */
  openChannel(command: string, opts: ChannelOptions): Promise<SshChannel> {
    return new Promise((resolve, reject) => {
      if (opts.signal.aborted) {
        reject(sshAbortError());
        return;
      }
      let stream: ClientChannel | undefined;
      let settled = false;
      const onAbort = (): void => {
        stream?.close();
        if (!settled) {
          settled = true;
          reject(sshAbortError());
        }
      };
      opts.signal.addEventListener("abort", onAbort);
      this.client.exec(command, (err, s) => {
        if (err) {
          if (!settled) {
            settled = true;
            opts.signal.removeEventListener("abort", onAbort);
            reject(err);
          }
          return;
        }
        if (settled) {
          s.close(); // aborted while the open was in flight — release the channel
          return;
        }
        settled = true;
        stream = s;
        let errBuf = "";
        s.stderr.on("data", (d: Buffer) => {
          const lines = (errBuf + d.toString("utf8")).split("\n");
          errBuf = lines.pop() ?? "";
          for (const line of lines) opts.onStderr?.(line);
        });
        s.on("close", () => {
          if (errBuf) opts.onStderr?.(errBuf);
          opts.signal.removeEventListener("abort", onAbort);
        });
        resolve({ stream: s, close: () => s.close() });
      });
    });
  }

  /** Upload one file over a THROWAWAY SFTP channel, released the moment the write settles.
   *  client.sftp() opens a NEW session channel per call, and sshd caps CONCURRENT channels
   *  per connection (OpenSSH MaxSessions, default 10) — exec channels close with their
   *  command, but an un-end()ed SFTP channel stays open for the connection's lifetime.
   *  Before this cleanup every putFile leaked its channel, so a long polling step that
   *  uploads a diagnostic script each minute (verify-slave) exhausted the cap after ~10
   *  uploads and every later channel open died with "(SSH) Channel open failure". */
  putFile(remotePath: string, content: Buffer, mode: number, opts: { signal: AbortSignal }): Promise<void> {
    return new Promise((resolve, reject) => {
      if (opts.signal.aborted) {
        reject(sshAbortError());
        return;
      }
      // Same abort window as exec: the sftp channel open is a round trip during which
      // an abort must still reject, so the listener is registered before client.sftp
      // and the callback end()s a late-arriving channel itself.
      let sftp: SFTPWrapper | undefined;
      let ws: ReturnType<SFTPWrapper["createWriteStream"]> | undefined;
      let settled = false;
      const done = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        opts.signal.removeEventListener("abort", onAbort);
        try {
          sftp?.end(); // release the channel — sshd counts it against MaxSessions until closed
        } catch {
          /* channel already torn down with the connection */
        }
        fn();
      };
      const onAbort = (): void => {
        ws?.destroy();
        done(() => reject(sshAbortError()));
      };
      opts.signal.addEventListener("abort", onAbort, { once: true });
      this.client.sftp((err, s) => {
        if (err) {
          done(() => reject(err));
          return;
        }
        if (settled) {
          try {
            s.end(); // aborted while the open was in flight — release the channel
          } catch {
            /* channel already torn down with the connection */
          }
          return;
        }
        sftp = s;
        ws = s.createWriteStream(remotePath, { mode });
        ws.on("close", () => done(resolve));
        ws.on("error", (e: Error) => done(() => reject(e)));
        ws.end(content);
      });
    });
  }

  forwardLocalPort(remoteHost: string, remotePort: number): Promise<PortForward> {
    return new Promise((resolve, reject) => {
      const server = createServer((socket: Socket) => {
        this.client.forwardOut(socket.remoteAddress ?? "127.0.0.1", socket.remotePort ?? 0, remoteHost, remotePort, (err, channel) => {
          if (err) {
            socket.destroy();
            return;
          }
          socket.pipe(channel).pipe(socket);
        });
      });
      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        resolve({ localPort: addr && typeof addr === "object" ? addr.port : 0, close: () => server.close() });
      });
    });
  }

  close(): void {
    this.gone = true;
    try {
      this.client.end();
    } catch {
      /* already closed */
    }
  }
}

export const createSshSession: SshFactory = async (target) => {
  const { client, fingerprint } = await connect(target);
  return new Ssh2Session(client, fingerprint);
};
