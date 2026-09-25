import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./app.ts";
import { parseConfig } from "../kernel/config.ts";
import { REQUIRED_ENV } from "../kernel/config.fixture.ts";
import { createLogger } from "../kernel/logger.ts";
import { openDb, type DbHandle } from "../db/client.ts";
import { SessionCodec, SESSION_COOKIE } from "../domains/access/session.ts";
import type { Executor } from "../executor/executor.ts";
import type { PluginsView } from "../../shared/api-types.ts";
import { registerPluginRoutes } from "./plugins-route.ts";

const config = parseConfig({
  ...REQUIRED_ENV,
  PUBLIC_URL: "https://m1.example", OIDC_ISSUER: "https://i.example/", OIDC_CLIENT_ID: "c", OIDC_CLIENT_SECRET: "s",
  MANAGER_VERSION: "test", DATA_DIR: "/d", LOG_LEVEL: "silent", ADMIN_SOCKET_PATH: "/run/manager/admin.sock",
} as NodeJS.ProcessEnv);
const logger = createLogger(config);

describe("the routes of the active plugins", () => {
  const handles: DbHandle[] = [];
  const dirs: string[] = [];
  afterEach(() => {
    for (const h of handles.splice(0)) h.sqlite.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  async function make() {
    const dir = mkdtempSync(join(tmpdir(), "mgr-plugins-"));
    dirs.push(dir);
    const db = openDb(join(dir, "manager.db"));
    handles.push(db);
    const session = new SessionCodec(db.db, config);
    const active = [
      { name: "probe", wiring: { definitions: [], routes: (a: Parameters<typeof registerPluginRoutes>[0]) => void a.get("/hello", (c) => c.json({ from: "probe" })) } },
      { name: "quiet", wiring: { definitions: [] } },
    ];
    // The routes below never reach the executor.
    const executor = {} as Executor;
    const app = createApp({
      config, logger, getReadiness: () => ({ ok: true, checks: [] }), session,
      registerAuth: () => undefined,
      registerProtected: (a) => registerPluginRoutes(a, active, { executor }),
    });
    return { app, cookie: `${SESSION_COOKIE}=${await session.mint({ sub: "op_test", groups: ["admins"], via: "oidc" })}` };
  }

  it("serves a plugin's routes under /api/<its name>, behind the chokepoint", async () => {
    const { app, cookie } = await make();
    expect((await app.request("/api/probe/hello")).status).toBe(401);
    const res = await app.request("/api/probe/hello", { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ from: "probe" });
  });

  it("names the active plugins to a signed-in operator, and to nobody else", async () => {
    const { app, cookie } = await make();
    expect((await app.request("/api/plugins")).status).toBe(401);
    const res = await app.request("/api/plugins", { headers: { cookie } });
    expect(res.status).toBe(200);
    expect((await res.json()) as PluginsView).toEqual({ active: ["probe", "quiet"] });
  });
});
