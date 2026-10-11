import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { CreateTenantRequest } from "./create-tenant.run.ts";
import { registerTenantStageRoutes } from "./api-tenant-stages.ts";
import { openDb, type DbHandle } from "../../db/client.ts";
import { servers, clusters, tenants } from "../../db/schema/inventory.ts";
import { toApiError } from "../../http/middleware/error-shape.ts";
import type { AppEnv } from "../../http/app-env.ts";
import type { Executor } from "../../executor/executor.ts";

// A tenant has no default size: the operator names one, and T5 says when it is too small for the
// members. A preset would put every unattended create on a size its platform members may not fit.

describe("create-tenant's size", () => {
  it("refuses a request without a size, naming the field", () => {
    const issues = CreateTenantRequest.safeParse({ clusterId: "cls_1", stage: "prod", subdomain: "acme", owner: "o" }).error?.issues ?? [];
    expect(issues.map((i) => i.path.join("."))).toEqual(["size"]);
  });

  it("takes a size a tenant is offered", () => {
    expect(CreateTenantRequest.safeParse({ clusterId: "cls_1", stage: "prod", subdomain: "acme", owner: "o", size: "xsmall" }).success).toBe(true);
  });

  it("REFUSES XL at create-tenant: a tenant is offered XS to L", () => {
    const issues = CreateTenantRequest.safeParse({ clusterId: "cls_1", stage: "prod", subdomain: "acme", owner: "o", size: "xlarge" }).error?.issues ?? [];
    expect(issues.map((i) => i.path.join("."))).toEqual(["size"]);
  });
});

describe("Add stage's size", () => {
  let db: DbHandle;
  beforeEach(() => {
    db = openDb(":memory:");
    db.db.insert(servers).values({ id: "srv_1", name: "s1", host: "10.1.1.11", sshUser: "root", role: "slave", status: "healthy" }).run();
    db.db.insert(clusters).values({ id: "cls_1", serverId: "srv_1", stage: "prod", domain: "s1.example", name: "s1", status: "active" }).run();
    db.db.insert(tenants).values({ id: "tnt_1", clusterId: "cls_1", guid: "zsjs023ctne0", subdomain: "acme", owner: "team-acme", stage: "prod", members: ["auth"], identityProvider: "auth", identityProviderPath: "/auth", status: "active" }).run();
  });
  afterEach(() => { db.sqlite.close(); });

  const addStage = async (size: string) => {
    const planned: unknown[] = [];
    const executor = { planStreamed: async (_kind: string, params: unknown) => { planned.push(params); return { runId: "run_1" }; } } as unknown as Executor;
    const app = new Hono<AppEnv>();
    app.onError((err, c) => { const { status, body } = toApiError(err); return c.json(body, status as 400); });
    registerTenantStageRoutes(app, { db: db.db, executor, tenantEnabled: true } as unknown as Parameters<typeof registerTenantStageRoutes>[1]);
    const res = await app.request("/api/tenants/tnt_1/stages", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ stage: "test", clusterId: "cls_1", size }) });
    return { status: res.status, text: await res.text(), planned };
  };

  it("REFUSES XL, naming the size, and plans nothing", async () => {
    const r = await addStage("xlarge");
    expect(r.status).toBe(400);
    expect(r.text).toMatch(/size/);
    expect(r.planned).toEqual([]);
  });

  it("plans L", async () => {
    expect((await addStage("large")).planned).toHaveLength(1);
  });
});
