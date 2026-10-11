import { describe, it, expect, afterEach } from "vitest";
import { Hono } from "hono";
import { openDb, type DbHandle } from "../../db/client.ts";
import { servers, clusters, tenants } from "../../db/schema/inventory.ts";
import type { AppEnv } from "../../http/app-env.ts";
import type { Executor } from "../../executor/executor.ts";
import { registerTenantWebsiteSiteRoutes } from "./api-tenant-website-site.ts";
import { toApiError } from "../../http/middleware/error-shape.ts";

// The route shapes the request, the run's planner holds the rules: one site and one bundle release,
// trimmed and in lower case, for the website the path names.

describe("POST /api/tenants/:id/websites/:app/site", () => {
  let h: DbHandle;
  afterEach(() => h.sqlite.close());

  function route(): { post: (body: unknown) => Promise<Response>; planned: unknown[] } {
    h = openDb(":memory:");
    h.db.insert(servers).values({ id: "srv_1", name: "m1", host: "1.2.3.4", sshUser: "root", role: "master", status: "healthy" }).run();
    h.db.insert(clusters).values({ id: "cls_1", serverId: "srv_1", stage: "prod", domain: "s1.example", name: "s1", status: "active" }).run();
    h.db.insert(tenants).values({ id: "tnt_1", clusterId: "cls_1", guid: "zsjs023ctne0", subdomain: "acme", stage: "prod", members: ["auth"], identityProvider: "auth", identityProviderPath: "/auth", status: "active" }).run();
    const planned: unknown[] = [];
    const executor = { planStreamed: async (_kind: string, params: unknown) => { planned.push(params); return { runId: "run_1" }; } } as unknown as Executor;
    const app = new Hono<AppEnv>();
    app.onError((err, c) => { const { status, body } = toApiError(err); return c.json(body, status as 400); });
    registerTenantWebsiteSiteRoutes(app, { db: h.db, executor, tenantEnabled: true });
    const post = async (body: unknown): Promise<Response> => app.request("/api/tenants/tnt_1/websites/example-ch/site", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { post, planned };
  }

  it("plans the move of the website the path names to the body's site on the body's bundle release", async () => {
    const r = route();
    expect((await r.post({ site: " Renamed ", appsImageTag: " 0.1.1-stable-20260201000000-def5678 " })).status).toBe(201);
    expect(r.planned).toEqual([{ tenantId: "tnt_1", app: "example-ch", site: "renamed", appsImageTag: "0.1.1-stable-20260201000000-def5678" }]);
  });

  it("refuses a body without a site, or with a bundle release that is no image tag", async () => {
    const r = route();
    expect((await r.post({ appsImageTag: "0.1.1-stable-20260201000000-def5678" })).status).toBe(400);
    expect((await r.post({ site: "renamed", appsImageTag: "latest" })).status).toBe(400);
    expect(r.planned).toEqual([]);
  });
});
