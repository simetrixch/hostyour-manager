// tenant-app-keys.ts — the Password field key of every tenant app (hostyour-manager#329).
//
// WHAT IT IS. A digita engine encrypts a stored Password field value with AES-256-GCM, and every app
// of every tenant has its own key: a database or a backup of one app cannot be decrypted with another
// app's or another tenant's key. An engine whose catalog has a Password field refuses to start
// without it.
//
// WHERE IT STANDS. One Vault entry per app, <stage>/tenants/<guid>/password-field-key/<app>, one
// level below the tenant's entry: that entry is written create-only and takes no property later, so
// an app joining a standing tenant could never be given its key there. The tenant's members read the
// subpath through the same templated policy as the entry above it.
//
// WRITTEN CREATE-ONLY AND NEVER READ. Every stored value of the app decrypts with this key alone, so
// the write refuses to replace one that stands, and the manager holds no read grant on it. That is
// also what lets the boot pass below ask for every app on every start: an app that has its key
// answers "exists", and nothing about the key is learned.
import { and, eq, notInArray } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { tenants, tenantApps } from "../../db/schema/inventory.ts";
import { TENANT_SETTLED_STATUS, type Stage } from "../../../shared/enums.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { VaultSeeder } from "#unit/server/adapters/vault/seeder-port.ts";
import { mintAes256Key } from "#unit/server/secret-mint.ts";
import type { Step } from "../../executor/types.ts";
import { errValidation } from "../../kernel/errors.ts";

/** The property an app's key stands under in its own entry, as the engine's chart reads it. */
export const TENANT_APP_KEY_PROPERTY = "password-field-key";

export interface TenantAppKeysOutcome {
  /** The apps whose key this call wrote. */
  created: string[];
  /** The apps whose key already stood, and was left as it was. */
  existing: string[];
}

/** Writes a fresh key for each of [apps] of one tenant, create-only. */
export async function seedTenantAppKeys(seeder: VaultSeeder, stage: Stage, guid: string, apps: readonly string[]): Promise<TenantAppKeysOutcome> {
  const outcome: TenantAppKeysOutcome = { created: [], existing: [] };
  for (const app of apps) {
    const { created } = await seeder.seedTenantAppKey({ stage, guid, app, data: { [TENANT_APP_KEY_PROPERTY]: mintAes256Key() } });
    (created ? outcome.created : outcome.existing).push(app);
  }
  return outcome;
}

/** One line for a run's log, naming what was written and what already stood. */
export function tenantAppKeysLine(stage: Stage, guid: string, outcome: TenantAppKeysOutcome): string {
  const parts = [
    outcome.created.length > 0 ? `written for ${outcome.created.join(", ")}` : null,
    outcome.existing.length > 0 ? `already standing for ${outcome.existing.join(", ")} and left untouched` : null,
  ].filter((p): p is string => p !== null);
  return `Password field keys under ${stage}/tenants/${guid}/password-field-key/: ${parts.length > 0 ? parts.join("; ") : "no app to key"}`;
}

/** The step that writes one app's key as it joins a standing tenant (add-app). It stands before the
 *  step that appends the app to the registration, because the append is what makes the master's
 *  ArgoCD generate the app's engine, and that engine reads the key. */
export function seedPasswordFieldKeyStep(seeder: VaultSeeder | undefined, stage: Stage, guid: string, app: string): Step {
  return {
    name: "seed-password-field-key",
    title: "Write the new app's Password field key",
    run: async (ctx) => {
      if (!seeder) throw errValidation("no Vault seeder is wired — the new app's Password field key cannot be written, and its engine cannot encrypt a Password field without it");
      const appKeys = await seedTenantAppKeys(seeder, stage, guid, [app]);
      ctx.checkpoint({ appKeys });
      ctx.log("meta", tenantAppKeysLine(stage, guid, appKeys));
    },
  };
}

/** Every tenant app of every tenant that is not offboarded or purged, given its key where it has
 *  none. The forward step for the apps that joined before keys were minted, run once at every boot.
 *  Never rejects: a tenant whose write fails is named in the log, and the others go on. */
export async function ensureTenantAppKeys(deps: { db: Db; seeder: VaultSeeder; logger: Logger }): Promise<{ created: number; existing: number; failed: string[] }> {
  const rows = deps.db
    .select({ guid: tenants.guid, stage: tenants.stage, app: tenantApps.name })
    .from(tenantApps)
    .innerJoin(tenants, eq(tenants.id, tenantApps.tenantId))
    .where(and(notInArray(tenants.status, [...TENANT_SETTLED_STATUS]), notInArray(tenantApps.status, [...TENANT_SETTLED_STATUS])))
    .all();
  const byTenant = new Map<string, { stage: Stage; guid: string; apps: string[] }>();
  for (const row of rows) {
    const key = `${row.stage}/${row.guid}`;
    const entry = byTenant.get(key) ?? { stage: row.stage, guid: row.guid, apps: [] };
    entry.apps.push(row.app);
    byTenant.set(key, entry);
  }
  let created = 0;
  let existing = 0;
  const failed: string[] = [];
  for (const { stage, guid, apps } of byTenant.values()) {
    try {
      const outcome = await seedTenantAppKeys(deps.seeder, stage, guid, apps);
      created += outcome.created.length;
      existing += outcome.existing.length;
      if (outcome.created.length > 0) deps.logger.info({ stage, guid, apps: outcome.created }, tenantAppKeysLine(stage, guid, outcome));
    } catch (err) {
      failed.push(`${stage}/${guid}`);
      deps.logger.error({ stage, guid, err: err instanceof Error ? err.message : String(err) }, `the Password field keys of tenant ${stage}/${guid} could not be written; its apps' engines cannot encrypt a Password field until they are`);
    }
  }
  deps.logger.info({ created, existing, failed }, `tenant app keys: ${created} written, ${existing} already standing, ${failed.length} tenant(s) failed`);
  return { created, existing, failed };
}
