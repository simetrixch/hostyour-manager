import { describe, it, expect, afterEach } from "vitest";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { openDb, type DbHandle } from "../../db/client.ts";
import { servers, clusters, tenants } from "../../db/schema/inventory.ts";
import type { AppEnv } from "../../http/app-env.ts";
import type { Executor } from "../../executor/executor.ts";
import { registerTenantOwnDomainRoutes } from "./api-tenant-own-domain.ts";
import { toApiError } from "../../http/middleware/error-shape.ts";

// The route takes ONE domain, typed without www, and plans the own hosts it gives: <domain> served,
// www.<domain> redirecting there. The tenant's standing own hosts come off its row as the plan's `previous`:
// a request that named them itself could never match a tenant with redirect hosts.

describe("POST /api/tenants/:id/own-domain", () => {
  let h: DbHandle;
  afterEach(() => h.sqlite.close());

  function route(): { post: (body: unknown) => Promise<Response>; planned: unknown[]; db: DbHandle["db"] } {
    h = openDb(":memory:");
    h.db.insert(servers).values({ id: "srv_1", name: "m1", host: "1.2.3.4", sshUser: "root", role: "master", status: "healthy" }).run();
    h.db.insert(clusters).values({ id: "cls_1", serverId: "srv_1", stage: "prod", domain: "s1.example", name: "s1", status: "active" }).run();
    h.db.insert(tenants).values({
      id: "tnt_1", clusterId: "cls_1", guid: "zsjs023ctne0", subdomain: "acme", stage: "prod", members: ["auth"], identityProvider: "auth",
      ownDomain: "www.customer.test", ownDomainRedirects: ["customer.test"], suspended: false, status: "active",
    }).run();
    const planned: unknown[] = [];
    const executor = { planStreamed: async (_kind: string, params: unknown) => { planned.push(params); return { runId: "run_1" }; } } as unknown as Executor;
    const app = new Hono<AppEnv>();
    app.onError((err, c) => { const { status, body } = toApiError(err); return c.json(body, status as 400); });
    registerTenantOwnDomainRoutes(app, { db: h.db, executor, tenantEnabled: true });
    const post = async (body: unknown): Promise<Response> => app.request("/api/tenants/tnt_1/own-domain", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { post, planned, db: h.db };
  }

  it("serves <domain>, redirects www.<domain> there, and takes the row's standing hosts as previous", async () => {
    const r = route();
    expect((await r.post({ domain: " Shop.Test " })).status).toBe(201);
    expect(r.planned).toEqual([{
      tenantId: "tnt_1", ownDomain: "shop.test", ownDomainRedirects: ["www.shop.test"], previous: "www.customer.test", previousRedirects: ["customer.test"],
      ownDomainAliases: [], previousAliases: [], replacing: [], mailRecords: [],
      nestsUnder: "", nestsUnderTenantId: null, previousNestsUnder: null,
    }]);
    // The operator's confirmation that the domain lies under another tenant's, as that tenant's subdomain.
    expect((await r.post({ domain: "shop.test", nestsUnder: " Simetrix " })).status).toBe(201);
    expect(r.planned[1]).toMatchObject({ nestsUnder: "simetrix" });
  });

  it("returns the tenant to its zone for an empty domain", async () => {
    const r = route();
    expect((await r.post({ domain: "" })).status).toBe(201);
    expect(r.planned).toEqual([{ tenantId: "tnt_1", ownDomain: "", ownDomainRedirects: [], previous: "www.customer.test", previousRedirects: ["customer.test"], ownDomainAliases: [], previousAliases: [], replacing: [], mailRecords: [], nestsUnder: "", nestsUnderTenantId: null, previousNestsUnder: null }]);
  });

  it("takes the alias domains the body names, and keeps the tenant's where it names none", async () => {
    const r = route();
    expect((await r.post({ domain: "shop.test", aliases: [" Old.Test ", "simetrix.de"] })).status).toBe(201);
    expect(r.planned[0]).toMatchObject({ ownDomain: "shop.test", ownDomainRedirects: ["www.shop.test"], ownDomainAliases: ["old.test", "simetrix.de"] });
    r.db.update(tenants).set({ ownDomainAliases: ["simetrix.eu"] }).where(eq(tenants.id, "tnt_1")).run();
    expect((await r.post({ domain: "shop.test" })).status).toBe(201);
    expect(r.planned[1]).toMatchObject({ ownDomainAliases: ["simetrix.eu"], previousAliases: ["simetrix.eu"] });
    expect((await r.post({ domain: "" })).status).toBe(201);
    expect(r.planned[2]).toMatchObject({ ownDomainAliases: [] });
    expect((await r.post({ domain: "shop.test", aliases: ["www.old.test"] })).status).toBe(400);
    expect((await r.post({ domain: "shop.test", aliases: ["old.test", "old.test"] })).status).toBe(400);
    expect((await r.post({ domain: "shop.test", aliases: ["shop.test"] })).status).toBe(400);
    expect((await r.post({ domain: "shop.test", aliases: "old.test" })).status).toBe(400);
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
