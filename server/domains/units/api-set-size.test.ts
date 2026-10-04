import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { openDb, type DbHandle } from "../../db/client.ts";
import { servers, clusters, apps, tenants } from "../../db/schema/inventory.ts";
import { seedUnitSizes } from "#unit/server/unit-size.ts";
import { registerSetSizeRoutes } from "./api-set-size.ts";
import type { AppEnv } from "../../http/app-env.ts";

// The two pickers' routes offer exactly the sizes the table holds rows for, for what the unit brings:
// a consumer its three, a tenant XS to L of its six.

let db: DbHandle;
beforeEach(() => {
  db = openDb(":memory:");
  seedUnitSizes(db.db);
  db.db.insert(servers).values({ id: "srv_1", name: "m1", host: "1.2.3.4", sshUser: "root", role: "master", status: "healthy" }).run();
  db.db.insert(clusters).values({ id: "cls_1", serverId: "srv_1", stage: "prod", domain: "s1.example", name: "s1", status: "active" }).run();
  db.db.insert(apps).values({ id: "app_1", clusterId: "cls_1", name: "acme", stage: "prod", host: "acme", repoUrl: "https://github.com/x/acme.git", chartPath: "deploy/chart", provenance: "manager", status: "active" }).run();
  db.db.insert(tenants).values({ id: "tnt_1", clusterId: "cls_1", guid: "zsjs023ctne0", subdomain: "simetrix", stage: "prod", members: ["auth"], identityProvider: "auth", status: "active" }).run();
});
afterEach(() => { db.sqlite.close(); });

const sizesOf = async (path: string): Promise<{ status: number; ids: string[] }> => {
  const app = new Hono<AppEnv>();
  registerSetSizeRoutes(app, { db: db.db, onboardingEnabled: true, tenantEnabled: true });
  const res = await app.request(path);
  return { status: res.status, ids: ((await res.json()) as { sizes: { name: string }[] }).sizes.map((s) => s.name) };
};

describe("the size pickers' routes", () => {
  it("offer a consumer the three sizes its base row is seeded at", async () => {
    expect(await sizesOf("/api/consumers/app_1/sizes")).toEqual({ status: 200, ids: ["small", "medium", "large"] });
  });

  it("offer a tenant XS to L, though the member rows reach XXL", async () => {
    expect(await sizesOf("/api/tenants/tnt_1/sizes")).toEqual({ status: 200, ids: ["xsmall", "small", "medium", "large"] });
  });
});
