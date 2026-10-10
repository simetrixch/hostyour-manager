// The own-domain move's route, apart from api.ts the way the routing move is: POST
// /api/tenants/:id/own-domain plans tenant-set-own-domain (tenant-own-domain.run.ts) with the own hosts
// the body's one domain gives (ownDomainHosts: <domain>, and www.<domain> redirecting there; "" clears
// them) and the body's alias domains (none named keeps the tenant's), validated through the run's OWN
// params schema. Approve via the Runs API.
import type { Hono } from "hono";
import { eq } from "drizzle-orm";
import type { AppEnv } from "../../http/app-env.ts";
import type { Db } from "../../db/client.ts";
import { errValidation, errNotConfigured } from "../../kernel/errors.ts";
import { tenants } from "../../db/schema/inventory.ts";
import { assertTenantProvisioned, loadTenantStatus } from "./tenant-provisioned.ts";
import { TenantSetOwnDomainParams } from "./tenant-own-domain.run.ts";
import { ownDomainEntryProblem, ownDomainHosts } from "#unit/shared/unit-host.ts";
import type { Executor } from "../../executor/executor.ts";

export interface TenantOwnDomainApiDeps {
  db: Db;
  executor?: Executor;
  tenantEnabled: boolean;
}

export function registerTenantOwnDomainRoutes(app: Hono<AppEnv>, deps: TenantOwnDomainApiDeps): void {
  const { db, executor, tenantEnabled } = deps;
  app.post("/api/tenants/:id/own-domain", async (c) => {
    if (!tenantEnabled || !executor) throw errNotConfigured("tenant onboarding is not configured on this manager");
    const id = c.req.param("id");
    assertTenantProvisioned(loadTenantStatus(db, id), "setting its own domain");
    const body = (await c.req.json().catch(() => ({}))) as { domain?: unknown; aliases?: unknown; nestsUnder?: unknown };
    if (body.nestsUnder !== undefined && typeof body.nestsUnder !== "string") throw errValidation("invalid own-domain request: nestsUnder: the subdomain of a tenant, or absent");
    if (typeof body.domain !== "string") throw errValidation("invalid own-domain request: domain: a string is required (\"\" returns the tenant to its zone)");
    const domain = body.domain.trim().toLowerCase();
    if (!(Array.isArray(body.aliases) && body.aliases.every((a) => typeof a === "string"))) throw errValidation("invalid own-domain request: aliases: a list of domains is required ([] names none)");
    // The own hosts the tenant has now: what an abort of the move records again.
    const now = db.select({ ownDomain: tenants.ownDomain, ownDomainRedirects: tenants.ownDomainRedirects, ownDomainAliases: tenants.ownDomainAliases }).from(tenants).where(eq(tenants.id, id)).get();
    const aliases = domain === "" ? [] : (body.aliases as string[]).map((a) => a.trim().toLowerCase());
    for (const entry of [domain, ...aliases]) {
      const problem = ownDomainEntryProblem(entry);
      if (problem) throw errValidation(`invalid own-domain request: ${problem}`);
    }
    const hosts = ownDomainHosts(domain);
    const parsed = TenantSetOwnDomainParams.safeParse({
      tenantId: id, ...hosts, ownDomainAliases: aliases, previous: now?.ownDomain, previousRedirects: now?.ownDomainRedirects, previousAliases: now?.ownDomainAliases,
      nestsUnder: typeof body.nestsUnder === "string" ? body.nestsUnder.trim().toLowerCase() : "",
    });
    if (!parsed.success) throw errValidation(`invalid own-domain request: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    return c.json(await executor.planStreamed("tenant-set-own-domain", parsed.data), 201);
  });
}
