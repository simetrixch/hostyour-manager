// The own-domain move's route, apart from api.ts the way the routing move is: POST
// /api/tenants/:id/own-domain plans tenant-set-own-domain (tenant-own-domain.run.ts) with the domain the
// body names ("" clears it), validated through the run's OWN params schema. Approve via the Runs API.
import type { Hono } from "hono";
import { eq } from "drizzle-orm";
import type { AppEnv } from "../../http/app-env.ts";
import type { Db } from "../../db/client.ts";
import { errValidation, errNotConfigured } from "../../kernel/errors.ts";
import { tenants } from "../../db/schema/inventory.ts";
import { assertTenantProvisioned, loadTenantStatus } from "./tenant-provisioned.ts";
import { TenantSetOwnDomainParams } from "./tenant-own-domain.run.ts";
import type { Executor } from "../../executor/executor.ts";

export interface TenantOwnDomainApiDeps {
  db: Db;
  executor?: Executor;
  tenantEnabled: boolean;
}

export function registerTenantOwnDomainRoutes(app: Hono<AppEnv>, deps: TenantOwnDomainApiDeps): void {
  const { db, executor, tenantEnabled } = deps;
  app.post("/api/tenants/:id/own-domain", async (c) => {
    if (!tenantEnabled || !executor) throw errNotConfigured("tenant onboarding is not configured on this manager");
    const id = c.req.param("id");
    assertTenantProvisioned(loadTenantStatus(db, id), "setting its own domain");
    const body = (await c.req.json().catch(() => ({}))) as { ownDomain?: unknown; ownDomainRedirects?: unknown };
    // The own hosts the tenant has now: what an abort of the move records again.
    const now = db.select({ ownDomain: tenants.ownDomain, ownDomainRedirects: tenants.ownDomainRedirects }).from(tenants).where(eq(tenants.id, id)).get();
    const parsed = TenantSetOwnDomainParams.safeParse({
      tenantId: id, ownDomain: body.ownDomain, ownDomainRedirects: body.ownDomainRedirects, previous: now?.ownDomain, previousRedirects: now?.ownDomainRedirects,
    });
    if (!parsed.success) throw errValidation(`invalid own-domain request: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    return c.json(await executor.plan("tenant-set-own-domain", parsed.data), 201);
  });
}
