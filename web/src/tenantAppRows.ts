import type { TenantCatalogAppView } from "../../shared/apps-manifest.ts";

// The Apps list of the tenant page, stated once and out of the component: the tenant's own catalog
// (its bundle's apps.yaml, each marked deployed off the registration) folded with the inventory's
// per-app rows (what a run recorded, with its status and its last run). One row per app name.
//
// The catalog leads, in its own order, so the page reads as the bundle: what stands in the tenant's
// repository, deployed or not. An inventory row the catalog does not name follows — an app removed
// from the bundle after it was deployed, or every row while the catalog is unreadable — because a
// recorded app that vanished from the list would read as never deployed.

/** One inventory row as the page needs it: the fields the row renders and the remove needs. */
export interface TenantAppRowInput {
  id: string;
  name: string;
  status: string;
  lastRunId: string | null;
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

export function tenantAppRows<R extends TenantAppRowInput>(catalog: readonly TenantCatalogAppView[], rows: readonly R[]): TenantAppRow<R>[] {
  const byName = new Map(rows.map((r) => [r.name, r]));
  const listed = catalog.map((entry) => ({ name: entry.name, entry, row: byName.get(entry.name) ?? null, deployed: entry.deployed }));
  const named = new Set(catalog.map((e) => e.name));
  const rest = rows.filter((r) => !named.has(r.name)).map((row) => ({ name: row.name, entry: null, row, deployed: true }));
  return [...listed, ...rest];
}

/** The apps the add-app control offers: the bundle's undeployed ones, in catalog order. */
export function undeployedApps(catalog: readonly TenantCatalogAppView[]): TenantCatalogAppView[] {
  return catalog.filter((a) => !a.deployed);
}
