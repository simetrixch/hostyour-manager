// A website's move to another site: POST /api/tenants/:id/websites/:app/site plans
// tenant-set-website-site (tenant-website-site.run.ts) with the body's site and the image tag of the
// bundle release that carries it. The run's planner holds every rule; the route only shapes the
// request. Approve via the Runs API.
import type { Hono } from "hono";
import type { AppEnv } from "../../http/app-env.ts";
import type { Db } from "../../db/client.ts";
import { errValidation, errNotConfigured } from "../../kernel/errors.ts";
import { assertTenantProvisioned, loadTenantStatus } from "./tenant-provisioned.ts";
import { TenantSetWebsiteSiteRequest } from "./tenant-website-site.run.ts";
import type { Executor } from "../../executor/executor.ts";

export interface TenantWebsiteSiteApiDeps {
  db: Db;
  executor?: Executor;
  tenantEnabled: boolean;
}

export function registerTenantWebsiteSiteRoutes(app: Hono<AppEnv>, deps: TenantWebsiteSiteApiDeps): void {
  const { db, executor, tenantEnabled } = deps;
  app.post("/api/tenants/:id/websites/:app/site", async (c) => {
    if (!tenantEnabled || !executor) throw errNotConfigured("tenant onboarding is not configured on this manager");
    const id = c.req.param("id");
    assertTenantProvisioned(loadTenantStatus(db, id), "moving a website to another site");
    const body = (await c.req.json().catch(() => ({}))) as { site?: unknown; appsImageTag?: unknown };
    const typed = (v: unknown): unknown => (typeof v === "string" ? v.trim().toLowerCase() : v);
    const parsed = TenantSetWebsiteSiteRequest.safeParse({ tenantId: id, app: c.req.param("app"), site: typed(body.site), appsImageTag: typed(body.appsImageTag) });
    if (!parsed.success) throw errValidation(`invalid website-site request: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    return c.json(await executor.planStreamed("tenant-set-website-site", parsed.data), 201);
  });
}
