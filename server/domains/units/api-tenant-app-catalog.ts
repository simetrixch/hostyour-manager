import type { Hono } from "hono";
import { eq } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import type { AppEnv } from "../../http/app-env.ts";
import { tenants } from "../../db/schema/inventory.ts";
import { errNotFound } from "../../kernel/errors.ts";
import type { TenantAppCatalogView } from "../../../shared/apps-manifest.ts";
import type { CredentialStore } from "../../security/store.ts";
import type { GitHubApp } from "../../adapters/github-app/port.ts";
import type { TenantRegistrations } from "./tenant-registrations.ts";
import type { AppCatalogProvider } from "./app-catalog.ts";
import { packagesReaderView } from "./owners.ts";

// The catalog of ONE tenant, apart from api.ts the way api-tenant-apps-repo.ts is: the apps the
// catalog's TEMPLATE names (app-catalog.ts — what can be added to any tenant), each marked deployed
// where the tenant's registration names it in apps[]. The tenant page offers the undeployed ones to
// tenant-add-app, which judges the choice against the same template catalog (T4) and carries the
// app's folder into the tenant's own repository (tenant-apps-repo), so what the page offers and
// what the plan accepts are one thing (hostyour-manager#213, #215). A READ: it degrades with
// `reason` where there is nothing to read by design and with `error` where the read failed
// (TenantAppCatalogView says why neither may render as "no apps").
export interface TenantAppCatalogApiDeps {
  db: Db;
  store: Pick<CredentialStore, "list">;
  /** The platform's GitHub App: the owner it is installed with is the owner every tenant's bundle
   *  belongs to, and whose packages reader the bundle's build installs with. */
  githubApp: Pick<GitHubApp, "installationOrg">;
  registrations?: TenantRegistrations;
  appCatalog?: AppCatalogProvider;
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function registerTenantAppCatalogRoute(app: Hono<AppEnv>, deps: TenantAppCatalogApiDeps): void {
  const { db, store, githubApp, registrations, appCatalog } = deps;
  app.get("/api/tenants/:id/app-catalog", async (c) => {
    const id = c.req.param("id");
    const tenant = db.select({ guid: tenants.guid, stage: tenants.stage }).from(tenants).where(eq(tenants.id, id)).get();
    if (!tenant) throw errNotFound(`tenant ${id}`);
    const none = (reason: string): Response => c.json({ apps: [], reason } satisfies TenantAppCatalogView);
    if (!registrations) return none("tenant onboarding is not configured on this manager — it needs CATALOG_REPO and the platform repository (GITHUB_REPO, GITHUB_WRITE_PAT)");
    if (!appCatalog) return none("this Manager reads no app catalog — the catalog's template is what an app is chosen from");
    try {
      const current = await registrations.readTenant(tenant.stage, tenant.guid);
      if (!current) return none(`tenant ${tenant.guid} is not onboarded (no registration at ${tenant.stage})`);
      const template = await appCatalog.list(c.req.raw.signal);
      const deployed = new Set(current.entry.apps.map((a) => a.name));
      // The packages reader is asked for exactly where it is needed: the template routes a scope to
      // GitHub Packages and the owner records no reader. Absent scopes, nothing is asked (#233).
      const packagesReader = template.packageScopes.length > 0
        ? await (async () => { const owner = await githubApp.installationOrg(c.req.raw.signal); return { owner, scopes: template.packageScopes, recorded: await packagesReaderView({ db, store }, owner) }; })()
        : undefined;
      return c.json({ apps: template.apps.map((a) => ({ ...a, deployed: deployed.has(a.name) })), ...(packagesReader ? { packagesReader } : {}) } satisfies TenantAppCatalogView);
    } catch (e) {
      return c.json({ apps: [], error: errText(e) } satisfies TenantAppCatalogView);
    }
  });
}
