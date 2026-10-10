// The routes of a standing tenant's single-purpose actions, each of which only plans its run and is
// approved via the Runs API: its own domain, its versions with its member refresh, and
// its sender domain and display name, and a website's domain, site and main mark. One registration for all of them, because they share their dependencies and
// their "not configured" rule.
import { registerTenantStageRoutes } from "./api-tenant-stages.ts";
import type { Hono } from "hono";
import type { AppEnv } from "../../http/app-env.ts";
import { registerTenantOwnDomainRoutes } from "./api-tenant-own-domain.ts";
import { registerTenantRefreshMembersRoutes, type TenantRefreshMembersApiDeps } from "./api-tenant-refresh-members.ts";
import { registerTenantSenderDomainRoutes } from "./api-tenant-sender-domain.ts";
import { registerTenantWebsiteSiteRoutes } from "./api-tenant-website-site.ts";
import { registerTenantWebsiteMainRoute } from "./api-tenant-website-main.ts";
import { registerTenantDemoRoute } from "./api-tenant-demo.ts";
import { registerTenantDisplayNameRoute } from "./api-tenant-display-name.ts";

export function registerTenantActionRoutes(app: Hono<AppEnv>, deps: TenantRefreshMembersApiDeps): void {
  registerTenantStageRoutes(app, deps);
  registerTenantOwnDomainRoutes(app, deps);
  registerTenantRefreshMembersRoutes(app, deps);
  registerTenantSenderDomainRoutes(app, deps);
  registerTenantWebsiteSiteRoutes(app, deps);
  registerTenantWebsiteMainRoute(app, deps);
  registerTenantDemoRoute(app, deps);
  registerTenantDisplayNameRoute(app, deps);
}
