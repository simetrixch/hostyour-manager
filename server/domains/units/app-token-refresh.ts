// The build Vault's repo-pat of every unit whose credential is the platform's GitHub App, rewritten
// with a token minted now. An installation token lives one hour and the release pipeline's clone
// reads it off secret/build/<unit>/repo-pat, so a value seeded once at the onboarding lets the unit
// build exactly once. The entry is therefore REWRITTEN — every 45 minutes on a timer
// (boot/refresh-app-tokens-schedule.ts, once at boot too) and before every release the Manager
// triggers for such a unit (onboard-seed-repo-pat.ts refreshRepoPatStep). A unit whose credential is
// a PAT is rewritten on the same ticks (hostyour-manager#230): its `pat` does not expire, but the
// `packages` beside it is the packages reader of its owner, recorded and replaced on the
// Owners page, and an entry written once at the onboarding never learns of that — which is
// how four PAT units stood on `cannot find secret data for key: "packages"` on the first installation.
//
// A REWRITE ALONE REACHES NO CLONE. The pipeline's clone task reads the Secret `build-git-https`
// in <unit>-build, and that Secret is what an ExternalSecret materialized out of Vault at ONE of two
// moments: its deploy, or the deletion of the Secret it targets (`refreshPolicy: OnChange`,
// `refreshInterval: "0"` — hostyour-cloud's delivery rule, stated in
// clusters/charts/external-secret/templates/externalsecret.yaml; nothing on the platform reads Vault
// on a timer). So every successful rewrite is followed by the deletion of the unit's three target
// Secrets, which is the one act that makes ESO fetch the new value.
//
// WHICH units: every build registration. The credential each unit's repository is reached with is
// the owner's, resolved from the URL at every tick (repo-identity.ts resolveRepoCredentialId, #226):
// the App's one row, or the owner's repository PAT row; what the id opens to is the store's business.
import type { Logger } from "../../kernel/logger.ts";
import type { CredentialStore, UseContext } from "../../security/store.ts";
import type { VaultSeeder } from "../../adapters/vault/seeder-port.ts";
import type { ClusterReader } from "../../adapters/kube/port.ts";
import type { Registrations } from "./registrations.ts";
import { unitBuildNamespace } from "./build-rbac.ts";
import { packagesReaderFor, resolveRepoCredentialId, type OwnerIdentityReader } from "./repo-identity.ts";
import type { GitHubApp } from "../../adapters/github-app/port.ts";
import { appReachesRepoURL } from "./repo-identity.ts";

/** The three Secrets of a unit's build namespace that carry its repo-pat, by the `target.name` of
 *  the ExternalSecret that materializes each — hostyour-cloud
 *  clusters/inventories/consumer-build/templates/externalsecret-git-https.yaml (the clone
 *  credential), externalsecret-bump.yaml (the bump's push credential) and externalsecret-npmrc.yaml
 *  (the package read). Deleting one is what makes its ExternalSecret read Vault again. */
export const BUILD_TARGET_SECRETS = ["build-git-https", "bump-git-https", "build-npmrc"] as const;

/** The entry the release pipeline's bump pushes the catalog's books branch with
 *  (hostyour-cloud consumer-build externalsecret-bump.yaml reads secret/build/catalog/repo-pat):
 *  the seeder addresses it as the "unit" named catalog, which is exactly its path. */
export const CATALOG_BUMP_UNIT = "catalog";

export interface AppTokenRefreshDeps {
  store: Pick<CredentialStore, "list" | "open">;
  /** The owner identities (owners.ts): the packages reader of a unit's owner is
   *  written beside the App token on every rewrite — the entry is replaced whole. */
  owners: OwnerIdentityReader;
  registrations: Pick<Registrations, "listBuildRegistrations">;
  seeder: Pick<VaultSeeder, "refreshBuildRepoPat">;
  /** The catalog as configured (config.catalog): its bump entry is the Manager's to write from the
   *  App on every tick (#197). Absent ⇒ no tenant family. */
  catalog?: { repoURL: string } | undefined;
  /** The platform's GitHub App — measured against the catalog and minting the bump token. */
  githubApp: Pick<GitHubApp, "reachesRepository" | "installationToken" | "installationOrg">;
  /** The build plane's cluster reader — the master's own, the cluster this Manager runs on. Absent
   *  on a Manager whose kube is not wired: the entries are still rewritten, and the deletion that
   *  would carry them into the Secrets is logged as skipped, per unit. */
  kube?: Pick<ClusterReader, "deleteSecret">;
  logger: Logger;
}

