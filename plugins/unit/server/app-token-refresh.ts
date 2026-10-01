// The build Vault's repo-pat of every unit whose credential is the platform's GitHub App, rewritten
// with a token minted now. An installation token lives one hour and the release pipeline's clone
// reads it off secret/build/<unit>/repo-pat, so a value seeded once at the onboarding lets the unit
// build exactly once. The entry is therefore REWRITTEN — every 45 minutes on a timer
// (boot/refresh-app-tokens-schedule.ts, once at boot too) and before every release the Manager
// triggers for such a unit (seed-repo-pat.ts refreshRepoPatStep). A unit whose credential is
// a PAT is rewritten on the same ticks (hostyour-manager#230): its `pat` does not expire, but the
// `packages` beside it is the packages reader of its owner, recorded and replaced on the
// Owners page, and an entry written once at the onboarding never learns of that — which is
// how four PAT units stood on `cannot find secret data for key: "packages"` on the first installation.
//
// A REWRITE ALONE REACHES NO CLONE. The pipeline's clone task reads the Secret `build-git-https`
// in <unit>-build, and that Secret is what an ExternalSecret wrote out of Vault when it was deployed
// or when it last CHANGED (`refreshPolicy: OnChange`, `refreshInterval: "0"` — hostyour-cloud's
// delivery rule, stated in clusters/charts/external-secret/templates/externalsecret.yaml; nothing on
// the platform reads Vault on a timer). So every successful rewrite is followed by a refresh request
// on the unit's three build ExternalSecrets: an annotation that changes their metadata, which ESO
// answers by writing the targets again. The Secrets are never deleted for it, so an ESO that does not
// answer leaves the value it wrote before, and no clone meets a missing Secret.
//
// WHICH units: every build registration. The credential each unit's repository is reached with is
// the owner's, resolved from the URL at every tick (repo-identity.ts resolveRepoCredentialId, #226):
// the App's one row, or the owner's repository PAT row; what the id opens to is the store's business.
import type { Logger } from "#core/server/kernel/logger.ts";
import type { CredentialStore, UseContext } from "#core/server/security/store.ts";
import type { VaultSeeder } from "./adapters/vault/seeder-port.ts";
import type { ClusterReader, ExternalSecretRow } from "#core/server/adapters/kube/port.ts";
import { errValidation } from "#core/server/kernel/errors.ts";
import type { Registrations } from "./registrations.ts";
import { unitBuildNamespace } from "./build-rbac.ts";
import { packagesReaderFor, resolveRepoCredentialId, type OwnerIdentityReader } from "./repo-identity.ts";
import type { GitHubApp } from "#core/server/adapters/github-app/port.ts";
import { appReachesRepoURL } from "./repo-identity.ts";

/** The three Secrets of a unit's build namespace that carry its repo-pat, by the `target.name` of
 *  the ExternalSecret that materializes each — hostyour-cloud
 *  clusters/inventories/consumer-build/templates/externalsecret-git-https.yaml (the clone
 *  credential), externalsecret-bump.yaml (the bump's push credential) and externalsecret-npmrc.yaml
 *  (the package read). A refresh request on that ExternalSecret makes it read Vault again. */
export const BUILD_TARGET_SECRETS = ["build-git-https", "bump-git-https", "build-npmrc"] as const;

/** The entry the release pipeline's bump pushes the deploy repository's books branch with
 *  (hostyour-cloud consumer-build externalsecret-bump.yaml reads secret/build/deploy/repo-pat): the
 *  seeder addresses it as the "unit" named deploy, which is exactly its path. */
export const DEPLOY_BUMP_UNIT = "deploy";

