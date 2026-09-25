// The version approval's route, apart from api.ts the way the own-domain move is: POST
// /api/tenants/:id/approved-tags plans tenant-set-approved-tag (tenant-approved-tag.run.ts) with the
// app, the build and the tag the body names ("" clears it), the standing approval taken off the row.
// Approve via the Runs API.
import type { Hono } from "hono";
import { eq } from "drizzle-orm";
import type { AppEnv } from "../../http/app-env.ts";
import type { Db } from "../../db/client.ts";
import { errValidation, errNotConfigured } from "../../kernel/errors.ts";
import { tenants } from "../../db/schema/inventory.ts";
import { assertTenantProvisioned, loadTenantStatus } from "./tenant-provisioned.ts";
import { TenantSetApprovedTagParams } from "./tenant-approved-tag.run.ts";
import type { Executor } from "../../executor/executor.ts";

export interface TenantApprovedTagApiDeps {
  db: Db;
  executor?: Executor;
  tenantEnabled: boolean;
}

export function registerTenantApprovedTagRoutes(app: Hono<AppEnv>, deps: TenantApprovedTagApiDeps): void {
  const { db, executor, tenantEnabled } = deps;
  app.post("/api/tenants/:id/approved-tags", async (c) => {
    if (!tenantEnabled || !executor) throw errNotConfigured("tenant onboarding is not configured on this manager");
    const id = c.req.param("id");
    assertTenantProvisioned(loadTenantStatus(db, id), "approving a version");
    const body = (await c.req.json().catch(() => ({}))) as { app?: unknown; build?: unknown; tag?: unknown };
    const approved = db.select({ approvedTags: tenants.approvedTags }).from(tenants).where(eq(tenants.id, id)).get()?.approvedTags ?? {};
    const previous = typeof body.app === "string" && typeof body.build === "string" ? (approved[body.app]?.[body.build] ?? "") : "";
    const parsed = TenantSetApprovedTagParams.safeParse({ tenantId: id, app: body.app, build: body.build, tag: body.tag, previous });
    if (!parsed.success) throw errValidation(`invalid approved-tag request: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    return c.json(await executor.plan("tenant-set-approved-tag", parsed.data), 201);
  });
}
