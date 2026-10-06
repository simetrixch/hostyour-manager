// The display name's route, beside the sender domain's: POST /api/tenants/:id/display-name plans
// tenant-set-display-name (tenant-display-name.run.ts) with the name the body gives ("" for none), the
// standing one taken off the row. Approve via the Runs API.
import type { Hono } from "hono";
import { eq } from "drizzle-orm";
import type { AppEnv } from "../../http/app-env.ts";
import { errValidation, errNotConfigured } from "../../kernel/errors.ts";
import { tenants } from "../../db/schema/inventory.ts";
import { assertTenantProvisioned, loadTenantStatus } from "./tenant-provisioned.ts";
import { TenantSetDisplayNameParams } from "./tenant-display-name.run.ts";
import type { TenantSenderDomainApiDeps } from "./api-tenant-sender-domain.ts";

export function registerTenantDisplayNameRoute(app: Hono<AppEnv>, deps: TenantSenderDomainApiDeps): void {
  const { db, executor, tenantEnabled } = deps;
  app.post("/api/tenants/:id/display-name", async (c) => {
    if (!tenantEnabled || !executor) throw errNotConfigured("tenant onboarding is not configured on this manager");
    const id = c.req.param("id");
    assertTenantProvisioned(loadTenantStatus(db, id), "setting its display name");
    const body = (await c.req.json().catch(() => ({}))) as { displayName?: unknown };
    const previous = db.select({ displayName: tenants.displayName }).from(tenants).where(eq(tenants.id, id)).get()?.displayName ?? "";
    const name = typeof body.displayName === "string" ? body.displayName.trim() : body.displayName;
    const parsed = TenantSetDisplayNameParams.safeParse({ tenantId: id, displayName: name, previous });
    if (!parsed.success) throw errValidation(`invalid display-name request: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    return c.json(await executor.plan("tenant-set-display-name", parsed.data), 201);
  });
}
