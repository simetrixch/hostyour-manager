// A website's move to another domain: POST /api/tenants/:id/websites/:app/domain plans
// tenant-set-website-domain (tenant-website-domain.run.ts) with the body's one domain and, where
// given, its alias domains, each typed without `www.`. The run's planner resolves the website's member again at that domain and holds every rule;
// the route only shapes the request. Approve via the Runs API.
import type { Hono } from "hono";
import type { AppEnv } from "../../http/app-env.ts";
import type { Db } from "../../db/client.ts";
import { errValidation, errNotConfigured } from "../../kernel/errors.ts";
import { assertTenantProvisioned, loadTenantStatus } from "./tenant-provisioned.ts";
import { TenantSetWebsiteDomainRequest } from "./tenant-website-domain.run.ts";
import type { Executor } from "../../executor/executor.ts";

export interface TenantWebsiteDomainApiDeps {
  db: Db;
  executor?: Executor;
  tenantEnabled: boolean;
}

export function registerTenantWebsiteDomainRoutes(app: Hono<AppEnv>, deps: TenantWebsiteDomainApiDeps): void {
  const { db, executor, tenantEnabled } = deps;
  app.post("/api/tenants/:id/websites/:app/domain", async (c) => {
    if (!tenantEnabled || !executor) throw errNotConfigured("tenant onboarding is not configured on this manager");
    const id = c.req.param("id");
    assertTenantProvisioned(loadTenantStatus(db, id), "moving a website");
    const body = (await c.req.json().catch(() => ({}))) as { domain?: unknown; aliases?: unknown };
    const typed = (v: unknown): unknown => (typeof v === "string" ? v.trim().toLowerCase() : v);
    const aliases = Array.isArray(body.aliases) ? body.aliases.map(typed) : body.aliases;
    const parsed = TenantSetWebsiteDomainRequest.safeParse({ tenantId: id, app: c.req.param("app"), domain: typed(body.domain), ...(aliases === undefined ? {} : { aliases }) });
    if (!parsed.success) throw errValidation(`invalid website-domain request: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    return c.json(await executor.planStreamed("tenant-set-website-domain", parsed.data), 201);
  });
}
