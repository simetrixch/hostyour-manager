// tenant-app-databases.ts — the database list of every app of every standing tenant, as its catalog
// entry declares it, in the registration's apps[] entries.
//
// Every member of a tenant reads the lists in `tenant.apps`, which the tenant ApplicationSet hands
// over verbatim from the registration. create-tenant, add-app and tenant-refresh-members write them
// off the catalog their validation reads. A tenant registered before the lists were carried has none
// until the boot pass below writes them.
import { notInArray } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { tenants } from "../../db/schema/inventory.ts";
import { TENANT_SETTLED_STATUS } from "../../../shared/enums.ts";
import type { AppsManifest } from "../../../shared/apps-manifest.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { TenantRegistrations } from "./tenant-registrations.ts";
import { catalogDatabases } from "./tenant-fanout.ts";

/** Every tenant that is not offboarded or purged, its apps[] entries given the database list the
 *  catalog entry of each app's folder declares: the forward step for the tenants registered before
 *  the lists were carried, run once at every boot. Only apps[].databases changes, in one commit per
 *  tenant whose lists differ. Never rejects: a catalog that cannot be read writes nothing and answers
 *  null, a tenant whose write fails is named in the log, and the others go on. `readCatalog` throws
 *  on a failed read: a stand-in of no apps would drop every list. */
export async function ensureTenantAppDatabases(deps: { db: Db; registrations: TenantRegistrations; readCatalog: () => Promise<AppsManifest>; logger: Logger }): Promise<{ written: string[]; failed: string[] } | null> {
  let catalog: AppsManifest;
  try {
    catalog = await deps.readCatalog();
  } catch (err) {
    deps.logger.error({ err: err instanceof Error ? err.message : String(err) }, "the app catalog could not be read, so no tenant's app database lists were written; the next boot tries again");
    return null;
  }
  const rows = deps.db.select({ guid: tenants.guid, stage: tenants.stage }).from(tenants).where(notInArray(tenants.status, [...TENANT_SETTLED_STATUS])).all();
  const written: string[] = [];
  const failed: string[] = [];
  for (const { stage, guid } of rows) {
    try {
      const outcome = await deps.registrations.setAppDatabases(stage, guid, (apps) => catalogDatabases(apps, catalog), "boot");
      if (!outcome) continue;
      written.push(`${stage}/${guid}`);
      deps.logger.info({ stage, guid, commit: outcome.commit }, `tenant ${stage}/${guid}: its apps' database lists written into tenant.apps as the catalog declares them`);
    } catch (err) {
      failed.push(`${stage}/${guid}`);
      deps.logger.error({ stage, guid, err: err instanceof Error ? err.message : String(err) }, `the app database lists of tenant ${stage}/${guid} could not be written; its members read the lists written before until the next boot writes them`);
    }
  }
  deps.logger.info({ written, failed }, `tenant app database lists: ${written.length} tenant(s) written, ${rows.length - written.length - failed.length} already standing or not registered, ${failed.length} failed`);
  return { written, failed };
}
