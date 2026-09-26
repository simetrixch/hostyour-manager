// The routes of a standing tenant's single-purpose actions, each of which only plans its run and is
// approved via the Runs API: its routing, its own domain, its member refresh, an approved version and
// its sender domain. One registration for all of them, because they share their dependencies and
// their "not configured" rule.
import type { Hono } from "hono";
import type { AppEnv } from "../../http/app-env.ts";
import type { Db } from "../../db/client.ts";
import type { Executor } from "../../executor/executor.ts";
import { registerTenantRoutingRoutes } from "./api-tenant-routing.ts";
import { registerTenantOwnDomainRoutes } from "./api-tenant-own-domain.ts";
import { registerTenantRefreshMembersRoutes } from "./api-tenant-refresh-members.ts";
import { registerTenantApprovedTagRoutes } from "./api-tenant-approved-tag.ts";
import { registerTenantSenderDomainRoutes } from "./api-tenant-sender-domain.ts";

export function registerTenantActionRoutes(app: Hono<AppEnv>, deps: { db: Db; executor?: Executor; tenantEnabled: boolean }): void {
  registerTenantRoutingRoutes(app, deps);
  registerTenantOwnDomainRoutes(app, deps);
  registerTenantRefreshMembersRoutes(app, deps);
  registerTenantApprovedTagRoutes(app, deps);
  registerTenantSenderDomainRoutes(app, deps);
}
