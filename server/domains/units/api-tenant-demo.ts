import type { Hono } from "hono";
import type { AppEnv } from "../../http/app-env.ts";
import type { TenantSenderDomainApiDeps } from "./api-tenant-sender-domain.ts";
import { errValidation, errNotConfigured } from "../../kernel/errors.ts";
import { TenantSetDemoRequest } from "./tenant-demo.run.ts";

export function registerTenantDemoRoute(app: Hono<AppEnv>, deps: TenantSenderDomainApiDeps): void {
  app.post("/api/tenants/:id/demo", async (c) => {
    if (!deps.tenantEnabled || !deps.executor) throw errNotConfigured("tenant onboarding is not configured on this manager");
    const body = (await c.req.json().catch(() => ({}))) as { demo?: unknown };
    const parsed = TenantSetDemoRequest.safeParse({ tenantId: c.req.param("id"), demo: body.demo });
    if (!parsed.success) throw errValidation("demo must be true or false for a tenant id");
    return c.json(await deps.executor.planStreamed("tenant-set-demo", parsed.data), 201);
  });
}
