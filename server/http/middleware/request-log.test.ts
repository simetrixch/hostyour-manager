import { describe, it, expect, afterEach } from "vitest";
import { pino } from "pino";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { streamSSE } from "hono/streaming";
import { createApp } from "../app.ts";
import { parseConfig } from "../../kernel/config.ts";
import { openDb, type DbHandle } from "../../db/client.ts";
import { SessionCodec, SESSION_COOKIE } from "../../domains/access/session.ts";
import { errNotFound } from "../../kernel/errors.ts";
import { requestSubject } from "./request-log.ts";

// WHAT AN OPERATOR CAN SEE WHEN A PAGE SAYS `Failed to fetch`.
//
// The log is the whole answer here: a request line per call, or silence that means "nothing arrived"
// and "everything was answered" at once. So this drives the REAL app — the middleware sits outermost
// in app.ts and its line has to cover the gate's refusals and the 404s too — and reads what pino
// actually wrote, never what the middleware was called with.
//
// The rule it is held to is the manager's standing one: a credential never reaches this log. A body
// and a query string are where one rides, so the line carries neither, and the counter-probes below
// send both and read the line back.

const config = parseConfig({
  PUBLIC_URL: "https://m1.example.com",
  OIDC_ISSUER: "https://idp.example/o/manager/",
  OIDC_CLIENT_ID: "manager",
  OIDC_CLIENT_SECRET: "secret",
  MANAGER_VERSION: "test",
  DATA_DIR: "/data",
  ADMIN_SOCKET_PATH: "/run/manager/admin.sock",
  LOG_LEVEL: "debug",
} as NodeJS.ProcessEnv);

interface Line {
  level: number;
  msg: string;
  method?: string;
  path?: string;
  status?: number;
  ms?: number;
  run?: string;
  server?: string;
}

const RUN_ID = "run_01J0000000000000000000000A";
const SERVER_ID = "srv_01J0000000000000000000000B";

