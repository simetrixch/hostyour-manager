import type { Hono } from "hono";
import type { AppEnv } from "../../http/app-env.ts";
import { errNotConfigured, errValidation } from "../../kernel/errors.ts";
import { loadTenantCluster } from "./lifecycle.ts";
import { CreateTenantRequest } from "./create-tenant.run.ts";
import type { TenantOwnDomainApiDeps } from "./api-tenant-own-domain.ts";

export function registerTenantStageRoutes(app: Hono<AppEnv>, { db, executor, tenantEnabled }: TenantOwnDomainApiDeps): void {
  app.post("/api/tenants/:id/stages", async (c) => {
    if (!tenantEnabled || !executor) throw errNotConfigured("tenant onboarding is not configured on this manager");
    const sourceTenantId = c.req.param("id");
    const source = loadTenantCluster(db, sourceTenantId);
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const parsed = CreateTenantRequest.safeParse({ ...body, sourceTenantId, subdomain: source.subdomain, owner: source.owner, apps: [] });
    if (!parsed.success) throw errValidation(`invalid Add stage request: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    return c.json(await executor.planStreamed("tenant-create", parsed.data), 201);
  });
}
