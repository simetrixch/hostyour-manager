// The typed client for the ansiwise REST surface — node:http over whatever carries the bytes.
//
// NOT a hand-rolled HTTP speaker: http.request takes any Duplex through an Agent's
// createConnection, so the parsing, chunked transfer and keep-alive are Node's own. ssh2 ships
// the same trick for its port-forward agents (ssh2/lib/http-agents.js), including the noop
// socket methods a non-socket stream has to grow — that file is the precedent this follows.
//
// ONE REQUEST AT A TIME, IN ORDER. The Agent takes maxSockets: 1, so requests queue on the one
// connection instead of interleaving. On a channel that is forced anyway — one conversation is one
// byte stream — and it is the honest shape besides: the serving loop answers strictly sequentially
// (channel_http_server.dart), so a second in-flight request would only wait invisibly on the
// machine instead of visibly here.

import http from "node:http";
import type { Duplex } from "node:stream";
import { z } from "zod";
import {
  AnsiwiseProgram, AnsiwiseRunAccepted, AnsiwiseRunRecord, AnsiwiseEvent,
  AnsiwiseRefused, AnsiwiseUnreachable, type AnsiwiseStart,
} from "./port.ts";

const ProgramList = z.object({ programs: z.array(AnsiwiseProgram) });
const RunList = z.object({ runs: z.array(AnsiwiseRunRecord) });

/** What Node's HTTP client calls on a socket that a bare Duplex does not have. The channel is
 *  not a TCP socket, so the TCP knobs become noops — exactly ssh2's decorateStream. */
function asSocket(stream: Duplex): Duplex {
  const s = stream as Duplex & Partial<Record<"setKeepAlive" | "setNoDelay" | "setTimeout" | "ref" | "unref" | "destroySoon", unknown>>;
  const noop = (): Duplex => s;
  s.setKeepAlive ??= noop;
  s.setNoDelay ??= noop;
  s.setTimeout ??= noop;
  s.ref ??= noop;
  s.unref ??= noop;
  s.destroySoon ??= (): void => void s.destroy();
  return s as Duplex;
}

/** An Agent whose one connection IS the conversation. keepAlive keeps the channel alive across
 *  requests; maxSockets: 1 queues them. The channel cannot be dialed again — when it is gone,
 *  every later request fails as unreachable and the caller opens a fresh conversation. */
class ChannelAgent extends http.Agent {
  #handedOut = false;

  constructor(private readonly conversation: Duplex) {
    super({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1 });
  }

  override createConnection(): Duplex {
    if (this.#handedOut || this.conversation.destroyed) {
      throw new AnsiwiseUnreachable("the conversation with the machine is over — open a fresh channel to speak again");
    }
    this.#handedOut = true;
    return asSocket(this.conversation);
  }
}

export interface AnsiwiseCallOptions {
  signal?: AbortSignal;
}

/** Never dialed — the agent ignores them — but they name the connection in Node's pool and in the
 *  Host header, so they are a word and not an address someone could mistake for one. */
const CONVERSATION = { host: "ansiwise", port: 80 };

export class AnsiwiseClient {
  readonly #agent: http.Agent;

  /** [conversation] is an ALREADY-OPEN exchange with `ansiwise-rest serve`, whose stdin and stdout
   *  are the connection — an SSH exec channel (SshSession.openChannel) in a run, the binary's own
   *  stdio in a test. Opening it is the caller's job; this client only speaks HTTP over it, and it
   *  takes nothing else: there is no address to dial and no credential to present, because sshd
   *  authenticated the caller before the process on the far side existed. */
  constructor(conversation: Duplex) {
    this.#agent = new ChannelAgent(conversation);
  }

