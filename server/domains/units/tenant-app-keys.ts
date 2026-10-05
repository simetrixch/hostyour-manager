// tenant-app-keys.ts — the keys of every tenant app, one Vault entry per app and kind.
//
// WHAT THEY ARE. A digita engine encrypts a stored Password field value with AES-256-GCM, and every
// app of every tenant has its own key: a database or a backup of one app cannot be decrypted with
// another app's or another tenant's key. An engine whose catalog has a Password field refuses to
// start without it. A website's engine also tells its renderer to drop its cache after a save, and
// signs that call with a revalidate secret the renderer checks; a website engine refuses to start
// without it. A website's renderer signs each record form it places with a form signing key, and
// refuses a post no such form could send; a website renderer refuses to start without it.
//
// WHERE THEY STAND. One Vault entry per app and kind, <stage>/tenants/<guid>/<kind>/<app>, one level
// below the tenant's entry: that entry is written create-only and takes no property later, so an app
// joining a standing tenant could never be given its key there. The tenant's members read the
// subpaths through the same templated policy as the entry above them.
//
// WRITTEN CREATE-ONLY AND NEVER READ. Every stored value of the app decrypts with its Password field
// key alone, and an engine and its renderer agree only while their secret stays the same, so the
// write refuses to replace a key that stands, and the manager holds no read grant on it. That is also
// what lets the boot pass below ask for every app on every start: an app that has its key answers
// "exists", and nothing about the key is learned.
import { and, eq, notInArray } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { tenants, tenantApps } from "../../db/schema/inventory.ts";
import { TENANT_SETTLED_STATUS, type Stage } from "../../../shared/enums.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { TenantAppKeyKind, VaultSeeder } from "#unit/server/adapters/vault/seeder-port.ts";
import type { TenantRegistrations } from "./tenant-registrations.ts";
import { mintAes256Key } from "#unit/server/secret-mint.ts";
import type { Step, StepCtx } from "../../executor/types.ts";
import { errValidation } from "../../kernel/errors.ts";

/** What a person reads about each kind of key: its name, and what an app lacks without it. */
const KEY_KIND_TEXT: Record<TenantAppKeyKind, { keys: string; key: string; lacking: string }> = {
  "password-field-key": { keys: "Password field keys", key: "Password field key", lacking: "an engine without its key cannot encrypt a Password field" },
  "revalidate-secret": { keys: "Revalidate secrets", key: "revalidate secret", lacking: "a website engine without its secret does not start" },
  "form-signing-key": { keys: "Form signing keys", key: "form signing key", lacking: "a website renderer without its key does not start" },
  "service-key": { keys: "Service keys", key: "service key", lacking: "an engine without its key gets no mail token from its identity provider" },
};

export interface TenantAppKeysOutcome {
  /** The apps whose key this call wrote. */
  created: string[];
  /** The apps whose key already stood, and was left as it was. */
  existing: string[];
}

/** Writes a fresh key of [kind] for each of [apps] of one tenant, create-only: 32 random bytes as
 *  base64, under the property its kind names, as the app's charts read it. */
export async function seedTenantAppKeys(seeder: VaultSeeder, kind: TenantAppKeyKind, stage: Stage, guid: string, apps: readonly string[]): Promise<TenantAppKeysOutcome> {
  const outcome: TenantAppKeysOutcome = { created: [], existing: [] };
  for (const app of apps) {
    const { created } = await seeder.seedTenantAppKey({ stage, guid, kind, app, data: { [kind]: mintAes256Key() } });
    (created ? outcome.created : outcome.existing).push(app);
  }
  return outcome;
}

/** One line for a run's log, naming what was written and what already stood. */
export function tenantAppKeysLine(kind: TenantAppKeyKind, stage: Stage, guid: string, outcome: TenantAppKeysOutcome): string {
  const parts = [
    outcome.created.length > 0 ? `written for ${outcome.created.join(", ")}` : null,
    outcome.existing.length > 0 ? `already standing for ${outcome.existing.join(", ")} and left untouched` : null,
  ].filter((p): p is string => p !== null);
  return `${KEY_KIND_TEXT[kind].keys} under ${stage}/tenants/${guid}/${kind}/: ${parts.length > 0 ? parts.join("; ") : "no app to key"}`;
}

/** Creation seeds every app's Password field key and service key before the registration starts the
 *  engines that read them. */
