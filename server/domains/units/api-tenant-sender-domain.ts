// The sender domain's route, apart from api.ts the way the own-domain move is: POST
// /api/tenants/:id/sender-domain plans tenant-set-sender-domain (tenant-sender-domain.run.ts) with the
// domain the body names ("" sends as the platform's own again), the standing one taken off the row.
// Approve via the Runs API.
import type { Hono } from "hono";
import { eq } from "drizzle-orm";
import type { AppEnv } from "../../http/app-env.ts";
import type { Db } from "../../db/client.ts";
import { errValidation, errNotConfigured } from "../../kernel/errors.ts";
import { tenants } from "../../db/schema/inventory.ts";
import { assertTenantProvisioned, loadTenantStatus } from "./tenant-provisioned.ts";
import { TenantSetSenderDomainParams } from "./tenant-sender-domain.run.ts";
import type { Executor } from "../../executor/executor.ts";

export interface TenantSenderDomainApiDeps {
  db: Db;
  executor?: Executor;
  tenantEnabled: boolean;
}

export function registerTenantSenderDomainRoutes(app: Hono<AppEnv>, deps: TenantSenderDomainApiDeps): void {
  const { db, executor, tenantEnabled } = deps;
  app.post("/api/tenants/:id/sender-domain", async (c) => {
    if (!tenantEnabled || !executor) throw errNotConfigured("tenant onboarding is not configured on this manager");
    const id = c.req.param("id");
    assertTenantProvisioned(loadTenantStatus(db, id), "setting its sender domain");
    const body = (await c.req.json().catch(() => ({}))) as { senderDomain?: unknown };
    const previous = db.select({ senderDomain: tenants.senderDomain }).from(tenants).where(eq(tenants.id, id)).get()?.senderDomain ?? "";
    const domain = typeof body.senderDomain === "string" ? body.senderDomain.trim().toLowerCase() : body.senderDomain;
    const parsed = TenantSetSenderDomainParams.safeParse({ tenantId: id, senderDomain: domain, previous });
    if (!parsed.success) throw errValidation(`invalid sender-domain request: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    return c.json(await executor.plan("tenant-set-sender-domain", parsed.data), 201);
  });
}
