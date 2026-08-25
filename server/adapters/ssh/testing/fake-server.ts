import { Server, utils, type AuthContext, type ServerChannel } from "ssh2";
import { generateServerKeypair } from "../keygen.ts";

export interface FakeExec {
  stdout?: string;
  stderr?: string;
  code?: number;
  hang?: boolean; // never exit — used to exercise timeout/abort
}

/** One command answered by HOLDING THE CHANNEL OPEN — the server side of SshSession.openChannel.
 *  The handler is handed the exec stream (a Duplex whose reads are the client's writes) and drives
 *  both directions itself: echo bytes back, or pipe them to a real process's stdio or socket. It
 *  ends the conversation with stream.exit()+stream.end(); the fixture never does.
 *
 *  The type is exported because the handlers are written OUTSIDE adapters/, and `ServerChannel` is
 *  an ssh2 type that only this directory may name (`adapters-own-io-libs` in
 *  .dependency-cruiser.cjs). A caller elsewhere states this type and never reaches for the library. */
export type Conversation = (stream: ServerChannel) => void;

export interface FakeServerOptions {
  execTable?: Record<string, FakeExec>;
  conversations?: Record<string, Conversation>;
  acceptPassword?: string;
  authorizedKeys?: string[]; // OpenSSH public lines
  /** Emulate sshd's per-connection cap on CONCURRENT session channels (OpenSSH
   *  MaxSessions, default 10): further opens are REJECTED while this many are open —
   *  exactly the "(SSH) Channel open failure" a channel leak runs into. */
  maxSessions?: number;
}

export interface FakeSshServer {
  port: number;
  hostKeyFingerprint: string;
  close(): Promise<void>;
}

/**
 * In-process ssh2.Server fixture — the ONE backend reused by unit tests, e2e, and the
 * Playwright run. Not a security boundary: publickey auth accepts on a
 * key-blob match without verifying the signature (fine for a test server).
 *
 * The host key comes from generateServerKeypair, NOT from ssh2's generateKeyPairSync directly:
 * about 1 draw in 256 of the raw generator is a pair ssh2's own parser rejects, and `new Server`
 * parses hostKeys in its constructor, so an unchecked draw throws out of this function before it
 * can return. generateServerKeypair parses every draw back and redraws on a bad one.
 */
export async function startFakeSshServer(opts: FakeServerOptions = {}): Promise<FakeSshServer> {
  const hostKey = generateServerKeypair("fake-ssh-server");
  const authorizedBlobs = (opts.authorizedKeys ?? []).map((line) => {
    const b64 = line.trim().split(/\s+/)[1];
    return b64 ? Buffer.from(b64, "base64") : Buffer.alloc(0);
  });

  const server = new Server({ hostKeys: [hostKey.privateOpenSsh] }, (client) => {
    // sshd sets TCP_NODELAY on its side of the connection; without it every reply
    // (ssh2 writes one SSH packet as several small TCP segments) stalls behind the
    // client's delayed ACK. ssh2's Connection has setNoDelay; @types/ssh2 omits it.
    (client as unknown as { setNoDelay(noDelay?: boolean): void }).setNoDelay(true);
    client.on("authentication", (ctx: AuthContext) => {
      if (ctx.method === "password") {
        if (opts.acceptPassword !== undefined && ctx.password === opts.acceptPassword) ctx.accept();
        else ctx.reject();
      } else if (ctx.method === "keyboard-interactive") {
        if (opts.acceptPassword === undefined) {
          ctx.reject();
          return;
        }
        ctx.prompt([{ prompt: "Password: ", echo: false }], (answers) => {
          if (answers[0] === opts.acceptPassword) ctx.accept();
          else ctx.reject();
        });
      } else if (ctx.method === "publickey") {
        const matches = authorizedBlobs.some((blob) => blob.length > 0 && blob.equals(ctx.key.data));
        if (matches) ctx.accept();
        else ctx.reject();
      } else {
        ctx.reject();
      }
    });
    client.on("ready", () => {
      let openSessions = 0; // sshd's MaxSessions counts session channels until they CLOSE
      client.on("session", (accept, reject) => {
        if (opts.maxSessions !== undefined && openSessions >= opts.maxSessions) {
          reject();
          return;
        }
        openSessions += 1;
        let released = false;
        const session = accept();
        session.on("close", () => {
          if (!released) {
            released = true;
            openSessions -= 1;
          }
        });
        session.on("exec", (acceptExec, _reject, info) => {
          const stream = acceptExec();
          const conversation = opts.conversations?.[info.command];
          if (conversation) {
            conversation(stream);
            return;
          }
          const result = opts.execTable?.[info.command] ?? { code: 0 };
          if (result.stdout) stream.write(result.stdout);
          if (result.stderr) stream.stderr.write(result.stderr);
          if (!result.hang) {
            stream.exit(result.code ?? 0);
            stream.end();
          }
        });
        session.on("sftp", (acceptSftp) => {
          // Minimal write-only SFTP (what Ssh2Session.putFile needs): OPEN hands out a
          // dummy handle; WRITE/FSETSTAT/SETSTAT/CLOSE answer OK. Content is discarded —
          // the session tests assert channel lifecycle, not file bytes.
          const sftp = acceptSftp();
          const OK = utils.sftp.STATUS_CODE.OK;
          sftp.on("OPEN", (reqId: number) => sftp.handle(reqId, Buffer.from("h1")));
          sftp.on("WRITE", (reqId: number) => sftp.status(reqId, OK));
          sftp.on("FSETSTAT", (reqId: number) => sftp.status(reqId, OK));
          sftp.on("SETSTAT", (reqId: number) => sftp.status(reqId, OK));
          sftp.on("CLOSE", (reqId: number) => sftp.status(reqId, OK));
        });
      });
    });
    client.on("error", () => {
      /* client hangups during tests are expected */
    });
  });

  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve(addr && typeof addr === "object" ? addr.port : 0);
    });
  });

  return {
    port,
    hostKeyFingerprint: hostKey.fingerprint,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
