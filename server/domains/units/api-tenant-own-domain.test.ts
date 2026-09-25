import { describe, it, expect, afterEach } from "vitest";
import { Hono } from "hono";
import { openDb, type DbHandle } from "../../db/client.ts";
import { servers, clusters, tenants } from "../../db/schema/inventory.ts";
import type { AppEnv } from "../../http/app-env.ts";
import type { Executor } from "../../executor/executor.ts";
import { registerTenantOwnDomainRoutes } from "./api-tenant-own-domain.ts";

// The route takes the tenant's standing own hosts off its row as the plan's `previous`: a request that
// named them itself could never match a tenant with redirect hosts, and every move would be refused.

describe("POST /api/tenants/:id/own-domain", () => {
  let h: DbHandle;
  afterEach(() => h.sqlite.close());

  it("plans with the domain and redirect hosts the body names, and the row's standing ones as previous", async () => {
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
    registerTenantOwnDomainRoutes(app, { db: h.db, executor, tenantEnabled: true });
    const res = await app.request("/api/tenants/tnt_1/own-domain", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ownDomain: "shop.customer.test", ownDomainRedirects: [] }),
    });
    expect(res.status).toBe(201);
    expect(planned).toEqual([{
      tenantId: "tnt_1", ownDomain: "shop.customer.test", ownDomainRedirects: [], previous: "www.customer.test", previousRedirects: ["customer.test"],
    }]);
  });
});
