import { describe, it, expect, afterEach } from "vitest";
import { Hono } from "hono";
import { openDb, type DbHandle } from "../../db/client.ts";
import { servers, clusters, tenants } from "../../db/schema/inventory.ts";
import type { AppEnv } from "../../http/app-env.ts";
import type { Executor } from "../../executor/executor.ts";
import { registerTenantOwnDomainRoutes } from "./api-tenant-own-domain.ts";
import { toApiError } from "../../http/middleware/error-shape.ts";

// The route takes ONE domain, typed without www, and plans the own hosts it gives: www.<domain> served,
// <domain> redirecting there. The tenant's standing own hosts come off its row as the plan's `previous`:
// a request that named them itself could never match a tenant with redirect hosts.

describe("POST /api/tenants/:id/own-domain", () => {
  let h: DbHandle;
  afterEach(() => h.sqlite.close());

  function route(): { post: (body: unknown) => Promise<Response>; planned: unknown[] } {
    h = openDb(":memory:");
    h.db.insert(servers).values({ id: "srv_1", name: "m1", host: "1.2.3.4", sshUser: "root", role: "master", status: "healthy" }).run();
    h.db.insert(clusters).values({ id: "cls_1", serverId: "srv_1", stage: "prod", domain: "s1.example", name: "s1", status: "active" }).run();
    h.db.insert(tenants).values({
      id: "tnt_1", clusterId: "cls_1", guid: "zsjs023ctne0", subdomain: "acme", stage: "prod", members: ["auth"], identityProvider: "auth",
      routing: "path", ownDomain: "www.customer.test", ownDomainRedirects: ["customer.test"], suspended: false, status: "active",
    }).run();
    const planned: unknown[] = [];
    const executor = { plan: async (_kind: string, params: unknown) => { planned.push(params); return { runId: "run_1" }; } } as unknown as Executor;
    const app = new Hono<AppEnv>();
    app.onError((err, c) => { const { status, body } = toApiError(err); return c.json(body, status as 400); });
    registerTenantOwnDomainRoutes(app, { db: h.db, executor, tenantEnabled: true });
    const post = async (body: unknown): Promise<Response> => app.request("/api/tenants/tnt_1/own-domain", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { post, planned };
  }

  it("serves www.<domain>, redirects <domain> there, and takes the row's standing hosts as previous", async () => {
    const r = route();
    expect((await r.post({ domain: " Shop.Test " })).status).toBe(201);
    expect(r.planned).toEqual([{
      tenantId: "tnt_1", ownDomain: "www.shop.test", ownDomainRedirects: ["shop.test"], previous: "www.customer.test", previousRedirects: ["customer.test"],
    }]);
  });

  it("returns the tenant to its zone for an empty domain", async () => {
    const r = route();
    expect((await r.post({ domain: "" })).status).toBe(201);
    expect(r.planned).toEqual([{ tenantId: "tnt_1", ownDomain: "", ownDomainRedirects: [], previous: "www.customer.test", previousRedirects: ["customer.test"] }]);
  });

  it("refuses a domain typed with www, and a body without a domain", async () => {
    const r = route();
    const withWww = await r.post({ domain: "www.shop.test" });
    expect(withWww.status).toBe(400);
    expect(await withWww.text()).toContain('type the domain without \\"www.\\" (shop.test)');
    expect((await r.post({ ownDomain: "www.shop.test" })).status).toBe(400);
    expect(r.planned).toEqual([]);
  });
});
