// The card a run's unit stands on, for the run page's way back: the Consumers or the Tenants page,
// opened on the stage the run acted on. The executor knows no domain, so the run's target is resolved
// to its unit here; the runs API serves it (GET /api/runs/:id/unit-card).
import { eq } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { apps, tenants } from "../../db/schema/inventory.ts";
import type { RunUnitCardView } from "../../../shared/api-types.ts";

/** The card of the unit a run acts on, or null: a run on a consumer or a tenant stage names it by its
 *  target; a run on anything else (a cluster, a server), or on a unit whose row is gone, has none. */
export function runUnitCard(db: Db, run: { targetKind: string; targetId: string }): RunUnitCardView | null {
  if (run.targetKind === "app") {
    const a = db.select({ name: apps.name, stage: apps.stage }).from(apps).where(eq(apps.id, run.targetId)).get();
    return a ? { page: "consumers", key: a.name, label: a.name, stage: a.stage } : null;
  }
  if (run.targetKind === "tenant") {
    const t = db.select({ guid: tenants.guid, subdomain: tenants.subdomain, stage: tenants.stage }).from(tenants).where(eq(tenants.id, run.targetId)).get();
    return t ? { page: "tenants", key: t.guid, label: t.subdomain, stage: t.stage } : null;
  }
  return null;
}