/** ONE unit's entry, rewritten with the value its credential opens to now — a token minted by the
 *  App for a `github-app` credential. The value is zeroed after the write and never logged. Throws
 *  where the open or the write fails. Writes Vault only: the deletion that lets the value reach the
 *  pipeline is `deleteBuildSecrets`, called by both callers after this succeeded. */
export async function refreshUnitRepoPat(deps: { store: Pick<CredentialStore, "open">; seeder: Pick<VaultSeeder, "refreshBuildRepoPat"> }, unit: string, credentialId: string, packagesCredentialId: string | null, use: UseContext): Promise<void> {
  const token = await deps.store.open(credentialId, use);
  const packages = packagesCredentialId ? await deps.store.open(packagesCredentialId, use).catch((e: unknown) => { token.fill(0); throw e; }) : Buffer.alloc(0);
  try {
    await deps.seeder.refreshBuildRepoPat({ consumerName: unit, pat: token.toString("utf8"), packages: packages.toString("utf8") });
  } finally {
    token.fill(0);
    packages.fill(0);
  }
}

/** Delete the unit's three target Secrets in <unit>-build, so each ExternalSecret materializes the
 *  entry again from Vault. An absent Secret is done (the port treats a 404 as success); a refused
 *  delete throws with the namespace and the name. */
export async function deleteBuildSecrets(kube: Pick<ClusterReader, "deleteSecret">, unit: string): Promise<void> {
  const namespace = unitBuildNamespace(unit);
  for (const name of BUILD_TARGET_SECRETS) await kube.deleteSecret(namespace, name);
}

/** When ESO last wrote each of the three, off the ExternalSecret rows of <unit>-build: the
 *  `refreshTime` of the row targeting each Secret, keyed by that Secret's name, the empty text where
 *  no row targets it or it never materialized. Read before a deletion and again after it, the two
 *  readings say whether the Secret stands again: its time moved. */
export async function readBuildSecretRefreshTimes(kube: Pick<ClusterReader, "listExternalSecrets">, unit: string): Promise<Record<string, string>> {
  const rows = await kube.listExternalSecrets(unitBuildNamespace(unit));
  return Object.fromEntries(BUILD_TARGET_SECRETS.map((name) => [name, rows.find((r) => r.targetSecret === name)?.refreshTime ?? ""]));
}

/** Every unit whose build registration names a credential, refreshed one by one: a
 *  unit whose open or write fails is logged with its name and the rest go on, and a registration
 *  tree that cannot be read is logged as one failure. After each rewrite the unit's three build
 *  Secrets are deleted, which is what makes ESO's `OnChange` ExternalSecrets fetch the new value —
 *  a unit whose deletion fails is logged with its name and counted failed, because its clone still
 *  reads the value ESO wrote before. The timer does not wait for the Secrets to return; the release
 *  step (refreshRepoPatStep) does. NEVER rejects — boot starts it unawaited and the timer fires it
 *  unattended. Answers what it did, so a caller can read it back. */
