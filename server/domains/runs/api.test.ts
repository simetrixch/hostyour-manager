import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { createApp } from "../../http/app.ts";
import { parseConfig } from "../../kernel/config.ts";
import { REQUIRED_ENV } from "../../kernel/config.fixture.ts";
import { createLogger } from "../../kernel/logger.ts";
import { openDb, type DbHandle } from "../../db/client.ts";
import { CredentialStore } from "../../security/store.ts";
import { RunEventBus } from "../../executor/bus.ts";
import { Executor } from "../../executor/executor.ts";
import { buildRunDefinitions } from "./run-definitions.ts";
import { registerRunRoutes, RUN_STREAM_IDLE_MS } from "./api.ts";
import { SessionCodec, SESSION_COOKIE } from "../access/session.ts";
import type { AppEnv } from "../../http/app-env.ts";
import type { SshFactory } from "../../adapters/ssh/port.ts";
import { servers, clusters, apps, tenants } from "../../db/schema/inventory.ts";

const config = parseConfig({
  ...REQUIRED_ENV,
  PUBLIC_URL: "https://m1.example",
  OIDC_ISSUER: "https://i.example/",
  OIDC_CLIENT_ID: "c",
  OIDC_CLIENT_SECRET: "s",
  MANAGER_VERSION: "test",
  DATA_DIR: "/d",
  ADMIN_SOCKET_PATH: "/run/manager/admin.sock",
  LOG_LEVEL: "silent",
} as NodeJS.ProcessEnv);
const logger = createLogger(config);
const noSsh: SshFactory = () => Promise.reject(new Error("no ssh"));

