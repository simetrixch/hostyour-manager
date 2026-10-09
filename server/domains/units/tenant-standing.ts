import { eq } from "drizzle-orm";
import { clusters } from "../../db/schema/inventory.ts";
import type { StepCtx } from "../../executor/types.ts";
import { errNotFound, errValidation } from "../../kernel/errors.ts";
import { TENANT_SETTLED_STATUS } from "../../../shared/enums.ts";
import type { TenantRegistration } from "../../../shared/tenant.ts";
import type { TenantOnboardPorts } from "./create-tenant.run.ts";
import { loadTenantCluster, type TenantCluster } from "./lifecycle.ts";
import { assertTenantProvisioned, loadTenantStatus } from "./tenant-provisioned.ts";

/** The target and members a run that changes one setting of a standing tenant planned against. */
export interface PlannedTenant {
  tenantId: string;
  guid: string;
  clusterId: string;
  members: readonly string[];
}

/** The tenant a one-setting run acts on, read again now: its registration, with the refusals every such
 *  run makes before it writes. A tenant that is provisioning, suspended or removed has no running
 *  members to render the setting, and a moved cluster or changed members mean the run was planned
 *  against another tenant than the one that stands. `change` names the setting in the messages. */
export async function readStandingTenant(
  ports: Pick<TenantOnboardPorts, "registrations">,
  planned: PlannedTenant,
  ctx: Pick<StepCtx, "db">,
  change: string,
): Promise<{ tc: TenantCluster; entry: TenantRegistration }> {
  const tc = loadTenantCluster(ctx.db, planned.tenantId);
  const status = loadTenantStatus(ctx.db, planned.tenantId);
  assertTenantProvisioned(status, `setting ${change}`);
  const current = await ports.registrations.readTenant(tc.stage, tc.guid);
  if (!current) throw errNotFound(`tenant ${tc.guid} has no registration at ${tc.stage}`);
  const cluster = ctx.db.select({ name: clusters.name }).from(clusters).where(eq(clusters.id, tc.clusterId)).get();
  if (tc.guid !== planned.guid || tc.clusterId !== planned.clusterId || current.entry.cluster !== cluster?.name || current.entry.members.map((m) => m.name).join(",") !== planned.members.join(",")) {
    throw errValidation(`the tenant target or members changed since this change of ${change} was planned — plan it again`);
  }
  if (current.entry.suspended || (TENANT_SETTLED_STATUS as readonly string[]).includes(status.status)) {
    throw errValidation(`tenant ${tc.subdomain} is suspended or removed — ${change} needs running members`);
  }
  return { tc, entry: current.entry };
}
