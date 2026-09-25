import type { Hono } from "hono";
import type { AppEnv } from "../../http/app-env.ts";
import type { Executor } from "../../executor/executor.ts";
import { errNotConfigured, errValidation } from "../../kernel/errors.ts";
import { TenantAppsRepoRequest } from "./tenant-apps-repo.run.ts";
import { TenantAppsRepoPurgeParams } from "./tenant-apps-repo-purge.run.ts";

// The tenant-apps-repo trigger, apart from api.ts the way api-onboard-prefill.ts is: the streaming
// plan path with the contract of POST /api/tenants — { runId } at once, the run in `planning` while
// the template is read, then `planned` (approve to create and build) or `failed` (refused, with the
// sentence). A fresh tenant's repository is created by tenant-create itself; this route is how a
// STANDING tenant gains one.
export function registerTenantAppsRepoRoute(app: Hono<AppEnv>, deps: { executor: Executor; tenantEnabled: boolean }): void {
  app.post("/api/tenants/apps-repo", async (c) => {
    if (!deps.tenantEnabled) throw errNotConfigured("tenant onboarding is not configured on this manager — the catalog and the GitHub App must be wired first");
    const parsed = TenantAppsRepoRequest.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) throw errValidation(`invalid tenant-apps-repo request: ${parsed.error.issues.map((i) => `${i.path.map(String).join(".")}: ${i.message}`).join("; ")}`);
    return c.json(await deps.executor.planStreamed("tenant-apps-repo", parsed.data), 201);
  });

  // The purge of an orphaned build registration (#241), keyed on the unit name the orphan scan
  // (GET /api/tenants/orphans) found. The plan itself refuses a unit a tenant names or a stage file
  // stands beside, so nothing is asked here beyond the shape.
  app.post("/api/tenants/apps-repo/purge", async (c) => {
    if (!deps.tenantEnabled) throw errNotConfigured("tenant onboarding is not configured on this manager");
    const parsed = TenantAppsRepoPurgeParams.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) throw errValidation(`invalid tenant-apps-repo-purge request: ${parsed.error.issues.map((i) => `${i.path.map(String).join(".")}: ${i.message}`).join("; ")}`);
    return c.json(await deps.executor.plan("tenant-apps-repo-purge", parsed.data), 201);
  });
}
