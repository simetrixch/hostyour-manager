import type { Hono } from "hono";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import type { AppEnv } from "#core/server/http/app-env.ts";
import type { Db } from "#core/server/db/client.ts";
import { unitSizes } from "#core/server/db/schema/inventory.ts";
import { errValidation, errNotFound } from "#core/server/kernel/errors.ts";
import { UNIT_SIZE, SIZE_COMPONENT, type UnitSize, type SizeComponent } from "../shared/unit-size.ts";
import { listUnitSizes } from "./unit-size.ts";

// The size table's own API — read it, and change one size. Registered by the unit plugin's routes
// hook, so the core serves both under /api/unit.
//
// WHAT AN EDIT HERE DOES, AND WHAT IT DOES NOT. It changes what the WORDS mean, for every unit
// registered from this moment on. It reaches no running unit: a unit's registration carries the
// FIGURES it was written with, so a consumer sized `medium` yesterday keeps yesterday's medium until
// something rewrites its registration. That is the set-size run's job, and the separation is
// deliberate — re-pricing a table and re-sizing a customer are two acts, and doing the second by
// accident while meaning the first is how a live namespace gets a ceiling nobody approved.
//
// THE VALUES ARE CHECKED, not just typed. A ResourceQuota takes Kubernetes quantities, and an
// unparseable one is refused by the API server at APPLY time — on the cluster, inside an ArgoCD sync,
// long after the operator typed it and with no path back to this screen. So the grammar is enforced
// here, where the person who typed it is still looking.

/** The Kubernetes quantity grammar, narrowed to what a CPU or memory figure of a quota is: a decimal
 *  number with an optional suffix. Deliberately NOT the full spec (no exponent form, no negatives) —
 *  a quota figure is a plain amount, and accepting `1e3` here would mean accepting it in a screen an
 *  operator reads back to check what a customer gets. */
const QUANTITY = /^\d+(\.\d+)?(m|k|M|G|T|P|E|Ki|Mi|Gi|Ti|Pi|Ei)?$/;

const quantity = z.string().min(1).regex(QUANTITY, {
  message: 'must be a Kubernetes quantity — a number with an optional unit, e.g. "500m", "2", "1Gi", "512Mi"',
});

/** What a PUT may change: the six figures, all of them, every time. There is no partial update — a
 *  size is read as a whole (a screen shows all six side by side), so a body that omits one would be
 *  a screen that silently kept a figure the operator believed they had replaced. */
export const UnitSizeUpdate = z.object({
  requestsCpu: quantity,
  requestsMemory: quantity,
  limitsCpu: quantity,
  limitsMemory: quantity,
  pods: z.number().int().positive(),
  persistentVolumeClaims: z.number().int().positive(),
});

export interface UnitSizeApiDeps {
  db: Db;
}

export function registerUnitSizeRoutes(app: Hono<AppEnv>, deps: UnitSizeApiDeps): void {
  const { db } = deps;

  // The whole table, in the vocabulary's order. Unconditional: it is a read, it needs no adapter, and
  // it answers on a manager with onboarding switched off — the sizes are what this installation
  // sells whether or not it can currently onboard anything.
  app.get("/sizes", (c) => c.json({ sizes: listUnitSizes(db) }));

  // One ROW, addressed by both halves of its key. A row is a component at a size — what `base` means
  // at `medium`, what a `mongodb` MEMBER costs at `medium` — because a unit's ceiling is summed from
  // its parts and each part is priced on its own.
  app.put("/sizes/:component/:name", async (c) => {
    const component = c.req.param("component");
    const name = c.req.param("name");
    if (!(SIZE_COMPONENT as readonly string[]).includes(component)) {
      throw errNotFound(`size component "${component}" — the components are ${SIZE_COMPONENT.join(", ")}`);
    }
    if (!(UNIT_SIZE as readonly string[]).includes(name)) {
      throw errNotFound(`unit size "${name}" — the sizes are ${UNIT_SIZE.join(", ")}`);
    }
    const parsed = UnitSizeUpdate.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      throw errValidation(`invalid size: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    }
    // UPDATE and not upsert: the nine rows are seeded at boot, so a missing one means the seed did
    // not run, and silently inserting here would hide that.
    const where = and(eq(unitSizes.component, component as SizeComponent), eq(unitSizes.name, name));
    db.update(unitSizes).set({ ...parsed.data, updatedAt: new Date() }).where(where).run();
    const row = db.select().from(unitSizes).where(where).get();
    if (!row) throw errNotFound(`unit size "${component}/${name}" — the size table holds no such row`);
    return c.json({ size: { component: component as SizeComponent, name: name as UnitSize, ...parsed.data } });
  });
}
