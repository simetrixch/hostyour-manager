import type { TenantAppCatalogView, TenantCatalogAppView } from "../../shared/apps-manifest.ts";
import { websiteAppName } from "../../shared/tenant.ts";
import { TENANT_SETTLED_STATUS } from "../../shared/enums.ts";

// The Apps list of the tenant page, stated once and out of the component: the tenant's own catalog
// (its bundle's apps.yaml, each marked deployed off the registration) folded with the inventory's
// per-app rows (what a run recorded, with its status and its last run). One row per app name.
//
// The catalog leads, in its own order, so the page reads as the bundle: what stands in the tenant's
// repository, deployed or not. An inventory row the catalog does not name follows — an app removed
// from the bundle after it was deployed, or every row while the catalog is unreadable — because a
// recorded app that vanished from the list would read as never deployed.

/** One inventory row as the page needs it: the fields the row renders and the remove needs, and the
 *  site of a website (null for an app), which keeps a removed website out of the Apps list. */
export interface TenantAppRowInput {
  id: string;
  name: string;
  status: string;
  lastRunId: string | null;
  site?: string | null;
}

export interface TenantAppRow<R extends TenantAppRowInput> {
  name: string;
  /** The catalog entry, absent for an inventory row the bundle no longer names. */
  entry: TenantCatalogAppView | null;
  /** The inventory row, absent for a bundle app no run recorded. */
  row: R | null;
  /** The registration's word (the catalog's `deployed`), or the inventory's presence where the
   *  catalog says nothing. */
  deployed: boolean;
}

export function tenantAppRows<R extends TenantAppRowInput>(catalog: readonly TenantCatalogAppView[], rows: readonly R[], websites: readonly { name: string }[] = []): TenantAppRow<R>[] {
  // A website folder and the websites it runs are the Websites section's (TenantWebsites), not apps.
  const apps = catalog.filter((e) => e.sites === undefined);
  const site = new Set(websites.map((w) => w.name));
  const byName = new Map(rows.map((r) => [r.name, r]));
  const listed = apps.map((entry) => ({ name: entry.name, entry, row: byName.get(entry.name) ?? null, deployed: entry.deployed }));
  const named = new Set(apps.map((e) => e.name));
  const rest = rows.filter((r) => !named.has(r.name) && !site.has(r.name) && !r.site).map((row) => ({ name: row.name, entry: null, row, deployed: true }));
  return [...listed, ...rest];
}

const SETTLED: readonly string[] = TENANT_SETTLED_STATUS;
const websiteRows = <R extends TenantAppRowInput>(rows: readonly R[]): (R & { site: string })[] =>
  rows.filter((r): r is R & { site: string } => typeof r.site === "string" && r.site !== "");

/** The websites the tenant ran and removed: inventory rows that name a site and whose status is a
 *  settled one. Read off the row alone, so a catalog still loading, or one that answered without its
 *  websites, never turns a live website into a removed one. */
export function removedWebsites<R extends TenantAppRowInput>(rows: readonly R[]): (R & { site: string })[] {
  return websiteRows(rows).filter((r) => SETTLED.includes(r.status));
}

/** The websites the Websites section lists as live: the catalog's, each with its domain, and every
 *  inventory row that names a site, is not settled and is not among them, by name and site. That is
 *  every row while the catalog has not answered (still loading, unreadable or degraded). The Apps list
 *  leaves every row with a site out, so a live website missing here would vanish from the page. */
export function listedWebsites(catalog: Pick<TenantAppCatalogView, "websites"> | null, rows: readonly TenantAppRowInput[]): { name: string; site: string; domain: string | null; aliases: string[] }[] {
  const named = (catalog?.websites ?? []).map((w) => ({ name: w.name, site: w.site, domain: w.domain as string | null, aliases: w.aliases ?? [] }));
  const unnamed = websiteRows(rows).filter((r) => !SETTLED.includes(r.status) && !named.some((w) => w.name === r.name));
  return [...named, ...unnamed.map((r) => ({ name: r.name, site: r.site, domain: null, aliases: [] }))];
}

/** The alias domains as an operator types them into one field: separated by commas or spaces. */
export function typedAliases(text: string): string[] {
  return text.split(/[\s,]+/).map((a) => a.trim().toLowerCase()).filter((a) => a !== "");
}

/** Why the Websites section shows no domain for a website only the inventory names, as far as the page
 *  knows it: the catalog still loads, the route reads none for the tenant by design (its `reason`), it
 *  could not be read, or it answered and the registration names no website of that name. */
export function unknownDomainText(catalog: Pick<TenantAppCatalogView, "websites" | "reason" | "error"> | null): string {
  if (catalog === null) return "domain unknown while the tenant's catalog loads";
  if (catalog.error !== undefined) return "domain unknown: the tenant's catalog cannot be read";
  if (catalog.reason !== undefined) return "domain unknown: the catalog is not read for this tenant";
  return "domain unknown: the tenant's registration names no website of this name";
}

/** The apps the add-app control offers: the bundle's undeployed ones, in catalog order, no website
 *  folder among them. */
export function undeployedApps(catalog: readonly TenantCatalogAppView[], members: readonly string[] = []): TenantCatalogAppView[] {
  return catalog.filter((a) => !a.deployed && !members.includes(a.name) && a.sites === undefined);
}

/** The bundle's website folder, the one entry that lists sites, or null where it has none. */
export function websiteFolder(catalog: readonly TenantCatalogAppView[], websites: readonly { site: string }[] = []): TenantCatalogAppView | null {
  const folder = catalog.find((a) => a.sites !== undefined);
  const sites = folder?.sites?.filter((site) => !websites.some((w) => w.site === site)) ?? [];
  return folder && sites.length > 0 ? { ...folder, sites } : null;
}

/** The name a new website of `site` gets: clear of every member the tenant has and every app its
 *  catalog offers. An app is named by its folder, so a website holding that name would block the app
 *  for good. */
export function newWebsiteName(catalog: Pick<TenantAppCatalogView, "apps" | "members">, site: string): string {
  return websiteAppName(site, new Set([...(catalog.members ?? []), ...catalog.apps.map((a) => a.name)]));
}

/** What the confirm of a website's domain dialog does, as its label: move the website, change its
 *  aliases, or, with the domain and aliases as they stand, write the host records it misses. The
 *  server refuses the last where no record is missing. Null where no domain is typed. */
/** The confirm label of a website's move to another site on the bundle release `appsImageTag`, or
 *  null where nothing would move: no site typed, the site it serves, or no release named. */
export function websiteSiteConfirm(standing: string, next: string, appsImageTag: string): string | null {
  if (!next || next === standing || !appsImageTag) return null;
  return `Serve site ${next} on ${appsImageTag}`;
}

export function websiteDomainConfirm(standing: { domain: string; aliases: readonly string[] }, next: string, aliases: readonly string[]): string | null {
  if (!next) return null;
  if (next !== standing.domain) return `Serve at ${next}`;
  if (aliases.join() !== standing.aliases.join()) return "Set the aliases";
  return "Write the missing host records";
}
