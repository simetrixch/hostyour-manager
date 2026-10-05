// The routes of a standing tenant's single-purpose actions, each of which only plans its run and is
// approved via the Runs API: its routing, its own domain, its versions with its member refresh, and
// its sender domain, and a website's domain and site. One registration for all of them, because they share their dependencies and
// their "not configured" rule.
import { registerTenantStageRoutes } from "./api-tenant-stages.ts";
import type { Hono } from "hono";
import type { AppEnv } from "../../http/app-env.ts";
import { registerTenantRoutingRoutes } from "./api-tenant-routing.ts";
import { registerTenantOwnDomainRoutes } from "./api-tenant-own-domain.ts";
import { registerTenantRefreshMembersRoutes, type TenantRefreshMembersApiDeps } from "./api-tenant-refresh-members.ts";
import { registerTenantSenderDomainRoutes } from "./api-tenant-sender-domain.ts";
import { registerTenantWebsiteDomainRoutes } from "./api-tenant-website-domain.ts";
import { registerTenantWebsiteSiteRoutes } from "./api-tenant-website-site.ts";
import { registerTenantDemoRoute } from "./api-tenant-demo.ts";

export function registerTenantActionRoutes(app: Hono<AppEnv>, deps: TenantRefreshMembersApiDeps): void {
  registerTenantStageRoutes(app, deps);
  registerTenantRoutingRoutes(app, deps);
  registerTenantOwnDomainRoutes(app, deps);
  registerTenantRefreshMembersRoutes(app, deps);
  registerTenantSenderDomainRoutes(app, deps);
  registerTenantWebsiteDomainRoutes(app, deps);
  registerTenantWebsiteSiteRoutes(app, deps);
  registerTenantDemoRoute(app, deps);
}
