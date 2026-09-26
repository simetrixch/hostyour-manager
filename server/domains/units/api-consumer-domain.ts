// The consumer's domain route, apart from api.ts the way the tenant's own-domain route is: POST
// /api/consumers/:name/stages/:stage/fqdn plans consumer-set-domain (consumer-domain.run.ts) with the
// domain the body names ("" clears it), validated through the run's OWN params schema. Keyed on the
// consumer's name and stage rather than on its row, so a caller that knows a consumer by its name
// reaches the same route. Approve via the Runs API.
import type { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import type { AppEnv } from "../../http/app-env.ts";
import type { Db } from "../../db/client.ts";
import type { Executor } from "../../executor/executor.ts";
import { errNotConfigured, errNotFound, errValidation } from "../../kernel/errors.ts";
import { apps } from "../../db/schema/inventory.ts";
import { STAGE, type Stage } from "../../../shared/enums.ts";
import { CONSUMER_DOMAIN_ROUTE } from "../../../shared/consumer.ts";
import type { Registrations } from "#unit/server/registrations.ts";
import { ConsumerSetDomainParams } from "./consumer-domain.run.ts";

export interface ConsumerDomainApiDeps {
  db: Db;
  executor: Executor;
  /** The consumer registrations the standing domain is read from. Absent ⇒ consumer onboarding is
   *  not configured, and the route answers 501. */
  registrations?: Registrations;
  onboardingEnabled: boolean;
}

export function registerConsumerDomainRoutes(app: Hono<AppEnv>, deps: ConsumerDomainApiDeps): void {
  const { db, executor, registrations, onboardingEnabled } = deps;
  app.post(CONSUMER_DOMAIN_ROUTE, async (c) => {
    if (!onboardingEnabled || !registrations) throw errNotConfigured("onboarding is not configured on this manager");
    const name = c.req.param("name");
    const stage = c.req.param("stage");
    if (!(STAGE as readonly string[]).includes(stage)) throw errValidation(`invalid domain request: stage "${stage}" is none of ${STAGE.join(", ")}`);
    const row = db.select({ id: apps.id }).from(apps).where(and(eq(apps.name, name), eq(apps.stage, stage as Stage))).get();
    if (!row) throw errNotFound(`consumer ${name} at ${stage}`);
    const body = (await c.req.json().catch(() => ({}))) as { fqdn?: unknown };
    // The domain the consumer answers at now: what an abort of the switch records again.
    const now = (await registrations.readRegistration(stage as Stage, name))?.entry.fqdn ?? "";
    const parsed = ConsumerSetDomainParams.safeParse({ appId: row.id, fqdn: body.fqdn, previous: now });
    if (!parsed.success) throw errValidation(`invalid domain request: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    return c.json(await executor.plan("consumer-set-domain", parsed.data), 201);
  });
}