export interface AppTokenRefreshDeps {
  store: Pick<CredentialStore, "list" | "open">;
  /** The owner identities (owners.ts): the packages reader of a unit's owner is
   *  written beside the App token on every rewrite — the entry is replaced whole. */
  owners: OwnerIdentityReader;
  registrations: Pick<Registrations, "listBuildRegistrations">;
  seeder: Pick<VaultSeeder, "refreshBuildRepoPat">;
  /** The deploy repository as configured (config.deployRepo): its bump entry is the Manager's to
   *  write from the App on every tick (#197). Absent ⇒ no tenant family. */
  deployRepo?: { repoURL: string } | undefined;
  /** The platform's GitHub App — measured against the deploy repository and minting the bump token. */
  githubApp: Pick<GitHubApp, "reachesRepository" | "installationToken" | "installationOrg">;
  /** The build plane's cluster reader — the master's own, the cluster this Manager runs on. Absent
   *  on a Manager whose kube is not wired: the entries are still rewritten, and the refresh request
   *  that would carry them into the Secrets is logged as skipped, per unit. */
  kube?: Pick<ClusterReader, "listExternalSecrets" | "refreshExternalSecret">;
  logger: Logger;
}

/** ONE unit's entry, rewritten with the value its credential opens to now — a token minted by the
 *  App for a `github-app` credential. The value is zeroed after the write and never logged. Throws
 *  where the open or the write fails. Writes Vault only: the refresh request that lets the value reach
 *  the pipeline is `refreshBuildSecrets`, called by both callers after this succeeded. */
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

/** Whether `row` is the ExternalSecret that writes the Secret `target`: its `target.name`, or its own
 *  name where it states none, which is the name ESO then gives the Secret. */
function writesSecret(row: ExternalSecretRow, target: string): boolean {
  return (row.targetSecret || row.name) === target;
}

/** Ask ESO to write `targets` in <unit>-build again, the unit's three build Secrets unless named:
 *  one refresh request on the ExternalSecret that writes each, read off the namespace's rows, so the
 *  request reaches the object ESO watches whatever it is named. Where no ExternalSecret writes a
 *  target, it throws naming the namespace and every such Secret before it asks for any; a refused
 *  request throws from the port. */
export async function refreshBuildSecrets(kube: Pick<ClusterReader, "listExternalSecrets" | "refreshExternalSecret">, unit: string, targets: readonly string[] = BUILD_TARGET_SECRETS): Promise<void> {
  const namespace = unitBuildNamespace(unit);
  const rows = await kube.listExternalSecrets(namespace);
  const writers = targets.map((target) => ({ target, row: rows.find((r) => writesSecret(r, target)) }));
  const unwritten = writers.filter((w) => w.row === undefined).map((w) => w.target);
  if (unwritten.length > 0) throw errValidation(`no ExternalSecret in ${namespace} writes ${unwritten.join(", ")}, so ESO cannot be asked to write ${unwritten.length === 1 ? "it" : "them"} again`);
  for (const { row } of writers) await kube.refreshExternalSecret(namespace, row!.name);
}

/** When ESO last wrote each of the three, off the ExternalSecret rows of <unit>-build: the
 *  `refreshTime` of the row that writes each Secret, keyed by that Secret's name, the empty text where
 *  no row writes it or it never materialized. Read before a refresh request and again after it, the
 *  two readings say whether ESO wrote the Secret again: its time moved. */
export async function readBuildSecretRefreshTimes(kube: Pick<ClusterReader, "listExternalSecrets">, unit: string): Promise<Record<string, string>> {
  const rows = await kube.listExternalSecrets(unitBuildNamespace(unit));
  return Object.fromEntries(BUILD_TARGET_SECRETS.map((name) => [name, rows.find((r) => writesSecret(r, name))?.refreshTime ?? ""]));
}

