import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Hono } from "hono";
import { pino } from "pino";
import { createApp } from "../../http/app.ts";
import { parseConfig } from "../../kernel/config.ts";
import { openDb, type DbHandle } from "../../db/client.ts";
import { servers, clusters, apps, unitSizes } from "../../db/schema/inventory.ts";
import { SessionCodec, SESSION_COOKIE } from "../access/session.ts";
import { registerUnitSizeRoutes } from "./api-unit-sizes.ts";
import { seedUnitSizes } from "./unit-size.ts";
import { Registry, type ClusterStageResolver } from "./registry.ts";
import { FakePlatformRepo } from "../../adapters/git/testing/fake.ts";
import { seedQuota, UNIT_SIZE_SEED } from "../../../shared/unit-size.ts";
import type { AppEnv } from "../../http/app-env.ts";

// The size table's API. Two things are asserted, and they are the two the screens rest on: a row is
// addressed by BOTH halves of its key (`medium` alone names three different rows), and the per-unit
// read composes the figures for what that unit actually brings rather than handing back the table.

const config = parseConfig({ PUBLIC_URL: "https://m1.example", OIDC_ISSUER: "https://i.example/", OIDC_CLIENT_ID: "c", OIDC_CLIENT_SECRET: "s", CONTROLLER_VERSION: "test", DATA_DIR: "/d", LOG_LEVEL: "silent" } as NodeJS.ProcessEnv);
const logger = pino({ level: "silent" });
const prodClusterStage: ClusterStageResolver = async (cluster) => ({ name: cluster, stage: "prod" });

let db: DbHandle;
beforeEach(() => { db = openDb(":memory:"); seedUnitSizes(db.db); });
afterEach(() => { db.sqlite.close(); });

/** One consumer on one cluster, registered with what it BRINGS — the fact the per-unit read composes
 *  from. `brings` is what its registration claims, exactly as onboarding wrote it. */
async function seedConsumer(registry: Registry, brings: { postgresql: boolean; mongodb: "shared" | "standalone" | "replicaset" }): Promise<void> {
  db.db.insert(servers).values({ id: "srv_1", name: "m1", host: "1.2.3.4", sshUser: "root", role: "master", status: "healthy" }).run();
  db.db.insert(clusters).values({ id: "cls_1", serverId: "srv_1", stage: "prod", domain: "s1.example", status: "active" }).run();
  db.db.insert(apps).values({ id: "app_1", clusterId: "cls_1", name: "acme", stage: "prod", repoUrl: "https://github.com/x/acme.git", chartPath: "deploy/chart", provenance: "controller", status: "active" }).run();
  await registry.commitRegistration({
    unit: { name: "acme", repoURL: "https://github.com/x/acme.git", suspended: false, quiesced: false },
    builds: [],
    deploy: {
      stage: "prod", chartPath: "deploy/chart", cluster: "s1", databases: [],
      services: brings.postgresql ? ["postgresql"] : [],
      size: "small", mongodb: brings.mongodb, quota: seedQuota("small", brings),
    },
    runId: "run_onb",
  });
}

async function make(registry?: Registry): Promise<{ app: Hono<AppEnv>; cookie: string }> {
  const session = new SessionCodec(db.db, config);
  const app = createApp({
    config, logger, getReadiness: () => ({ ok: true, checks: [] }), session,
    registerAuth: () => undefined,
    registerProtected: (a) => registerUnitSizeRoutes(a, { db: db.db, ...(registry ? { registry } : {}), onboardingEnabled: false, tenantEnabled: false }),
  });
  return { app, cookie: await session.mint({ sub: "op_test", groups: ["admins"], via: "oidc" }) };
}

const authed = (cookie: string): RequestInit => ({ headers: { cookie: `${SESSION_COOKIE}=${cookie}`, "sec-fetch-site": "same-origin" } });

