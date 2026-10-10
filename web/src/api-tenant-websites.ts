// The website actions of a tenant's page: each only plans its run, which the Runs API approves.
import { post } from "./request.ts";

/** Plan add-app for a website: named after its site (websiteAppName), running the bundle's website folder;
 *  `main` makes it the tenant's main website. */
export const addTenantWebsite = (tenantId: string, website: { app: string; site: string; folder: string; main: boolean }): Promise<{ runId: string }> =>
  post<{ runId: string }>(`/api/tenants/${tenantId}/apps`, website);
/** Plan tenant-set-website-site: the website moves to another site, on the bundle release that carries it. */
export const setTenantWebsiteSite = (tenantId: string, app: string, site: string, appsImageTag: string): Promise<{ runId: string }> => post<{ runId: string }>(`/api/tenants/${tenantId}/websites/${encodeURIComponent(app)}/site`, { site, appsImageTag });
/** Plan tenant-set-website-main: the deployed website becomes the tenant's main website, served at `/` of the tenant's host. */
export const setTenantWebsiteMain = (tenantId: string, app: string): Promise<{ runId: string }> => post<{ runId: string }>(`/api/tenants/${tenantId}/websites/${encodeURIComponent(app)}/main`, {});
