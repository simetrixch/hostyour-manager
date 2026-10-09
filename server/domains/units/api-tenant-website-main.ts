// A website's mark as the tenant's main website: POST /api/tenants/:id/websites/:app/main plans
// tenant-set-main-website (tenant-website-main.run.ts) for the website the path names. The request
// has no body; the run's planner holds every rule. Approve via the Runs API.
import type { Hono } from "hono";
import type { AppEnv } from "../../http/app-env.ts";
import { errValidation, errNotConfigured } from "../../kernel/errors.ts";
import { TenantSetMainWebsiteRequest } from "./tenant-website-main.run.ts";
import type { Executor } from "../../executor/executor.ts";

export interface TenantWebsiteMainApiDeps {
  executor?: Executor;
  tenantEnabled: boolean;
}

export function registerTenantWebsiteMainRoute(app: Hono<AppEnv>, deps: TenantWebsiteMainApiDeps): void {
  const { executor, tenantEnabled } = deps;
  app.post("/api/tenants/:id/websites/:app/main", async (c) => {
    if (!tenantEnabled || !executor) throw errNotConfigured("tenant onboarding is not configured on this manager");
    const parsed = TenantSetMainWebsiteRequest.safeParse({ tenantId: c.req.param("id"), app: c.req.param("app") });
    if (!parsed.success) throw errValidation("main website needs a tenant id and the name of a website");
    return c.json(await executor.planStreamed("tenant-set-main-website", parsed.data), 201);
  });
}
