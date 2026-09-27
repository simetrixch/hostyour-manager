// The Versions dialog's routes, apart from api.ts the way the own-domain move is. GET
// /api/tenants/:id/versions answers what the dialog offers, read as the plan reads it; POST
// /api/tenants/:id/refresh-members plans tenant-refresh-members (tenant-refresh-members.run.ts) with the
// version chosen per part, through the streaming planner, because it renders and gates the fan-out as
// add-app does. Approve via the Runs API.
import type { Hono } from "hono";
import type { AppEnv } from "../../http/app-env.ts";
import type { Db } from "../../db/client.ts";
import type { VersionsView } from "../../../shared/api-types.ts";
import { errNotConfigured, errValidation } from "../../kernel/errors.ts";
import { assertTenantProvisioned, loadTenantStatus } from "./tenant-provisioned.ts";
import { TenantRefreshMembersRequest } from "./tenant-refresh-members.run.ts";
import type { Executor } from "../../executor/executor.ts";

export interface TenantRefreshMembersApiDeps {
  db: Db;
  executor?: Executor;
  tenantEnabled: boolean;
  /** What the Versions dialog offers (tenant-versions.ts readTenantVersions). */
  versions?: (db: Db, tenantId: string, signal?: AbortSignal) => Promise<VersionsView>;
}

export function registerTenantRefreshMembersRoutes(app: Hono<AppEnv>, deps: TenantRefreshMembersApiDeps): void {
  const { db, executor, tenantEnabled, versions } = deps;
  app.get("/api/tenants/:id/versions", async (c) => {
    if (!tenantEnabled || !versions) throw errNotConfigured("tenant onboarding is not configured on this manager");
    return c.json(await versions(db, c.req.param("id"), c.req.raw.signal));
  });
  app.post("/api/tenants/:id/refresh-members", async (c) => {
    if (!tenantEnabled || !executor) throw errNotConfigured("tenant onboarding is not configured on this manager");
    const tenantId = c.req.param("id");
    assertTenantProvisioned(loadTenantStatus(db, tenantId), "setting its versions");
    const body = (await c.req.json().catch(() => ({}))) as { versions?: unknown };
    const parsed = TenantRefreshMembersRequest.safeParse({ tenantId, versions: body.versions });
    if (!parsed.success) throw errValidation(`invalid versions request: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    return c.json(await executor.planStreamed("tenant-refresh-members", parsed.data), 201);
  });
}
