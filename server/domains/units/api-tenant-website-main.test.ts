import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import type { AppEnv } from "../../http/app-env.ts";
import type { Executor } from "../../executor/executor.ts";
import { registerTenantWebsiteMainRoute } from "./api-tenant-website-main.ts";
import { toApiError } from "../../http/middleware/error-shape.ts";

// The route names the tenant and the website through its path and takes no body; the run's planner holds
// every rule.

describe("POST /api/tenants/:id/websites/:app/main", () => {
  function route(tenantEnabled = true): { post: (path: string) => Promise<Response>; planned: { kind: string; params: unknown }[] } {
    const planned: { kind: string; params: unknown }[] = [];
    const executor = { planStreamed: async (kind: string, params: unknown) => { planned.push({ kind, params }); return { runId: "run_1" }; } } as unknown as Executor;
    const app = new Hono<AppEnv>();
    app.onError((err, c) => { const { status, body } = toApiError(err); return c.json(body, status as 400); });
    registerTenantWebsiteMainRoute(app, { executor, tenantEnabled });
    return { post: async (path) => app.request(path, { method: "POST" }), planned };
  }

  it("plans tenant-set-website-main for the website the path names", async () => {
    const r = route();
    const response = await r.post("/api/tenants/tnt_1/websites/example-ch/main");
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ runId: "run_1" });
    expect(r.planned).toEqual([{ kind: "tenant-set-website-main", params: { tenantId: "tnt_1", app: "example-ch" } }]);
  });

  it("refuses a tenant id and a website name the run cannot hold, and a manager without tenant onboarding", async () => {
    const r = route();
    expect((await r.post("/api/tenants/other/websites/example-ch/main")).status).toBe(400);
    expect((await r.post("/api/tenants/tnt_1/websites/Not%20A%20Name/main")).status).toBe(400);
    expect(r.planned).toEqual([]);
    expect((await route(false).post("/api/tenants/tnt_1/websites/example-ch/main")).status).toBe(501);
  });
});
