import type { Hono } from "hono";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import type { AppEnv } from "../../http/app-env.ts";
import type { Db } from "../../db/client.ts";
import { unitSizes } from "../../db/schema/inventory.ts";
import { errValidation, errNotFound, errNotConfigured } from "../../kernel/errors.ts";
import { UNIT_SIZE, SIZE_COMPONENT, type UnitSize, type SizeComponent } from "../../../shared/unit-size.ts";
import { listUnitSizes, explainUnitQuota } from "./unit-size.ts";
import { SetSizeParams, TenantSetSizeParams, TENANT_BRINGS, consumerComposition } from "./set-size.run.ts";
import { assertTenantProvisioned, loadTenantStatus } from "./api.ts";
import { loadAppCluster } from "./lifecycle.ts";
import type { Registry } from "./registry.ts";
import type { Executor } from "../../executor/executor.ts";

// The size table's own API — read it, and change one size.
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
  /** Absent ⇒ onboarding is not configured on this controller: the table stays readable and editable
   *  (it is what this installation sells, whether or not it can currently deploy anything), and the
   *  two run kinds that put a UNIT on a size answer 501. */
  executor?: Executor;
  /** The consumer registration registry, for reading what a consumer BRINGS — its own PostgreSQL, its
   *  own MongoDB — so the size picker can compose the figures that unit would actually get. Absent ⇒
   *  consumer onboarding is unwired and the picker says its figures are the base rows only. */
  registry?: Registry;
  onboardingEnabled: boolean;
  tenantEnabled: boolean;
}

export function registerUnitSizeRoutes(app: Hono<AppEnv>, deps: UnitSizeApiDeps): void {
  const { db, executor, registry, onboardingEnabled, tenantEnabled } = deps;

  // The whole table, in the vocabulary's order. Unconditional: it is a read, it needs no adapter, and
  // it answers on a controller with onboarding switched off — the sizes are what this installation
  // sells whether or not it can currently onboard anything.
  app.get("/api/unit-sizes", (c) => c.json({ sizes: listUnitSizes(db) }));

  // One ROW, addressed by both halves of its key. A row is a component at a size — what `base` means
  // at `medium`, what a `mongodb` MEMBER costs at `medium` — because a unit's ceiling is summed from
  // its parts and each part is priced on its own.
  app.put("/api/unit-sizes/:component/:name", async (c) => {
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

  // ---- What the three sizes cost ONE unit ----
  //
  // The bare table is nine rows and a unit is a SUM of some of them, so a picker that showed the table
  // would be asking an operator to add up base + postgresql + mongodb x members in their head and
  // approve the result. These two routes do that sum, for the unit named in the path and with what it
  // actually brings, and hand back the parts beside the total so the number can be read back to where
  // it came from. Same composer as the run that writes the registration — one arithmetic, not two.

  app.get("/api/consumers/:appId/sizes", async (c) => {
    const ac = loadAppCluster(db, c.req.param("appId"));
    // No registry ⇒ consumer onboarding is unwired and the registration cannot be read. The unit's
    // composition is unknown, so the honest answer is the base rows and a word saying why: guessing
    // "brings nothing" would quote a customer a ceiling that is too small.
    const brings = registry ? await consumerComposition(registry, ac) : { postgresql: false, mongodb: "shared" as const };
    return c.json({
      unit: ac.name,
      brings,
      composed: registry !== undefined,
      sizes: UNIT_SIZE.map((name) => ({ name, ...explainUnitQuota(db, name, brings) })),
    });
  });

  app.get("/api/tenants/:id/sizes", (c) => {
    const id = c.req.param("id");
    // Answers only for a tenant this controller knows: loadTenantStatus throws 404 otherwise, so an
    // unknown id gets a refusal rather than a plausible-looking quote for nothing.
    loadTenantStatus(db, id);
    // A tenant brings no database of its own — its members claim the cluster's shared MongoDB replica
    // set — so its figures are the base rows, and they bound EACH member namespace rather than the
    // tenant as a whole.
    return c.json({
      unit: id,
      brings: TENANT_BRINGS,
      composed: true,
      sizes: UNIT_SIZE.map((name) => ({ name, ...explainUnitQuota(db, name, TENANT_BRINGS) })),
    });
  });

  // ---- Putting a UNIT on a size: the two run kinds, one per family ----
  //
  // They live here beside the table and not with the other consumer/tenant routes, because they are
  // the other half of one mechanism: the table says what a size means, these two are the only way that
  // meaning reaches something already deployed. Both take a body of one field — the size name, which
  // no row can answer, because it is the operator's choice — validated through the run's OWN params
  // schema, one contract.

  app.post("/api/consumers/:appId/size", async (c) => {
    if (!onboardingEnabled || !executor) throw errNotConfigured("onboarding is not configured on this controller");
    const body = (await c.req.json().catch(() => ({}))) as { size?: unknown };
    const parsed = SetSizeParams.safeParse({ appId: c.req.param("appId"), size: body.size });
    if (!parsed.success) throw errValidation(`invalid size request: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    return c.json(await executor.plan("set-size", parsed.data), 201);
  });

  // A provisioning tenant is refused for the same reason tenant-suspend is: its registration may never
  // have been written at all, and a field write into a file that is not there is not a resize.
  app.post("/api/tenants/:id/size", async (c) => {
    if (!tenantEnabled || !executor) throw errNotConfigured("tenant onboarding is not configured on this controller");
    const id = c.req.param("id");
    assertTenantProvisioned(loadTenantStatus(db, id), "resizing it");
    const body = (await c.req.json().catch(() => ({}))) as { size?: unknown };
    const parsed = TenantSetSizeParams.safeParse({ tenantId: id, size: body.size });
    if (!parsed.success) throw errValidation(`invalid tenant size request: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    return c.json(await executor.plan("tenant-set-size", parsed.data), 201);
  });
}