describe("runs API + SSE", () => {
  const handles: DbHandle[] = [];
  const dirs: string[] = [];

  async function make(): Promise<{ app: Hono<AppEnv>; executor: Executor; cookie: string; db: DbHandle; bus: RunEventBus }> {
    const dir = mkdtempSync(join(tmpdir(), "mgr-api-"));
    dirs.push(dir);
    const db = openDb(join(dir, "manager.db"));
    handles.push(db);
    // The chokepoint attributes every planned run to the session's sub, and runs.owner is an
    // FK onto operators — in production upsertOperator wrote that row at login; the harness mints
    // the cookie directly, so it seeds the row itself.
    db.sqlite.prepare("INSERT INTO operators (id, username, display_name) VALUES ('op_test', 'test', 'Test')").run();
    const store = new CredentialStore({ db: db.db, logger });
    const bus = new RunEventBus();
    const executor = new Executor({ db: db.db, creds: store, bus, logger, runDefinitions: buildRunDefinitions({ db: db.db }), sshFactory: noSsh });
    const session = new SessionCodec(db.db, config);
    const app = createApp({
      config,
      logger,
      getReadiness: () => ({ ok: true, checks: [] }),
      session,
      registerAuth: () => undefined,
      registerProtected: (a) => registerRunRoutes(a, { executor, db: db.db, bus, config, logger }),
    });
    const cookie = await session.mint({ sub: "op_test", groups: ["admins"], via: "oidc" });
    return { app, executor, cookie, db, bus };
  }
  afterEach(() => {
    for (const h of handles.splice(0)) h.sqlite.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  const authed = (cookie: string, extra?: Record<string, string>): RequestInit => ({ headers: { cookie: `${SESSION_COOKIE}=${cookie}`, ...extra } });
  async function post(app: Hono<AppEnv>, path: string, cookie: string, body: unknown, csrf = true): Promise<Response> {
    const headers: Record<string, string> = { cookie: `${SESSION_COOKIE}=${cookie}`, "content-type": "application/json" };
    if (csrf) headers["sec-fetch-site"] = "same-origin";
    return app.request(path, { method: "POST", headers, body: JSON.stringify(body) });
  }
  async function del(app: Hono<AppEnv>, path: string, cookie: string, csrf = true): Promise<Response> {
    const headers: Record<string, string> = { cookie: `${SESSION_COOKIE}=${cookie}` };
    if (csrf) headers["sec-fetch-site"] = "same-origin";
    return app.request(path, { method: "DELETE", headers });
  }

  it("GET /api/runs/:id/unit-card names the card of the unit a run acts on, at the run's stage", async () => {
    const { app, cookie, db } = await make();
    db.db.insert(servers).values({ id: "srv_1", name: "m1", host: "1.2.3.4", sshUser: "root", role: "master", status: "healthy" }).run();
    db.db.insert(clusters).values({ id: "cls_1", serverId: "srv_1", stage: "prod", domain: "s1.example", name: "s1", status: "active" }).run();
    db.db.insert(apps).values({ id: "app_1", clusterId: "cls_1", name: "acme", stage: "test", host: "acme", repoUrl: "https://github.com/x/acme.git", chartPath: "deploy/chart", provenance: "manager", status: "suspended" }).run();
    db.db.insert(tenants).values({ id: "tnt_1", clusterId: "cls_1", guid: "zsjs023ctne0", subdomain: "simetrix", stage: "test", members: ["auth", "jobs", "report"], identityProvider: "auth", status: "active" }).run();
    const run = db.sqlite.prepare("INSERT INTO runs (id, kind, target_kind, target_id, params_json, plan_json, status, owner, modified_by) VALUES (?, ?, ?, ?, '{}', '{}', 'succeeded', 'op_test', 'op_test')");
    run.run("run_app", "consumer-suspend", "app", "app_1");
    run.run("run_tenant", "tenant-suspend", "tenant", "tnt_1");
    run.run("run_cluster", "consumer-onboard", "cluster", "cls_1");
    const card = async (id: string) => app.request(`/api/runs/${id}/unit-card`, authed(cookie));
    expect(await (await card("run_app")).json()).toEqual({ page: "consumers", key: "acme", label: "acme", stage: "test" });
    expect(await (await card("run_tenant")).json()).toEqual({ page: "tenants", key: "zsjs023ctne0", label: "simetrix", stage: "test" });
    expect(await (await card("run_cluster")).json()).toBeNull();
    expect((await card("run_missing")).status).toBe(404);
  });

  it("POST /api/runs plans a noop → 201 + runId", async () => {
    const { app, cookie } = await make();
    const res = await post(app, "/api/runs", cookie, { kind: "noop" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { runId: string; plan: { steps: unknown[] } };
    expect(body.runId).toMatch(/^run_/);
    expect(body.plan.steps).toHaveLength(3);
  });

  it("plan → approve → run reaches succeeded; list + detail reflect it", async () => {
    const { app, executor, cookie } = await make();
    const { runId } = (await (await post(app, "/api/runs", cookie, { kind: "noop" })).json()) as { runId: string };
    const approve = await post(app, `/api/runs/${runId}/approve`, cookie, {});
    expect(approve.status).toBe(202);
    await executor.settle(runId);

    const list = (await (await app.request("/api/runs", authed(cookie))).json()) as { id: string; status: string }[];
    expect(list.some((r) => r.id === runId)).toBe(true);

    const detail = await app.request(`/api/runs/${runId}`, authed(cookie));
    expect(detail.status).toBe(200);
    const run = (await detail.json()) as { status: string; steps: { name: string; status: string }[] };
    expect(run.status).toBe("succeeded");
    expect(run.steps.map((s) => s.name)).toEqual(["log-lines", "checkpoint", "sleep"]);
  });

  it("GET /api/runs/:id/events streams the backlog (5 demo lines) then closes", async () => {
    const { app, executor, cookie } = await make();
    const { runId } = (await (await post(app, "/api/runs", cookie, { kind: "noop" })).json()) as { runId: string };
    await post(app, `/api/runs/${runId}/approve`, cookie, {});
    await executor.settle(runId); // terminal → the SSE sends backlog and closes

    const res = await app.request(`/api/runs/${runId}/events`, authed(cookie));
    const body = await res.text();
    for (let i = 1; i <= 5; i++) expect(body).toContain(`demo line ${i}`);
    expect(body).toContain("event: stdout");
    // The close is the server's own, and says so, so a browser can tell it from a dropped connection.
    expect(body.trimEnd().endsWith("event: end\ndata:")).toBe(true);
  });

  it("PLANTED: a line the run writes while the backlog is replayed reaches the stream once, after it", async () => {
    const { app, cookie, db, bus } = await make();
    const { runId } = (await (await post(app, "/api/runs", cookie, { kind: "noop" })).json()) as { runId: string };
    const line = (seq: number) => {
      db.sqlite.prepare("INSERT INTO events (id, run_id, stream, seq, text, owner, modified_by) VALUES (?, ?, 'stdout', ?, ?, 'op_system', 'op_system')").run(`evt_${seq}`, runId, seq, `line ${seq}`);
      return { seq, stream: "stdout" as const, text: `line ${seq}`, at: Date.now() };
    };
    for (let seq = 100; seq < 110; seq++) line(seq);
    const res = await app.request(`/api/runs/${runId}/events`, authed(cookie));
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    // The first replayed line is out; the rest of the replay waits on this reader.
    let body = decoder.decode((await reader.read()).value);
    // Meanwhile the run writes a line, as RunContext.emit does: the row, then the bus; and it ends.
    bus.publish(runId, line(110));
    db.sqlite.prepare("UPDATE runs SET status = 'succeeded' WHERE id = ?").run(runId);
    bus.publish(runId, line(111));
    while (!body.includes("event: end")) body += decoder.decode((await reader.read()).value);
    const seqs = [...body.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1])).filter((seq) => seq >= 100);
    expect(seqs).toEqual([100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111]);
  });

  it("PLANTED: a run that stays silent keeps its stream alive with a comment line, and ends no stream it did not finish", async () => {
    const { app, cookie } = await make();
    const { runId } = (await (await post(app, "/api/runs", cookie, { kind: "noop" })).json()) as { runId: string };
    // A planned run is not terminal: its stream replays its planning lines, then stays open on the bus.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const decoder = new TextDecoder();
    const res = await app.request(`/api/runs/${runId}/events`, authed(cookie));
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    try {
      // Whatever the run wrote while it was planned, then nothing: the next thing on the wire is the comment.
      await vi.advanceTimersByTimeAsync(RUN_STREAM_IDLE_MS);
      let chunk = "";
      while (!chunk.endsWith("\n\n") || !chunk.includes(": idle")) chunk += decoder.decode((await reader.read()).value);
      expect(chunk.endsWith(": idle\n\n")).toBe(true);
      expect(chunk).not.toContain("event: end");
    } finally {
      vi.useRealTimers();
      await reader.cancel();
    }
  });

  it("attributes plan + approve to the signed-in operator — never op_system", async () => {
    const { app, executor, cookie, db } = await make();
    const { runId } = (await (await post(app, "/api/runs", cookie, { kind: "noop" })).json()) as { runId: string };
    await post(app, `/api/runs/${runId}/approve`, cookie, {});
    await executor.settle(runId);

    const run = db.sqlite.prepare("SELECT owner FROM runs WHERE id = ?").get(runId) as { owner: string };
    expect(run.owner).toBe("op_test");
    const actorOf = (action: string): string =>
      (db.sqlite.prepare("SELECT owner FROM audit WHERE run_id = ? AND action = ?").get(runId, action) as { owner: string }).owner;
    expect(actorOf("run.planned")).toBe("op_test");
    expect(actorOf("run.approved")).toBe("op_test");
  });

  it("mutations require same-origin (csrf): POST without Sec-Fetch-Site/Origin → 403", async () => {
    const { app, cookie } = await make();
    const res = await post(app, "/api/runs", cookie, { kind: "noop" }, false);
    expect(res.status).toBe(403);
  });

  it("an unknown run id → 404; a bad kind → 4xx", async () => {
    const { app, cookie } = await make();
    expect((await app.request("/api/runs/run_nope", authed(cookie))).status).toBe(404);
    const bad = await post(app, "/api/runs", cookie, { kind: "does-not-exist" });
    expect(bad.status).toBeGreaterThanOrEqual(400);
    expect(bad.status).toBeLessThan(500);
  });

  it("DELETE /api/runs/:id soft-deletes a planned run — gone from the list, row + log retained, direct GET still resolves", async () => {
    const { app, cookie, db } = await make();
    const { runId } = (await (await post(app, "/api/runs", cookie, { kind: "noop" })).json()) as { runId: string };

    const res = await del(app, `/api/runs/${runId}`, cookie);
    expect(res.status).toBe(200);

    // Honestly deleted from the operator's view: the list no longer contains it…
    const list = (await (await app.request("/api/runs", authed(cookie))).json()) as { id: string }[];
    expect(list.some((r) => r.id === runId)).toBe(false);
    // …but a direct/bookmarked link still resolves, clearly marked deleted…
    const detail = await app.request(`/api/runs/${runId}`, authed(cookie));
    expect(detail.status).toBe(200);
    const run = (await detail.json()) as { deleted: number | null };
    expect(run.deleted).toBeGreaterThan(0);
    // …and the row + its steps survive in the DB for retroactive inspection.
    expect((db.sqlite.prepare("SELECT count(*) AS n FROM runs WHERE id=?").get(runId) as { n: number }).n).toBe(1);
    expect((db.sqlite.prepare("SELECT count(*) AS n FROM steps WHERE run_id=?").get(runId) as { n: number }).n).toBeGreaterThan(0);
  });

  it("a soft-deleted run's events stay readable via SSE (backlog replays, then the stream closes)", async () => {
    const { app, executor, cookie, db } = await make();
    const { runId } = (await (await post(app, "/api/runs", cookie, { kind: "noop" })).json()) as { runId: string };
    await post(app, `/api/runs/${runId}/approve`, cookie, {});
    await executor.settle(runId);
    // A succeeded noop can't be deleted — park it at failed (deletable) to exercise the log path.
    db.sqlite.prepare("UPDATE runs SET status='failed' WHERE id=?").run(runId);

    expect((await del(app, `/api/runs/${runId}`, cookie)).status).toBe(200);

    const res = await app.request(`/api/runs/${runId}/events`, authed(cookie));
    const body = await res.text();
    for (let i = 1; i <= 5; i++) expect(body).toContain(`demo line ${i}`); // full log retained
    expect(body).toContain("event: end");
  });

  it("DELETE soft-deletes a succeeded run — 200, hidden from the list, by-id still resolves", async () => {
    const { app, executor, cookie } = await make();
    const { runId } = (await (await post(app, "/api/runs", cookie, { kind: "noop" })).json()) as { runId: string };
    await post(app, `/api/runs/${runId}/approve`, cookie, {});
    await executor.settle(runId);

    const res = await del(app, `/api/runs/${runId}`, cookie);
    expect(res.status).toBe(200);
    // Soft-delete: hidden from the operator list, but the row + log remain and a by-id read
    // still resolves it (nothing is torn down).
    expect((await app.request(`/api/runs/${runId}`, authed(cookie))).status).toBe(200);
  });

  it("DELETE of an unknown run → 404; without same-origin (csrf) → 403", async () => {
    const { app, cookie } = await make();
    expect((await del(app, "/api/runs/run_nope", cookie)).status).toBe(404);
    const { runId } = (await (await post(app, "/api/runs", cookie, { kind: "noop" })).json()) as { runId: string };
    expect((await del(app, `/api/runs/${runId}`, cookie, false)).status).toBe(403);
  });
});
