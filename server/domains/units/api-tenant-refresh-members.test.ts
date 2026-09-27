import { describe, it, expect, afterEach } from "vitest";
import { Hono } from "hono";
import { openDb, type DbHandle } from "../../db/client.ts";
import { servers, clusters, tenants } from "../../db/schema/inventory.ts";
import type { AppEnv } from "../../http/app-env.ts";
import type { Executor } from "../../executor/executor.ts";
import type { VersionsView } from "../../../shared/api-types.ts";
import { registerTenantRefreshMembersRoutes } from "./api-tenant-refresh-members.ts";
import { toApiError } from "../../http/middleware/error-shape.ts";

// The Versions dialog's routes: the GET answers what the reader answers, and the POST plans the run with
// the version chosen per part, refusing a body whose versions are no image tags before anything runs.

const TAG = "0.1.12-stable-20260925120000-abc1234";
const VIEW: VersionsView = { stage: "prod", parts: [{ name: "example-platform", builds: ["example-engine"], running: [TAG], versions: [{ tag: TAG, older: false }] }] };

describe("the Versions routes of a tenant", () => {
  let h: DbHandle;
  afterEach(() => h.sqlite.close());

  function route(versions?: (db: unknown, tenantId: string) => Promise<VersionsView>) {
    h = openDb(":memory:");
    h.db.insert(servers).values({ id: "srv_1", name: "m1", host: "1.2.3.4", sshUser: "root", role: "master", status: "healthy" }).run();
    h.db.insert(clusters).values({ id: "cls_1", serverId: "srv_1", stage: "prod", domain: "s1.example", name: "s1", status: "active" }).run();
    h.db.insert(tenants).values({ id: "tnt_1", clusterId: "cls_1", guid: "zsjs023ctne0", subdomain: "acme", stage: "prod", members: ["auth"], identityProvider: "auth", status: "active" }).run();
    const planned: unknown[] = [];
    const executor = { planStreamed: async (_kind: string, params: unknown) => { planned.push(params); return { runId: "run_1" }; } } as unknown as Executor;
    const app = new Hono<AppEnv>();
    app.onError((err, c) => { const { status, body } = toApiError(err); return c.json(body, status as 400); });
    registerTenantRefreshMembersRoutes(app, { db: h.db, executor, tenantEnabled: true, ...(versions ? { versions } : {}) });
    const post = async (body: unknown): Promise<Response> => app.request("/api/tenants/tnt_1/refresh-members", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { app, post, planned };
  }

  it("answers the versions the reader reads for the tenant, and 501 where no reader is wired", async () => {
    const asked: string[] = [];
    const r = route(async (_db, tenantId) => { asked.push(tenantId); return VIEW; });
    const res = await r.app.request("/api/tenants/tnt_1/versions");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(VIEW);
    expect(asked).toEqual(["tnt_1"]);
    h.sqlite.close();
    expect((await route().app.request("/api/tenants/tnt_1/versions")).status).toBe(501);
  });

  it("plans with the version chosen per part, with none where the body names none, and refuses a version that is no image tag", async () => {
    const r = route();
    expect((await r.post({ versions: { "example-platform": TAG } })).status).toBe(201);
    expect((await r.post({})).status).toBe(201);
    expect(r.planned).toEqual([{ tenantId: "tnt_1", versions: { "example-platform": TAG } }, { tenantId: "tnt_1", versions: {} }]);
    const bad = await r.post({ versions: { "example-platform": "0.1.12" } });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain("invalid versions request");
    expect(r.planned).toHaveLength(2);
  });
});
