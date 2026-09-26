// The member refresh's route, apart from api.ts the way the own-domain move is: POST
// /api/tenants/:id/refresh-members plans tenant-refresh-members (tenant-refresh-members.run.ts) through
// the streaming planner, because it renders and gates the fan-out as add-app does. Approve via the Runs API.
import type { Hono } from "hono";
import type { AppEnv } from "../../http/app-env.ts";
import type { Db } from "../../db/client.ts";
import { errNotConfigured } from "../../kernel/errors.ts";
import { assertTenantProvisioned, loadTenantStatus } from "./tenant-provisioned.ts";
import type { Executor } from "../../executor/executor.ts";

export interface TenantRefreshMembersApiDeps {
  db: Db;
  executor?: Executor;
  tenantEnabled: boolean;
}

export function registerTenantRefreshMembersRoutes(app: Hono<AppEnv>, deps: TenantRefreshMembersApiDeps): void {
  const { db, executor, tenantEnabled } = deps;
  app.post("/api/tenants/:id/refresh-members", async (c) => {
    if (!tenantEnabled || !executor) throw errNotConfigured("tenant onboarding is not configured on this manager");
    const tenantId = c.req.param("id");
    assertTenantProvisioned(loadTenantStatus(db, tenantId), "refreshing its members");
    const body = (await c.req.json().catch(() => ({}))) as { channel?: unknown };
    return c.json(await executor.planStreamed("tenant-refresh-members", { tenantId, ...(typeof body.channel === "string" ? { channel: body.channel } : {}) }), 201);
  });
}