export async function seedTenantEngineKeys(seeder: VaultSeeder, stage: Stage, guid: string, apps: readonly string[], ctx: Pick<StepCtx, "log">): Promise<{ appKeys: TenantAppKeysOutcome; serviceKeys: TenantAppKeysOutcome }> {
  const appKeys = await seedTenantAppKeys(seeder, "password-field-key", stage, guid, apps);
  ctx.log("meta", tenantAppKeysLine("password-field-key", stage, guid, appKeys));
  const serviceKeys = await seedTenantAppKeys(seeder, "service-key", stage, guid, apps);
  ctx.log("meta", tenantAppKeysLine("service-key", stage, guid, serviceKeys));
  return { appKeys, serviceKeys };
}

/** Creation seeds the website keys before the registration starts their engines and renderers. */
export async function seedTenantWebsiteKeys(seeder: VaultSeeder, stage: Stage, guid: string, apps: readonly { name: string; domain?: string }[], ctx: Pick<StepCtx, "log">): Promise<(TenantAppKeysOutcome & { kind: TenantAppKeyKind })[]> {
  const websites = apps.filter((a) => a.domain).map((a) => a.name);
  const outcomes = [];
  for (const kind of ["revalidate-secret", "form-signing-key"] as const) {
    const keys = await seedTenantAppKeys(seeder, kind, stage, guid, websites);
    outcomes.push({ kind, ...keys });
    ctx.log("meta", tenantAppKeysLine(kind, stage, guid, keys));
  }
  return outcomes;
}

/** The step that writes one app's key of [kind] as it joins a standing tenant (add-app). It stands
 *  before the step that appends the app to the registration, because the append is what makes the
 *  master's ArgoCD generate the app's engine, and that engine reads the key. */
export function seedTenantAppKeyStep(seeder: VaultSeeder | undefined, kind: TenantAppKeyKind, stage: Stage, guid: string, app: string): Step {
  const text = KEY_KIND_TEXT[kind];
  return {
    name: `seed-${kind}`,
    title: `Write the new app's ${text.key}`,
    run: async (ctx) => {
      if (!seeder) throw errValidation(`no Vault seeder is wired — the new app's ${text.key} cannot be written, and ${text.lacking}`);
      const appKeys = await seedTenantAppKeys(seeder, kind, stage, guid, [app]);
      ctx.checkpoint({ appKeys });
      ctx.log("meta", tenantAppKeysLine(kind, stage, guid, appKeys));
    },
  };
}

/** Every tenant app of every tenant that is not offboarded or purged, given its Password field key and
 *  its service key where it has none, and every website among them its revalidate secret and its form
 *  signing key.
 *  The forward step for the apps that joined before these keys were minted, run once at every boot.
 *  Which apps are websites is read off the tenant's registration: an apps[] entry that names a
 *  domain. Never rejects: a kind of key a tenant could not be given is named in the log, and the
 *  others go on. */
export async function ensureTenantAppKeys(deps: { db: Db; seeder: VaultSeeder; registrations: Pick<TenantRegistrations, "readTenant">; logger: Logger }): Promise<{ created: number; existing: number; failed: string[] }> {
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
  // Each kind on its own: a grant missing for one kind leaves the other written.
  const ensure = async (kind: TenantAppKeyKind, stage: Stage, guid: string, appsOf: () => Promise<string[]>): Promise<void> => {
    try {
      const outcome = await seedTenantAppKeys(deps.seeder, kind, stage, guid, await appsOf());
      created += outcome.created.length;
      existing += outcome.existing.length;
      // A running engine read its environment at its start, so a key written now reaches it only at
      // its next restart; the line says so where the person reading it decides.
      if (outcome.created.length > 0) deps.logger.info({ stage, guid, kind, apps: outcome.created }, `${tenantAppKeysLine(kind, stage, guid, outcome)} — an engine of these apps that is already running takes its key at its next restart (tenant-restart-workloads)`);
    } catch (err) {
      failed.push(`${stage}/${guid}/${kind}`);
      deps.logger.error({ stage, guid, kind, err: err instanceof Error ? err.message : String(err) }, `the ${KEY_KIND_TEXT[kind].keys} of tenant ${stage}/${guid} could not be written, and ${KEY_KIND_TEXT[kind].lacking}; the next boot tries again`);
    }
  };
  for (const { stage, guid, apps } of byTenant.values()) {
    await ensure("password-field-key", stage, guid, async () => apps);
    await ensure("service-key", stage, guid, async () => apps);
    const websites = async (): Promise<string[]> =>
      ((await deps.registrations.readTenant(stage, guid))?.entry.apps ?? []).filter((a) => a.domain && apps.includes(a.name)).map((a) => a.name);
    await ensure("revalidate-secret", stage, guid, websites);
    await ensure("form-signing-key", stage, guid, websites);
  }
  deps.logger.info({ created, existing, failed }, `tenant app keys: ${created} written, ${existing} already standing, ${failed.length} failed`);
  return { created, existing, failed };
}