  /** `GET /programs` — what this machine can be asked to run. */
  async programs(opts: AnsiwiseCallOptions = {}): Promise<AnsiwiseProgram[]> {
    return ProgramList.parse(await this.#json("GET", "/programs", undefined, opts)).programs;
  }

  /** `GET /programs/{name}` — one program with its declared answers, which is where the manager
   *  learns WHICH answers to compose instead of carrying a copy of the catalogue. */
  async program(name: string, opts: AnsiwiseCallOptions = {}): Promise<AnsiwiseProgram> {
    return AnsiwiseProgram.parse(await this.#json("GET", `/programs/${encodeURIComponent(name)}`, undefined, opts));
  }

  /** `GET /runs` — past and present runs, newest first. */
  async runs(opts: AnsiwiseCallOptions = {}): Promise<AnsiwiseRunRecord[]> {
    return RunList.parse(await this.#json("GET", "/runs", undefined, opts)).runs;
  }

  /** `GET /runs/{id}` — one run's record: the truth a caller judges an outcome on. */
  async run(id: string, opts: AnsiwiseCallOptions = {}): Promise<AnsiwiseRunRecord> {
    return AnsiwiseRunRecord.parse(await this.#json("GET", `/runs/${encodeURIComponent(id)}`, undefined, opts));
  }

  /** `POST /runs` — start one. Answers 202 the moment the run is GOING: the run is a detached
   *  process on the machine and outlives this connection, which is the whole point. */
  async start(start: AnsiwiseStart, opts: AnsiwiseCallOptions = {}): Promise<AnsiwiseRunAccepted> {
    const body: Record<string, unknown> = {
      program: start.program,
      mode: start.mode,
      ...(start.answers ? { answers: start.answers } : {}),
      ...(start.elevationPassword !== undefined ? { elevation_password: start.elevationPassword } : {}),
      ...(start.resumes !== undefined ? { resumes: start.resumes } : {}),
    };
    return AnsiwiseRunAccepted.parse(await this.#json("POST", "/runs", JSON.stringify(body), opts));
  }

  /** `GET /runs/{id}/events?from=N` — the run's events from a sequence number, as they happen.
   *  The stream ends when the run does; a finished run's events are read out and end at once.
   *  `from` is what makes a dropped connection cost nothing: sequences are dense and never
   *  reused, so a follower holding everything up to N re-attaches at N+1 — no gap, nothing
   *  twice. */
  async *events(id: string, opts: AnsiwiseCallOptions & { from?: number } = {}): AsyncGenerator<AnsiwiseEvent> {
    const path = `/runs/${encodeURIComponent(id)}/events?from=${opts.from ?? 0}`;
    const res = await this.#request("GET", path, undefined, opts);
    if ((res.statusCode ?? 0) >= 400) {
      throw refusalOf(res.statusCode ?? 0, await drained(res), path);
    }
    res.setEncoding("utf8");
    let buf = "";
    try {
      for await (const chunk of res) {
        buf += chunk as string;
        let cut;
        while ((cut = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, cut).trim();
          buf = buf.slice(cut + 1);
          if (line.length > 0) yield parsedEvent(line, path);
        }
      }
    } finally {
      // A follower that stops mid-stream cannot skip the rest of a chunked body without reading
      // it, so the connection is spent — destroy it rather than hand a half-read stream back to
      // the pool as reusable.
      if (!res.complete) res.destroy();
    }
    if (buf.trim().length > 0) yield parsedEvent(buf.trim(), path);
  }

  /** Release the connection. On a channel this ends the conversation and the remote command. */
  close(): void {
    this.#agent.destroy();
  }

  async #json(method: string, path: string, body: string | undefined, opts: AnsiwiseCallOptions): Promise<unknown> {
    const res = await this.#request(method, path, body, opts);
    const text = await drained(res);
    if ((res.statusCode ?? 0) >= 400) throw refusalOf(res.statusCode ?? 0, text, path);
    try {
      return JSON.parse(text);
    } catch {
      throw new AnsiwiseUnreachable(`the machine answered ${path} with something that is not JSON`);
    }
  }

  #request(method: string, path: string, body: string | undefined, opts: AnsiwiseCallOptions): Promise<http.IncomingMessage> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          agent: this.#agent,
          host: CONVERSATION.host,
          port: CONVERSATION.port,
          method,
          path,
          headers: {
            accept: "application/json, application/x-ndjson",
            ...(body === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(body) }),
          },
          ...(opts.signal ? { signal: opts.signal } : {}),
        },
        resolve,
      );
      req.on("error", (err: Error) => {
        // An abort is the caller's own act and keeps its name; everything else is the wire.
        reject(err.name === "AbortError" ? err : err instanceof AnsiwiseRefused || err instanceof AnsiwiseUnreachable ? err : new AnsiwiseUnreachable(`${method} ${path} did not reach the machine: ${err.message}`));
      });
      req.end(body);
    });
  }
}

function drained(res: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = "";
    res.setEncoding("utf8");
    res.on("data", (c: string) => (text += c));
    res.on("end", () => resolve(text));
    res.on("error", (err) => reject(new AnsiwiseUnreachable(`the answer broke off mid-body: ${err.message}`)));
  });
}

/** The machine's own refusal sentence, out of the `{"refused": ...}` body it writes. */
function refusalOf(status: number, body: string, path: string): AnsiwiseRefused {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed !== null && typeof parsed === "object" && typeof (parsed as { refused?: unknown }).refused === "string") {
      return new AnsiwiseRefused(status, (parsed as { refused: string }).refused);
    }
  } catch {
    // not JSON — the body is whatever it is and travels as it stands
  }
  return new AnsiwiseRefused(status, body.trim().length > 0 ? body.trim() : `the machine refused ${path} with ${status}`);
}

function parsedEvent(line: string, path: string): AnsiwiseEvent {
  try {
    return AnsiwiseEvent.parse(JSON.parse(line));
  } catch {
    throw new AnsiwiseUnreachable(`the machine wrote a line on ${path} that is not an event: ${line.slice(0, 200)}`);
  }
}