describe("the request log", () => {
  const handles: DbHandle[] = [];
  const dirs: string[] = [];

  function make(): { app: ReturnType<typeof createApp>; session: SessionCodec; lines: Line[]; release: () => void } {
    const dir = mkdtempSync(join(tmpdir(), "mgr-reqlog-"));
    dirs.push(dir);
    const db = openDb(join(dir, "manager.db"));
    handles.push(db);
    const session = new SessionCodec(db.db, config);
    const lines: Line[] = [];
    const logger = pino({ level: "debug" }, { write: (s: string) => void lines.push(JSON.parse(s) as Line) });
    // The stream is held open until the test lets it go, which is how "the line is written when the
    // stream closes" is measured rather than assumed.
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const app = createApp({
      config,
      logger,
      getReadiness: () => ({ ok: true, checks: [] }),
      session,
      registerAuth: () => undefined,
      registerProtected: (a) => {
        a.get("/api/runs/:id", (c) => c.json({ id: c.req.param("id") }));
        a.get("/api/servers/:id", (c) => c.json({ id: c.req.param("id") }));
        a.get("/api/gone", () => {
          throw errNotFound("run rn_nothing");
        });
        a.get("/api/runs/:id/events", (c) => streamSSE(c, async (stream) => {
          await stream.writeSSE({ data: "one" });
          await held;
        }));
      },
    });
    return { app, session, lines, release };
  }
  afterEach(() => {
    for (const h of handles.splice(0)) h.sqlite.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  const admin = (session: SessionCodec): Promise<string> => session.mint({ sub: "op_x", groups: ["admins"], via: "oidc" });
  const requests = (lines: Line[]): Line[] => lines.filter((l) => l.msg === "request");

  it("writes method, path, status and duration for an answered call", async () => {
    const { app, session, lines } = make();
    const sealed = await admin(session);

    const res = await app.request(`/api/runs/${RUN_ID}`, { headers: { cookie: `${SESSION_COOKIE}=${sealed}` } });
    expect(res.status).toBe(200);

    expect(requests(lines)).toHaveLength(1);
    const line = requests(lines)[0]!;
    expect(line.method).toBe("GET");
    expect(line.path).toBe(`/api/runs/${RUN_ID}`);
    expect(line.status).toBe(200);
    expect(typeof line.ms).toBe("number");
    expect(line.run).toBe(RUN_ID);
  });

  it("names the run or the server the path carries, and neither where it carries none", () => {
    // Derived from the id itself (kernel/ids.ts prefixes), so a route added tomorrow is named
    // without a table here to keep in step with it.
    expect(requestSubject(`/api/runs/${RUN_ID}/events`)).toEqual({ run: RUN_ID });
    expect(requestSubject(`/api/servers/${SERVER_ID}/tailnet`)).toEqual({ server: SERVER_ID });
    expect(requestSubject("/api/servers")).toEqual({});
    // A segment carrying some other prefixed id is not a run and not a server, and is left unnamed
    // rather than written under a field it does not belong to.
    expect(requestSubject("/api/credentials/cred_01J000000000000000000000")).toEqual({});
  });

  it("counts a burst, which is what the incident behind this could not be shown from the outside", async () => {
    // 1734 GETs of one run is what a replayed event stream did to a real installation, and the
    // manager's log said exactly as much about it as it said about a pod nobody was calling.
    const { app, session, lines } = make();
    const sealed = await admin(session);
    for (let i = 0; i < 12; i++) await app.request(`/api/runs/${RUN_ID}`, { headers: { cookie: `${SESSION_COOKIE}=${sealed}` } });

    const forRun = requests(lines).filter((l) => l.run === RUN_ID);
    expect(forRun).toHaveLength(12);
  });

  it("carries no query string and no body — the two places a credential rides", async () => {
    const { app, session, lines } = make();
    const sealed = await admin(session);

    await app.request(`/api/runs/${RUN_ID}?after=5&token=sup3r-s3cret`, { headers: { cookie: `${SESSION_COOKIE}=${sealed}` } });
    await app.request("/api/runs", {
      method: "POST",
      headers: { cookie: `${SESSION_COOKIE}=${sealed}`, "content-type": "application/json", origin: config.publicUrl },
      body: JSON.stringify({ secrets: { password: "sup3r-s3cret" } }),
    });

    const written = JSON.stringify(requests(lines));
    expect(written).not.toContain("sup3r-s3cret");
    expect(written).not.toContain("after=5");
    expect(requests(lines)[0]!.path).toBe(`/api/runs/${RUN_ID}`);
  });

  it("reports a request the gate turned away, and one no route answers", async () => {
    // The middleware is outermost for this: a log that only saw what the chokepoint let through
    // could not tell a refusal from a request that never arrived.
    const { app, session, lines } = make();

    await app.request("/api/runs", { headers: { accept: "application/json" } });
    const outsider = await session.mint({ sub: "op_y", groups: ["users"], via: "oidc" });
    await app.request("/api/runs", { headers: { authorization: `Bearer ${outsider}`, accept: "application/json" } });
    await app.request("/api/nothing-here", { headers: { cookie: `${SESSION_COOKIE}=${await admin(session)}` } });

    expect(requests(lines).map((l) => l.status)).toEqual([401, 403, 404]);
  });

  it("reports the status a thrown failure is answered with, not silence", async () => {
    const { app, session, lines } = make();
    const sealed = await admin(session);

    const res = await app.request("/api/gone", { headers: { cookie: `${SESSION_COOKIE}=${sealed}`, accept: "application/json" } });
    expect(res.status).toBe(404);
    expect(requests(lines).map((l) => [l.path, l.status])).toEqual([["/api/gone", 404]]);
  });

  it("puts a probe at debug, so a level is all it takes to stop them drowning the log", async () => {
    const { app, lines } = make();
    await app.request("/healthz");
    await app.request("/readyz");

    const levels = requests(lines).map((l) => l.level);
    expect(levels).toEqual([20, 20]); // pino: 20 debug, 30 info
    // …and the counter-probe: an ordinary call on the same app is not at debug.
    await app.request("/api/runs", { headers: { accept: "application/json" } });
    expect(requests(lines).at(-1)?.level).toBe(30);
  });

  it("writes the line of a stream when the stream ENDS, and not when it opens", async () => {
    const { app, session, lines, release } = make();
    const sealed = await admin(session);

    const res = await app.request(`/api/runs/${RUN_ID}/events`, { headers: { cookie: `${SESSION_COOKIE}=${sealed}` } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    // The response is in hand and the body is still open: nothing is logged yet, because the
    // request is not over. A line here would report the time to open as the time the stream took.
    expect(requests(lines)).toHaveLength(0);

    release();
    expect(await res.text()).toContain("data: one");
    expect(requests(lines).map((l) => [l.path, l.status])).toEqual([[`/api/runs/${RUN_ID}/events`, 200]]);
    expect(requests(lines)[0]!.run).toBe(RUN_ID);
  });

  it("writes it for a stream the caller walked away from, which is the same request ending", async () => {
    const { app, session, lines, release } = make();
    const sealed = await admin(session);

    const res = await app.request(`/api/runs/${RUN_ID}/events`, { headers: { cookie: `${SESSION_COOKIE}=${sealed}` } });
    expect(requests(lines)).toHaveLength(0);
    await res.body!.cancel();
    release();

    expect(requests(lines).map((l) => [l.path, l.status])).toEqual([[`/api/runs/${RUN_ID}/events`, 200]]);
  });
});