export async function refreshAppTokens(deps: AppTokenRefreshDeps): Promise<{ refreshed: string[]; failed: string[] }> {
  const refreshed: string[] = [];
  const failed: string[] = [];
  const units: { unit: string; repoURL: string }[] = [];
  const buildUnits: string[] = [];
  try {
    for (const { unit, entry } of await deps.registrations.listBuildRegistrations()) {
      buildUnits.push(unit);
      units.push({ unit, repoURL: entry.repoURL });
    }
  } catch (err) {
    deps.logger.error({ err: err instanceof Error ? err.message : String(err) }, "the repo-pat refresh could not read which units are registered — no repo-pat was rewritten this time");
    return { refreshed, failed };
  }
  const undeleted: string[] = [];
  for (const { unit, repoURL } of units) {
    // THE UNIT'S OWN FAILURE (#240): a repository the App no longer reaches — deleted by hand, moved,
    // its owner's PAT forgotten — is that unit's, logged by name and counted failed; the other units
    // and the catalog's entry go on, because a refresh that stops at one leaves every other clone
    // reading a token that expires within the hour.
    let credentialId: string;
    try {
      credentialId = await resolveRepoCredentialId({ repoURL, githubApp: deps.githubApp, owners: deps.owners, store: deps.store });
    } catch (err) {
      failed.push(unit);
      deps.logger.error({ unit, repoURL, err: err instanceof Error ? err.message : String(err) }, "this unit's repository has no identity, so its build repo-pat was not rewritten — offboard the unit, install the App on the repository, or record its owner's PAT");
      continue;
    }
    try {
      await refreshUnitRepoPat(deps, unit, credentialId, packagesReaderFor(deps.owners, repoURL), { purpose: "app-token-refresh" });
    } catch (err) {
      failed.push(unit);
      deps.logger.error({ unit, credentialId, err: err instanceof Error ? err.message : String(err) }, "the App token of this unit could not be rewritten into its build repo-pat — its next release clones with the value that stands, which dies an hour after it was minted");
      continue;
    }
    if (!deps.kube) {
      undeleted.push(unit);
      refreshed.push(unit);
      continue;
    }
    try {
      await deleteBuildSecrets(deps.kube, unit);
      refreshed.push(unit);
    } catch (err) {
      failed.push(unit);
      deps.logger.error({ unit, namespace: unitBuildNamespace(unit), err: err instanceof Error ? err.message : String(err) }, "the build repo-pat of this unit was rewritten but its build Secrets could not be deleted — ESO keeps the Secrets it wrote before, so the next clone reads the old token");
    }
  }
  if (undeleted.length > 0) deps.logger.warn({ units: undeleted }, "no kube is wired on this Manager, so the build Secrets of these units were not deleted after the rewrite — ESO keeps the Secrets it wrote before, and the next clone reads the old token");
  await refreshCatalogBumpToken(deps, buildUnits, refreshed, failed);
  if (units.length > 0 || refreshed.includes(CATALOG_BUMP_UNIT)) deps.logger.info({ refreshed, failed }, "build repo-pat entries rewritten (App tokens minted now, PATs with their owner's packages reader) and their build Secrets deleted");
  return { refreshed, failed };
}

/** The catalog's bump entry, written from the App — the catalog's one identity (hostyour-cloud#237),
 *  its installation's reach measured now (repo-identity.ts, the rule of #194). Then `bump-git-https`
 *  deleted in EVERY build namespace, because every unit's release pushes the catalog's books branch
 *  with this one entry. */
async function refreshCatalogBumpToken(deps: AppTokenRefreshDeps, buildUnits: readonly string[], refreshed: string[], failed: string[]): Promise<void> {
  const { catalog, githubApp } = deps;
  if (!catalog) return;
  try {
    if (!(await appReachesRepoURL(githubApp, catalog.repoURL))) {
      deps.logger.error({ repoURL: catalog.repoURL }, "the GitHub App's installation does not reach the catalog — the release pipeline's bump has no credential (readiness row catalog.identity)");
      failed.push(CATALOG_BUMP_UNIT);
      return;
    }
    const token = Buffer.from(await githubApp.installationToken(), "utf8");
    try {
      // The bump entry is read by the release pipeline's push alone — no build installs packages with it.
      await deps.seeder.refreshBuildRepoPat({ consumerName: CATALOG_BUMP_UNIT, pat: token.toString("utf8"), packages: "" });
    } finally {
      token.fill(0);
    }
  } catch (err) {
    failed.push(CATALOG_BUMP_UNIT);
    deps.logger.error({ repoURL: catalog.repoURL, err: err instanceof Error ? err.message : String(err) }, "the App's token could not be written into the catalog's bump entry — the next release bumps the catalog with the value that stands, which dies an hour after it was minted");
    return;
  }
  if (!deps.kube) {
    refreshed.push(CATALOG_BUMP_UNIT);
    if (buildUnits.length > 0) deps.logger.warn({ units: buildUnits }, "no kube is wired on this Manager, so bump-git-https was not deleted in the build namespaces after the catalog rewrite — the next bump reads the old token");
    return;
  }
  const kept: string[] = [];
  for (const unit of buildUnits) {
    try {
      await deps.kube.deleteSecret(unitBuildNamespace(unit), "bump-git-https");
    } catch (err) {
      kept.push(unit);
      deps.logger.error({ unit, namespace: unitBuildNamespace(unit), err: err instanceof Error ? err.message : String(err) }, "the catalog's bump entry was rewritten but this unit's bump-git-https could not be deleted — its next bump reads the old token");
    }
  }
  (kept.length > 0 ? failed : refreshed).push(CATALOG_BUMP_UNIT);
}
