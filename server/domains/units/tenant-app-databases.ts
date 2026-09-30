// tenant-app-databases.ts — the database list of every app of every standing tenant, as its own
// repository declares it, in the registration's apps[] entries.
//
// Every member of a tenant reads the lists in `tenant.apps`, which the tenant ApplicationSet hands
// over verbatim from the registration. create-tenant and add-app write a new app's list off the
// template catalog its entry is copied from. A standing tenant's lists come from its own repository,
// which may carry apps and sites the template never offered: tenant-refresh-members and
// tenant-set-website-domain read them there, and the boot pass below writes them into every standing
// tenant.
import { notInArray } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { tenants } from "../../db/schema/inventory.ts";
import { TENANT_SETTLED_STATUS } from "../../../shared/enums.ts";
import type { AppsManifest } from "../../../shared/apps-manifest.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { TenantRegistration } from "../../../shared/tenant.ts";
import type { TenantRegistrations } from "./tenant-registrations.ts";
import { catalogDatabases } from "./tenant-fanout.ts";

/** Reads a standing tenant's own bundle manifest (engine-line.ts tenantBundleManifest): null where it
 *  runs no bundle; throws where it cannot be read. */
export type TenantManifestReader = (bundle: Pick<TenantRegistration, "appsRepo" | "appsImageTag">, signal?: AbortSignal) => Promise<AppsManifest | null>;

/** Each app's database list of a standing tenant, by app name, as its own repository declares it.
 *  Where that repository cannot be read, or the tenant runs no bundle, the lists stay as the
 *  registration holds them and the log says why: a failed read never drops a list. */
export async function standingAppDatabases(read: TenantManifestReader, entry: Pick<TenantRegistration, "apps" | "appsRepo" | "appsImageTag">, ctx: { log: (line: string) => void; signal: AbortSignal }): Promise<Record<string, string[]>> {
  let why: string;
  try {
    const own = await read(entry, ctx.signal);
    if (own) return catalogDatabases(entry.apps, own);
    why = "the tenant runs no apps bundle";
  } catch (err) {
    why = err instanceof Error ? err.message : String(err);
  }
  ctx.log(`${why}; the apps' database lists stay as the registration holds them`);
  return Object.fromEntries(entry.apps.flatMap((a) => (a.databases ? [[a.name, [...a.databases]]] : [])));
}

/** Every tenant that is not offboarded or purged, its apps[] entries given the database list its own
 *  repository declares for each app: the forward step for the tenants registered before the lists
 *  were carried, and the pass that keeps them as the tenant's repository declares them, run once at
 *  every boot. Only apps[].databases changes, in one commit per tenant whose lists differ. Never
 *  rejects: a tenant whose repository cannot be read, or whose write fails, is named in the log and
 *  left as it stands, and the others go on. */
export async function ensureTenantAppDatabases(deps: { db: Db; registrations: TenantRegistrations; readTenantManifest: TenantManifestReader; logger: Logger }): Promise<{ written: string[]; failed: string[] }> {
  const rows = deps.db.select({ guid: tenants.guid, stage: tenants.stage }).from(tenants).where(notInArray(tenants.status, [...TENANT_SETTLED_STATUS])).all();
  const written: string[] = [];
  const failed: string[] = [];
  for (const { stage, guid } of rows) {
    try {
      const current = await deps.registrations.readTenant(stage, guid);
      const own = current ? await deps.readTenantManifest(current.entry) : null;
      if (!own) continue;
      const outcome = await deps.registrations.setAppDatabases(stage, guid, (apps) => catalogDatabases(apps, own), "boot");
      if (!outcome) continue;
      written.push(`${stage}/${guid}`);
      deps.logger.info({ stage, guid, commit: outcome.commit }, `tenant ${stage}/${guid}: its apps' database lists written into tenant.apps as its own repository declares them`);
    } catch (err) {
      failed.push(`${stage}/${guid}`);
      deps.logger.error({ stage, guid, err: err instanceof Error ? err.message : String(err) }, `the app database lists of tenant ${stage}/${guid} could not be written; its members read the lists written before until the next boot writes them`);
    }
  }
  deps.logger.info({ written, failed }, `tenant app database lists: ${written.length} tenant(s) written, ${rows.length - written.length - failed.length} already standing or without a bundle, ${failed.length} failed`);
  return { written, failed };
}
