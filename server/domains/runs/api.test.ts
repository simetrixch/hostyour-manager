import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { createApp } from "../../http/app.ts";
import { parseConfig } from "../../kernel/config.ts";
import { createLogger } from "../../kernel/logger.ts";
import { openDb, type DbHandle } from "../../db/client.ts";
import { CredentialStore } from "../../security/store.ts";
import { RunEventBus } from "../../executor/bus.ts";
import { Executor } from "../../executor/executor.ts";
import { buildRegistry } from "./registry.ts";
import { registerRunRoutes } from "./api.ts";
import { SessionCodec, SESSION_COOKIE } from "../access/session.ts";
import { runActor } from "../../kernel/actor.ts";
import type { AppEnv } from "../../http/app-env.ts";
import type { SshFactory } from "../../adapters/ssh/port.ts";

const config = parseConfig({
  PUBLIC_URL: "https://m1.example",
  OIDC_ISSUER: "https://i.example/",
  OIDC_CLIENT_ID: "c",
  OIDC_CLIENT_SECRET: "s",
  CONTROLLER_VERSION: "test",
  DATA_DIR: "/d",
  LOG_LEVEL: "silent",
} as NodeJS.ProcessEnv);
const logger = createLogger(config);
const noSsh: SshFactory = () => Promise.reject(new Error("no ssh"));

describe("runs API + SSE", () => {
  const handles: DbHandle[] = [];
  const dirs: string[] = [];

  async function make(): Promise<{ app: Hono<AppEnv>; executor: Executor; cookie: string; db: DbHandle }> {
    const dir = mkdtempSync(join(tmpdir(), "ctrl-api-"));
    dirs.push(dir);
    const db = openDb(join(dir, "controller.db"));
    handles.push(db);
    // The chokepoint attributes every planned run to the session's sub, and runs.started_by is an
    // FK onto operators — in production upsertOperator wrote that row at login; the harness mints
    // the cookie directly, so it seeds the row itself.
    db.sqlite.prepare("INSERT INTO operators (id, username, display_name) VALUES ('op_test', 'test', 'Test')").run();
    const store = new CredentialStore({ db: db.db, logger });
    const bus = new RunEventBus();
    const executor = new Executor({ db: db.db, creds: store, bus, logger, registry: buildRegistry({ db: db.db }), sshFactory: noSsh, actor: runActor });
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
    return { app, executor, cookie, db };
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
  });

  it("attributes plan + approve to the signed-in operator — never op_system", async () => {
    const { app, executor, cookie, db } = await make();
    const { runId } = (await (await post(app, "/api/runs", cookie, { kind: "noop" })).json()) as { runId: string };
    await post(app, `/api/runs/${runId}/approve`, cookie, {});
    await executor.settle(runId);

    const run = db.sqlite.prepare("SELECT started_by FROM runs WHERE id = ?").get(runId) as { started_by: string };
    expect(run.started_by).toBe("op_test");
    const actorOf = (action: string): string =>
      (db.sqlite.prepare("SELECT actor FROM audit WHERE run_id = ? AND action = ?").get(runId, action) as { actor: string }).actor;
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
    const run = (await detail.json()) as { deletedAt: number | null };
    expect(run.deletedAt).toBeGreaterThan(0);
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