/** Every unit whose build registration names a credential, refreshed one by one: a
 *  unit whose open or write fails is logged with its name and the rest go on, and a registration
 *  tree that cannot be read is logged as one failure. After each rewrite ESO is asked to write the
 *  unit's three build Secrets again, which is what makes its `OnChange` ExternalSecrets fetch the new
 *  value — a unit whose request fails is logged with its name and counted failed, because its clone
 *  still reads the value ESO wrote before. The timer does not wait for ESO to write; the release
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
  const unrequested: string[] = [];
  for (const { unit, repoURL } of units) {
    // THE UNIT'S OWN FAILURE (#240): a repository the App no longer reaches — deleted by hand, moved,
    // its owner's PAT forgotten — is that unit's, logged by name and counted failed; the other units
    // and the deploy repository's entry go on, because a refresh that stops at one leaves every other clone
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
      unrequested.push(unit);
      refreshed.push(unit);
      continue;
    }
    try {
      await refreshBuildSecrets(deps.kube, unit);
      refreshed.push(unit);
    } catch (err) {
      failed.push(unit);
      deps.logger.error({ unit, namespace: unitBuildNamespace(unit), err: err instanceof Error ? err.message : String(err) }, "the build repo-pat of this unit was rewritten but ESO could not be asked to write its build Secrets again — they keep the value ESO wrote before, so the next clone reads the old token");
    }
  }
  if (unrequested.length > 0) deps.logger.warn({ units: unrequested }, "no kube is wired on this Manager, so ESO was not asked to write the build Secrets of these units again after the rewrite — they keep the value ESO wrote before, and the next clone reads the old token");
  await refreshDeployBumpToken(deps, buildUnits, refreshed, failed);
  if (units.length > 0 || refreshed.includes(DEPLOY_BUMP_UNIT)) deps.logger.info({ refreshed, failed }, "build repo-pat entries rewritten (App tokens minted now, PATs with their owner's packages reader) and ESO asked to write their build Secrets again");
  return { refreshed, failed };
}

/** The deploy repository's bump entry, written from the App — the deploy repository's one identity
 *  (hostyour-cloud#237), its installation's reach measured now (repo-identity.ts, the rule of #194).
 *  Then ESO asked to write `bump-git-https` again in EVERY build namespace, because every unit's
 *  release pushes the deploy repository's books branch with this one entry. */
async function refreshDeployBumpToken(deps: AppTokenRefreshDeps, buildUnits: readonly string[], refreshed: string[], failed: string[]): Promise<void> {
  const { deployRepo, githubApp } = deps;
  if (!deployRepo) return;
  try {
    if (!(await appReachesRepoURL(githubApp, deployRepo.repoURL))) {
      deps.logger.error({ repoURL: deployRepo.repoURL }, "the GitHub App's installation does not reach the deploy repository — the release pipeline's bump has no credential (readiness row deploy.identity)");
      failed.push(DEPLOY_BUMP_UNIT);
      return;
    }
    const token = Buffer.from(await githubApp.installationToken(), "utf8");
    try {
      // The bump entry is read by the release pipeline's push alone — no build installs packages with it.
      await deps.seeder.refreshBuildRepoPat({ consumerName: DEPLOY_BUMP_UNIT, pat: token.toString("utf8"), packages: "" });
    } finally {
      token.fill(0);
    }
  } catch (err) {
    failed.push(DEPLOY_BUMP_UNIT);
    deps.logger.error({ repoURL: deployRepo.repoURL, err: err instanceof Error ? err.message : String(err) }, "the App's token could not be written into the deploy repository's bump entry — the next release bumps the deploy repository with the value that stands, which dies an hour after it was minted");
    return;
  }
  if (!deps.kube) {
    refreshed.push(DEPLOY_BUMP_UNIT);
    if (buildUnits.length > 0) deps.logger.warn({ units: buildUnits }, "no kube is wired on this Manager, so ESO was not asked to write bump-git-https again in the build namespaces after the deploy repository rewrite — the next bump reads the old token");
    return;
  }
  const kept: string[] = [];
  for (const unit of buildUnits) {
    try {
      await refreshBuildSecrets(deps.kube, unit, ["bump-git-https"]);
    } catch (err) {
      kept.push(unit);
      deps.logger.error({ unit, namespace: unitBuildNamespace(unit), err: err instanceof Error ? err.message : String(err) }, "the deploy repository's bump entry was rewritten but ESO could not be asked to write this unit's bump-git-https again — its next bump reads the old token");
    }
  }
  (kept.length > 0 ? failed : refreshed).push(DEPLOY_BUMP_UNIT);
}