describe("the size table", () => {
  it("serves NINE rows — every component at every size", async () => {
    const { app, cookie } = await make();
    const body = (await (await app.request("/api/unit-sizes", authed(cookie))).json()) as { sizes: Array<{ component: string; name: string }> };
    expect(body.sizes).toHaveLength(9);
    expect(body.sizes.map((s) => `${s.component}/${s.name}`)).toEqual([
      "base/small", "base/medium", "base/large",
      "postgresql/small", "postgresql/medium", "postgresql/large",
      "mongodb/small", "mongodb/medium", "mongodb/large",
    ]);
  });

  it("edits ONE row, addressed by component AND size — the other components' rows are untouched", async () => {
    const { app, cookie } = await make();
    const res = await app.request("/api/unit-sizes/mongodb/medium", {
      method: "PUT", ...authed(cookie),
      headers: { ...(authed(cookie).headers as Record<string, string>), "content-type": "application/json" },
      body: JSON.stringify({ requestsCpu: "999m", requestsMemory: "1Gi", limitsCpu: "2", limitsMemory: "4Gi", pods: 1, persistentVolumeClaims: 1 }),
    });
    expect(res.status).toBe(200);

    const mongo = db.db.select().from(unitSizes).where(and(eq(unitSizes.component, "mongodb"), eq(unitSizes.name, "medium"))).get();
    const base = db.db.select().from(unitSizes).where(and(eq(unitSizes.component, "base"), eq(unitSizes.name, "medium"))).get();
    expect(mongo?.requestsCpu).toBe("999m");
    // The whole point of the composite key: "medium" names three rows and an edit reaches exactly one.
    expect(base?.requestsCpu).toBe(UNIT_SIZE_SEED.base.medium.requestsCpu);
  });

  it("refuses a component and a size that are not in the vocabulary, naming what is", async () => {
    const { app, cookie } = await make();
    const put = async (path: string): Promise<Response> => app.request(path, {
      method: "PUT",
      headers: { ...(authed(cookie).headers as Record<string, string>), "content-type": "application/json" },
      body: JSON.stringify({ requestsCpu: "1", requestsMemory: "1Gi", limitsCpu: "1", limitsMemory: "1Gi", pods: 1, persistentVolumeClaims: 1 }),
    });
    expect((await put("/api/unit-sizes/redis/medium")).status).toBe(404);
    expect((await put("/api/unit-sizes/base/enormous")).status).toBe(404);
  });

  it("refuses a figure Kubernetes could not read, before it reaches a cluster", async () => {
    const { app, cookie } = await make();
    const res = await app.request("/api/unit-sizes/base/small", {
      method: "PUT",
      headers: { ...(authed(cookie).headers as Record<string, string>), "content-type": "application/json" },
      body: JSON.stringify({ requestsCpu: "lots", requestsMemory: "1Gi", limitsCpu: "1", limitsMemory: "1Gi", pods: 1, persistentVolumeClaims: 1 }),
    });
    expect(res.status).toBe(400);
  });
});

describe("what the three sizes cost ONE unit", () => {
  it("composes a consumer's figures from what its registration says it brings", async () => {
    const registry = new Registry(new FakePlatformRepo(), prodClusterStage);
    await seedConsumer(registry, { postgresql: true, mongodb: "replicaset" });
    const { app, cookie } = await make(registry);

    const body = (await (await app.request("/api/consumers/app_1/sizes", authed(cookie))).json()) as {
      unit: string; composed: boolean;
      brings: { postgresql: boolean; mongodb: string };
      sizes: Array<{ name: string; quota: { requestsCpu: string }; parts: Array<{ component: string; members: number }> }>;
    };

    expect(body.unit).toBe("acme");
    expect(body.composed).toBe(true);
    expect(body.brings).toEqual({ postgresql: true, mongodb: "replicaset" });
    // Three sizes, and each one is the SUM the run will write — base + postgresql + mongodb x3.
    expect(body.sizes.map((s) => s.name)).toEqual(["small", "medium", "large"]);
    expect(body.sizes[1]?.parts.map((p) => `${p.component}x${p.members}`)).toEqual(["basex1", "postgresqlx1", "mongodbx3"]);
    expect(body.sizes[1]?.quota.requestsCpu).toBe(seedQuota("medium", { postgresql: true, mongodb: "replicaset" }).requestsCpu);
  });

  it("says so rather than guessing when the registration cannot be read", async () => {
    // No registry ⇒ consumer onboarding is unwired. Answering with the base rows AND saying they are
    // uncomposed beats quoting a ceiling that silently omits the unit's own database.
    db.db.insert(servers).values({ id: "srv_1", name: "m1", host: "1.2.3.4", sshUser: "root", role: "master", status: "healthy" }).run();
    db.db.insert(clusters).values({ id: "cls_1", serverId: "srv_1", stage: "prod", domain: "s1.example", status: "active" }).run();
    db.db.insert(apps).values({ id: "app_1", clusterId: "cls_1", name: "acme", stage: "prod", provenance: "controller", status: "active" }).run();
    const { app, cookie } = await make();

    const body = (await (await app.request("/api/consumers/app_1/sizes", authed(cookie))).json()) as { composed: boolean; sizes: Array<{ quota: { requestsCpu: string } }> };
    expect(body.composed).toBe(false);
    expect(body.sizes[0]?.quota.requestsCpu).toBe(UNIT_SIZE_SEED.base.small.requestsCpu);
  });

  it("refuses an app id this controller does not know", async () => {
    const { app, cookie } = await make();
    expect((await app.request("/api/consumers/app_nope/sizes", authed(cookie))).status).toBe(404);
  });
});
