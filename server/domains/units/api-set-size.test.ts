import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import type { DbHandle } from "../../db/client.ts";
import { openUnitDb } from "#unit/server/plugin.fixture.ts";
import { servers, clusters, apps, tenants } from "../../db/schema/inventory.ts";
import { registerSetSizeRoutes } from "./api-set-size.ts";
import type { AppEnv } from "../../http/app-env.ts";
import { Registrations } from "#unit/server/registrations.ts";
import { FakePlatformRepo } from "../../adapters/git/testing/fake.ts";
import { seedQuota, UNIT_SIZE_SEED } from "#unit/shared/unit-size.ts";

// The two pickers' routes offer exactly the sizes the table holds rows for, for what the unit brings:
// a consumer its six and each of its data parts its own, a tenant XS to L of its six.

let db: DbHandle;
beforeEach(() => {
  db = openUnitDb();
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
  it("offer a consumer the six sizes its base row is seeded at", async () => {
    expect(await sizesOf("/api/consumers/app_1/sizes")).toEqual({ status: 200, ids: ["xsmall", "small", "medium", "large", "xlarge", "xxlarge"] });
  });

  it("offer each data part its own sizes above the frugal default, at the size and volume it stands at, and compose the one asked for", async () => {
    const reg = new Registrations(new FakePlatformRepo());
    await reg.commitRegistration({
      unit: { name: "acme", repoURL: "https://github.com/x/acme.git", suspended: false, quiesced: false }, builds: [],
      deploy: { stage: "prod", host: "acme", chartPath: "deploy/chart", cluster: "s1", databases: [], keyPatterns: [], channelPatterns: [], services: ["postgresql"], size: "medium", sizes: { postgresql: "medium" }, volumes: { postgresql: "20Gi" }, mongodb: "shared", quota: seedQuota("medium", { postgresql: true, mongodb: "shared" }) },
      runId: "run_onb",
    });
    const app = new Hono<AppEnv>();
    registerSetSizeRoutes(app, { db: db.db, registrations: reg, onboardingEnabled: true, tenantEnabled: true });
    type Options = { current: string; parts: Record<string, { size: string; volume: string; offered: string[] }>; sizes: { name: string; parts: { component: string; each: unknown }[] }[] };
    const standing = (await (await app.request("/api/consumers/app_1/sizes")).json()) as Options;
    expect(standing.current).toBe("medium");
    expect(standing.parts).toEqual({ postgresql: { size: "medium", volume: "20Gi", offered: ["medium", "large", "xlarge", "xxlarge"] } });
    const asked = (await (await app.request("/api/consumers/app_1/sizes?postgresql=large")).json()) as Options;
    expect(asked.sizes.find((s) => s.name === "small")?.parts.find((p) => p.component === "postgresql")?.each).toEqual(UNIT_SIZE_SEED.postgresql.large);
  });

  it("offer a tenant XS to L, though the member rows reach XXL", async () => {
    expect(await sizesOf("/api/tenants/tnt_1/sizes")).toEqual({ status: 200, ids: ["xsmall", "small", "medium", "large"] });
  });
});
