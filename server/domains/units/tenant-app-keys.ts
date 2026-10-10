// tenant-app-keys.ts — the keys of every tenant app, one Vault entry per app and kind.
//
// WHAT THEY ARE. A digita engine encrypts a stored Password field value with AES-256-GCM, and every
// app of every tenant has its own key: a database or a backup of one app cannot be decrypted with
// another app's or another tenant's key. An engine whose catalog has a Password field refuses to
// start without it. A website's engine also tells the tenant web server to drop a site's cache after a
// save, and signs that call with a revalidate secret the web server checks; a website engine refuses
// to start without it. The tenant web server signs each record form it places with a form signing
// key, and refuses a post no such form could send; it refuses to start without it. The web server
// serves every site of the tenant, so both are one per tenant, under its member name `web`.
//
// WHERE THEY STAND. One Vault entry per app and kind, <stage>/tenants/<guid>/<kind>/<app>, and the two
// website keys at <stage>/tenants/<guid>/<kind>/web, one level below the tenant's entry: that entry is written create-only and takes no property later, so an app
// joining a standing tenant could never be given its key there. The tenant's members read the
// subpaths through the same templated policy as the entry above them.
//
// WRITTEN CREATE-ONLY AND NEVER READ. Every stored value of the app decrypts with its Password field
// key alone, and an engine and its renderer agree only while their secret stays the same, so the
// write refuses to replace a key that stands, and the manager holds no read grant on it. That is also
// what lets a re-run of an onboarding step ask again: an app that has its key answers "exists", and
// nothing about the key is learned.
//
// THE GOOGLE TRANSLATION SETTINGS are one entry per tenant, <stage>/tenants/<guid>/google-translation,
// which every app's ExternalSecret reads. They are not minted: the first entry holds every property
// empty, which the plugin reads as not set, and an operator's typed value replaces it later through
// its own write (tenant-google-translation.run.ts).
import type { Stage } from "../../../shared/enums.ts";
import type { TenantAppKeyKind, VaultSeeder, VaultSeedOutcome } from "#unit/server/adapters/vault/seeder-port.ts";
import { mintAes256Key } from "#unit/server/secret-mint.ts";
import type { Step, StepCtx } from "../../executor/types.ts";
import { errValidation } from "../../kernel/errors.ts";

/** The member name of the tenant web server, which every site of the tenant runs on: the revalidate
 *  secret and the form signing key stand under it, once per tenant with a website. */
export const TENANT_WEB_MEMBER = "web";

/** What a person reads about each kind of key: its name, and what an app lacks without it. */
const KEY_KIND_TEXT: Record<TenantAppKeyKind, { keys: string; key: string; lacking: string }> = {
  "password-field-key": { keys: "Password field keys", key: "Password field key", lacking: "an engine without its key cannot encrypt a Password field" },
  "revalidate-secret": { keys: "Revalidate secrets", key: "revalidate secret", lacking: "neither a website engine nor the tenant web server starts without it" },
  "form-signing-key": { keys: "Form signing keys", key: "form signing key", lacking: "the tenant web server does not start without it" },
  "service-key": { keys: "Service keys", key: "service key", lacking: "an engine without its key gets no mail token from its identity provider" },
};

export interface TenantAppKeysOutcome {
  /** The apps whose key this call wrote. */
  created: string[];
  /** The apps whose key already stood, and was left as it was. */
  existing: string[];
}

/** Writes the first entry of [kind] for each of [apps] of one tenant, create-only: a fresh key of 32
 *  random bytes as base64 under the property its kind names, as the app's charts read it. */
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

/** One line for a run's log, naming whether the tenant's Google translation settings were written. */
export function tenantGoogleTranslationLine(stage: Stage, guid: string, outcome: VaultSeedOutcome): string {
  return `Google translation settings at ${stage}/tenants/${guid}/google-translation: ${outcome.created ? "written with every property empty, so not set" : "already standing and left untouched"}`;
}

/** Creation seeds every app's Password field key and service key, and the tenant's empty Google
 *  translation settings, before the registration starts the engines that read them. */
export async function seedTenantEngineKeys(seeder: VaultSeeder, stage: Stage, guid: string, apps: readonly string[], ctx: Pick<StepCtx, "log">): Promise<{ appKeys: TenantAppKeysOutcome; serviceKeys: TenantAppKeysOutcome; googleTranslation: VaultSeedOutcome }> {
  const appKeys = await seedTenantAppKeys(seeder, "password-field-key", stage, guid, apps);
  ctx.log("meta", tenantAppKeysLine("password-field-key", stage, guid, appKeys));
  const serviceKeys = await seedTenantAppKeys(seeder, "service-key", stage, guid, apps);
  ctx.log("meta", tenantAppKeysLine("service-key", stage, guid, serviceKeys));
  const googleTranslation = await seeder.seedTenantGoogleTranslation({ stage, guid });
  ctx.log("meta", tenantGoogleTranslationLine(stage, guid, googleTranslation));
  return { appKeys, serviceKeys, googleTranslation };
}

/** Creation seeds the website keys of a tenant with a website before the registration starts the
 *  engines and the web server that read them. */
export async function seedTenantWebsiteKeys(seeder: VaultSeeder, stage: Stage, guid: string, apps: readonly { site?: string }[], ctx: Pick<StepCtx, "log">): Promise<(TenantAppKeysOutcome & { kind: TenantAppKeyKind })[]> {
  const holders = apps.some((a) => a.site) ? [TENANT_WEB_MEMBER] : [];
  const outcomes = [];
  for (const kind of ["revalidate-secret", "form-signing-key"] as const) {
    const keys = await seedTenantAppKeys(seeder, kind, stage, guid, holders);
    outcomes.push({ kind, ...keys });
    ctx.log("meta", tenantAppKeysLine(kind, stage, guid, keys));
  }
  return outcomes;
}

/** The step that writes [app]'s key of [kind] as an app joins a standing tenant (add-app); [app] is
 *  TENANT_WEB_MEMBER for the website keys. It stands before the step that appends the app to the
 *  registration, because the append is what makes the master's ArgoCD generate the app's engine, and
 *  that engine reads the key. */
export function seedTenantAppKeyStep(seeder: VaultSeeder | undefined, kind: TenantAppKeyKind, stage: Stage, guid: string, app: string): Step {
  const text = KEY_KIND_TEXT[kind];
  return {
    name: `seed-${kind}`,
    title: `Write the ${text.key} of ${app}`,
    run: async (ctx) => {
      if (!seeder) throw errValidation(`no Vault seeder is wired — the ${text.key} of ${app} cannot be written, and ${text.lacking}`);
      const appKeys = await seedTenantAppKeys(seeder, kind, stage, guid, [app]);
      ctx.checkpoint({ appKeys });
      ctx.log("meta", tenantAppKeysLine(kind, stage, guid, appKeys));
    },
  };
}
