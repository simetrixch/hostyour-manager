// The Versions dialog's routes, apart from api.ts the way the own-domain move is. GET
// /api/tenants/:id/versions answers what the dialog offers, read as the plan reads it; POST
// /api/tenants/:id/refresh-members plans tenant-refresh-members (tenant-refresh-members.run.ts) with the
// version chosen per part, through the streaming planner, because it renders and gates the fan-out as
// add-app does. Approve via the Runs API.
import type { Hono } from "hono";
import { eq } from "drizzle-orm";
import type { AppEnv } from "../../http/app-env.ts";
import type { Db } from "../../db/client.ts";
import type { VersionsView } from "../../../shared/api-types.ts";
import type { LineMoveView } from "../../../shared/api-types-line-move.ts";
import { errNotConfigured, errValidation } from "../../kernel/errors.ts";
import { assertTenantProvisioned, loadTenantStatus } from "./tenant-provisioned.ts";
import { TenantRefreshMembersRequest } from "./tenant-refresh-members.run.ts";
import { TenantLineMoveRequest } from "./tenant-line-move.run.ts";
import type { Executor } from "../../executor/executor.ts";
import { tenants } from "../../db/schema/inventory.ts";
import { writeAudit } from "../../db/audit-writer.ts";
import type { TenantFollower } from "./tenant-follow.ts";

export interface TenantRefreshMembersApiDeps {
  db: Db;
  executor?: Executor;
  tenantEnabled: boolean;
  /** What the Versions dialog offers (tenant-versions.ts readTenantVersions). */
  versions?: (db: Db, tenantId: string, signal?: AbortSignal) => Promise<VersionsView>;
  /** The engine line the tenant runs and the move to a newer one (tenant-line-move.ts readTenantLineMoves). */
  lineMoves?: (db: Db, tenantId: string, signal?: AbortSignal) => Promise<LineMoveView>;
  /** Moves the tenants that follow releases (tenant-follow.ts). */
  follower?: TenantFollower;
}

export function registerTenantRefreshMembersRoutes(app: Hono<AppEnv>, deps: TenantRefreshMembersApiDeps): void {
  const { db, executor, tenantEnabled, versions, lineMoves, follower } = deps;
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
  // The move to a newer engine line the dialog offers: the reader answers it as the plan reads it, and
  // the POST plans tenant-line-move (tenant-line-move.run.ts), which the operator approves on the Runs page.
  app.get("/api/tenants/:id/line-moves", async (c) => {
    if (!tenantEnabled || !lineMoves) throw errNotConfigured("tenant onboarding is not configured on this manager");
    return c.json(await lineMoves(db, c.req.param("id"), c.req.raw.signal));
  });
  app.post("/api/tenants/:id/line-move", async (c) => {
    if (!tenantEnabled || !executor) throw errNotConfigured("tenant onboarding is not configured on this manager");
    const tenantId = c.req.param("id");
    assertTenantProvisioned(loadTenantStatus(db, tenantId), "moving it to a newer engine line");
    const body = (await c.req.json().catch(() => ({}))) as { line?: unknown };
    const parsed = TenantLineMoveRequest.safeParse({ tenantId, line: body.line });
    if (!parsed.success) throw errValidation(`invalid line move request: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    return c.json(await executor.planStreamed("tenant-line-move", parsed.data), 201);
  });
  // The switch of hostyour-manager#328: whether a release moves this tenant by itself. A Manager
  // behaviour and no deployment, so it is set on the row and recorded in the audit, and a tenant it
  // turns on is checked at once, so it catches up with its stage pins.
  app.put("/api/tenants/:id/follow-releases", async (c) => {
    if (!tenantEnabled || !follower) throw errNotConfigured("tenant onboarding is not configured on this manager");
    const tenantId = c.req.param("id");
    assertTenantProvisioned(loadTenantStatus(db, tenantId), "letting it follow releases");
    const body = (await c.req.json().catch(() => ({}))) as { followReleases?: unknown };
    if (typeof body.followReleases !== "boolean") throw errValidation("followReleases must be true or false");
    db.update(tenants).set({ followReleases: body.followReleases, updatedAt: new Date() }).where(eq(tenants.id, tenantId)).run();
    writeAudit(db, { actor: c.get("operator").sub, action: "tenant.follow-releases.set", targetKind: "tenant", targetId: tenantId, detail: { followReleases: body.followReleases } });
    if (body.followReleases) void follower.checkTenant(tenantId);
    return c.json({ followReleases: body.followReleases });
  });
}
