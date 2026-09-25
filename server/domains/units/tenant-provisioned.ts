// The refusal every tenant route that assumes a LIVE tenant makes, and the read it makes it from. In a
// module of its own so the route files that make it (api.ts, api-unit-sizes.ts, api-tenant-routing.ts)
// import it without importing each other.
import { eq } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { tenants } from "../../db/schema/inventory.ts";
import { errNotFound, errValidation } from "../../kernel/errors.ts";
import type { TenantStatus } from "../../../shared/enums.ts";

/** The two columns every provisional refusal needs; 404 when the tenant row is absent. */
export function loadTenantStatus(db: Db, id: string): { subdomain: string; status: TenantStatus } {
  const row = db.select({ subdomain: tenants.subdomain, status: tenants.status }).from(tenants).where(eq(tenants.id, id)).get();
  if (!row) throw errNotFound(`tenant ${id}`);
  return row;
}

/** Refuse an action that assumes a LIVE tenant when the tenant's create-tenant run never finished
 *. Since create-tenant now records its row BEFORE it deploys (record-provisional),
 *  a "provisioning" row means the tenant may have no namespace, no example-auth ingress and no fan-out at
 *  all — every such action would burn a watch timeout or hit a raw DNS/connect error and blame the wrong
 *  thing. SERVER-SIDE and unconditional: the Tenants UI hides these actions too, but a hidden button is a
 *  convenience, not a guard — this route is the only place the refusal actually holds. The message names
 *  the two ways out because they are genuinely the whole option set: finish the create-tenant run, or
 *  remove the tenant (offboard/purge). Modelled on the `suspended` refusal on the invite route. */
export function assertTenantProvisioned(t: { subdomain: string; status: TenantStatus }, action: string): void {
  if (t.status !== "provisioning") return;
  throw errValidation(
    `tenant ${t.subdomain} is still provisioning — its create-tenant run never finished, so it may not be deployed at all and ${action} would act on a tenant that is not there. Finish the create-tenant run, or offboard/purge the tenant.`,
  );
}
