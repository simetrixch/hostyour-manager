// What the three sizes cost ONE unit, and the two run kinds that put a unit on a size — the other half
// of the size table (plugins/unit/server/api-unit-sizes.ts), which says what a size means.
import type { Hono } from "hono";
import type { AppEnv } from "../../http/app-env.ts";
import type { Db } from "../../db/client.ts";
import { errValidation, errNotConfigured } from "../../kernel/errors.ts";
import { UNIT_SIZE } from "#unit/shared/unit-size.ts";
import { explainUnitQuota } from "#unit/server/unit-size.ts";
import { SetSizeParams, TenantSetSizeParams, TENANT_BRINGS, consumerComposition } from "./set-size.run.ts";
import { assertTenantProvisioned, loadTenantStatus } from "./tenant-provisioned.ts";
import { loadAppCluster } from "./lifecycle.ts";
import type { Registrations } from "#unit/server/registrations.ts";
import type { Executor } from "../../executor/executor.ts";

export interface SetSizeApiDeps {
  db: Db;
  /** Absent ⇒ onboarding is not configured on this manager: the two run kinds that put a UNIT on a
   *  size answer 501. */
  executor?: Executor;
  /** The consumer registration registrations, for reading what a consumer BRINGS — its own PostgreSQL, its
   *  own MongoDB — so the size picker can compose the figures that unit would actually get. Absent ⇒
   *  consumer onboarding is unwired and the picker says its figures are the base rows only. */
  registrations?: Registrations;
  onboardingEnabled: boolean;
  tenantEnabled: boolean;
}

export function registerSetSizeRoutes(app: Hono<AppEnv>, deps: SetSizeApiDeps): void {
  const { db, executor, registrations, onboardingEnabled, tenantEnabled } = deps;

  // ---- What the three sizes cost ONE unit ----
  //
  // The bare table is nine rows and a unit is a SUM of some of them, so a picker that showed the table
  // would be asking an operator to add up base + postgresql + mongodb x members in their head and
  // approve the result. These two routes do that sum, for the unit named in the path and with what it
  // actually brings, and hand back the parts beside the total so the number can be read back to where
  // it came from. Same composer as the run that writes the registration — one arithmetic, not two.

  app.get("/api/consumers/:appId/sizes", async (c) => {
    const ac = loadAppCluster(db, c.req.param("appId"));
    // No registrations ⇒ consumer onboarding is unwired and the registration cannot be read. The unit's
    // composition is unknown, so the honest answer is the base rows and a word saying why: guessing
    // "brings nothing" would quote a customer a ceiling that is too small.
    const brings = registrations ? await consumerComposition(registrations, ac) : { postgresql: false, mongodb: "shared" as const };
    return c.json({
      unit: ac.name,
      brings,
      composed: registrations !== undefined,
      sizes: UNIT_SIZE.map((name) => ({ name, ...explainUnitQuota(db, name, brings) })),
    });
  });

  app.get("/api/tenants/:id/sizes", (c) => {
    const id = c.req.param("id");
    // Answers only for a tenant this manager knows: loadTenantStatus throws 404 otherwise, so an
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
    if (!onboardingEnabled || !executor) throw errNotConfigured("onboarding is not configured on this manager");
    const body = (await c.req.json().catch(() => ({}))) as { size?: unknown };
    const parsed = SetSizeParams.safeParse({ appId: c.req.param("appId"), size: body.size });
    if (!parsed.success) throw errValidation(`invalid size request: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    return c.json(await executor.plan("consumer-set-size", parsed.data), 201);
  });

  // A provisioning tenant is refused for the same reason tenant-suspend is: its registration may never
  // have been written at all, and a field write into a file that is not there is not a resize.
  app.post("/api/tenants/:id/size", async (c) => {
    if (!tenantEnabled || !executor) throw errNotConfigured("tenant onboarding is not configured on this manager");
    const id = c.req.param("id");
    assertTenantProvisioned(loadTenantStatus(db, id), "resizing it");
    const body = (await c.req.json().catch(() => ({}))) as { size?: unknown };
    const parsed = TenantSetSizeParams.safeParse({ tenantId: id, size: body.size });
    if (!parsed.success) throw errValidation(`invalid tenant size request: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    return c.json(await executor.plan("tenant-set-size", parsed.data), 201);
  });
}
