import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { createApp } from "../../http/app.ts";
import { parseConfig } from "../../kernel/config.ts";
import { createLogger } from "../../kernel/logger.ts";
import { openDb, type DbHandle } from "../../db/client.ts";
import { SessionCodec, SESSION_COOKIE } from "../access/session.ts";
import { acquireLocks } from "../../executor/locks.ts";
import { registerClustersRoutes } from "./api.ts";
import type { AppEnv } from "../../http/app-env.ts";
import type { ClustersView, LockView, StoreMode } from "../../../shared/api-types.ts";

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

describe("clusters + locks API", () => {
  const handles: DbHandle[] = [];
  const dirs: string[] = [];

  async function make(storeMode: StoreMode = "plaintext"): Promise<{ app: Hono<AppEnv>; db: DbHandle; cookie: string }> {
    const dir = mkdtempSync(join(tmpdir(), "ctrl-clusters-"));
    dirs.push(dir);
    const db = openDb(join(dir, "controller.db"));
    handles.push(db);
    const session = new SessionCodec(db.db, config);
    const app = createApp({
      config,
      logger,
      getReadiness: () => ({ ok: true, checks: [] }),
      session,
      registerAuth: () => undefined,
      registerProtected: (a) => registerClustersRoutes(a, { db: db.db, storeMode: () => storeMode, logger }),
    });
    const cookie = await session.mint({ sub: "op_test", groups: ["admins"], via: "oidc" });
    return { app, db, cookie };
  }
  afterEach(() => {
    for (const h of handles.splice(0)) h.sqlite.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  const authed = (cookie: string): RequestInit => ({ headers: { cookie: `${SESSION_COOKIE}=${cookie}` } });

  it("GET /api/clusters → 200, storeMode + honest source wiring, empty on a fresh DB", async () => {
    const { app, cookie } = await make();
    const res = await app.request("/api/clusters", authed(cookie));
    expect(res.status).toBe(200);
    const clusters = (await res.json()) as ClustersView;
    expect(clusters.storeMode).toBe("plaintext");
    expect(clusters.servers).toEqual([]);
    expect(clusters.master).toBeNull();
    expect(clusters.needsYou).toEqual([]);
    expect(clusters.verdict).toBe("ok");
    expect(clusters.sources.inventory).toBe("ok");
    expect(clusters.sources.argo).toBe("unwired");
  });

  it("the master (this controller) is NOT a managed server — never in clusters.servers, rides clusters.master", async () => {
    const { app, db, cookie } = await make();
    db.sqlite
      .prepare("INSERT INTO servers (id, name, host, ssh_user, role, status, notes) VALUES ('srv_m','m1','1.2.3.4','root','master','ready','secret-notes')")
      .run();
    const clusters = (await (await app.request("/api/clusters", authed(cookie))).json()) as ClustersView;
    expect(clusters.servers).toEqual([]); // manages nothing yet — the master must not count
    expect(clusters.master?.name).toBe("m1");
    expect(clusters.master?.role).toBe("master");
    // projection is the trust boundary on the master row too
    expect(clusters.master).not.toHaveProperty("notes");
    expect(clusters.master).not.toHaveProperty("preflightJson");
  });

  it("a master + a slave → servers counts the slave only (with only ServerView fields, no secrets/notes)", async () => {
    const { app, db, cookie } = await make();
    db.sqlite
      .prepare("INSERT INTO servers (id, name, host, ssh_user, role, status, notes) VALUES ('srv_m','m1','1.2.3.4','root','master','ready','secret-notes')")
      .run();
    db.sqlite
      .prepare("INSERT INTO servers (id, name, host, ssh_user, role, status, notes) VALUES ('srv_s','s1','5.6.7.8','root','slave','ready','slave-notes')")
      .run();
    const clusters = (await (await app.request("/api/clusters", authed(cookie))).json()) as ClustersView;
    expect(clusters.servers).toHaveLength(1);
    expect(clusters.servers.map((s) => s.id)).not.toContain("srv_m");
    const s = clusters.servers[0];
    expect(s?.name).toBe("s1");
    expect(s?.role).toBe("slave");
    expect(s).not.toHaveProperty("notes");
    expect(s).not.toHaveProperty("preflightJson");
    expect(clusters.master?.id).toBe("srv_m");
  });

  it("a planned run lands in needsYou and flips the verdict to warn", async () => {
    const { app, db, cookie } = await make();
    db.sqlite
      .prepare("INSERT INTO runs (id, kind, target_kind, target_id, params_json, plan_json, status, started_by) VALUES ('run_p','noop','self','controller','{}','{\"summary\":\"x\"}','planned','op_system')")
      .run();
    const clusters = (await (await app.request("/api/clusters", authed(cookie))).json()) as ClustersView;
    expect(clusters.needsYou.map((r) => r.id)).toContain("run_p");
    expect(clusters.verdict).toBe("warn");
  });

  it("GET /api/locks → [] then reflects an acquired lock", async () => {
    const { app, db, cookie } = await make();
    expect((await (await app.request("/api/locks", authed(cookie))).json()) as LockView[]).toEqual([]);
    db.sqlite
      .prepare("INSERT INTO runs (id, kind, target_kind, target_id, params_json, plan_json, status, started_by) VALUES ('run_l','noop','server','srv','{}','{}','approved','op_system')")
      .run();
    acquireLocks(db.db, "run_l", [{ resource: "server", key: "s1" }]);
    const locks = (await (await app.request("/api/locks", authed(cookie))).json()) as LockView[];
    expect(locks).toHaveLength(1);
    expect(locks[0]).toMatchObject({ resource: "server", key: "s1", runId: "run_l" });
  });

  it("unauthenticated → 401", async () => {
    const { app } = await make();
    expect((await app.request("/api/clusters", { headers: { accept: "application/json" } })).status).toBe(401);
  });
});
