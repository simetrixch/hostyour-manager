// The repo-pat refresh (app-token-refresh.ts): every unit whose build registration names a
// credential has its build repo-pat rewritten with the value the store opens to now — a token minted
// for the App, the PAT itself for a pat unit — beside its owner's packages reader and the `push` token
// that writes the unit's own repository (none for a CI-only unit), and ESO asked to write its three
// build Secrets again behind the rewrite; one unit's failure is logged and the rest go on; nothing rejects.
import { describe, it, expect, vi } from "vitest";
import type { Logger } from "#core/server/kernel/logger.ts";
import type { CredentialStore } from "#core/server/security/store.ts";
import type { BuildRepoPatSeedInput } from "./adapters/vault/seeder-port.ts";
import { FakePlatformRepo } from "#core/server/adapters/git/testing/fake.ts";
import { FakeClusterReader } from "#core/server/adapters/kube/testing/fake.ts";
import { Registrations } from "./registrations.ts";
import { FakeGitHubApp } from "#core/server/adapters/github-app/testing/fake.ts";
import { GitHubAppError } from "#core/server/adapters/github-app/port.ts";
import { BUILD_TARGET_SECRETS, DEPLOY_BUMP_UNIT, readBuildSecretRefreshTimes, refreshAppTokens, refreshBuildSecrets, refreshUnitRepoPat } from "./app-token-refresh.ts";
import type { OwnerIdentityReader } from "./repo-identity.ts";

/** The three deletes one unit's refresh issues, in the order the names are declared. */
const refreshesOf = (unit: string) => BUILD_TARGET_SECRETS.map((name) => `${unit}-build/${name}`);

/** The build plane with ESO's rows standing: in each unit's build namespace, the three ExternalSecrets
 *  as consumer-build renders them, each named after the Secret it writes. */
function buildPlane(options: { throwOnRefreshExternalSecret?: Error } = {}, units: readonly string[] = ["acme-apps", "shop", "beta-apps"]): FakeClusterReader {
  const rows = BUILD_TARGET_SECRETS.map((name) => ({ name, ready: true, reason: "SecretSynced", targetSecret: name, refreshTime: "2026-01-01T00:00:00Z", remoteKeys: [] }));
  return new FakeClusterReader({ externalSecretsByNamespace: Object.fromEntries(units.map((u) => [`${u}-build`, rows])), ...options });
}

/** A store of two credentials, both the OWNER acme's (#226): the App's one row (kind github-app),
 *  which opens to whatever `minted` says at the moment of the open, and the owner's repository PAT. */
function fakeStore(minted: { value: string }): { store: Pick<CredentialStore, "list" | "open">; opened: string[] } {
  const opened: string[] = [];
  const store: Pick<CredentialStore, "list" | "open"> = {
    list: async (filter) => {
      const all = [
        { id: "cred_app", kind: "github-app" as const, label: "GitHub App (acme)", fingerprint: "sha256:app", subject: { kind: "owner" as const, id: "acme" }, purpose: "repository-identity" as const, recordedAt: "2026-01-01T00:00:00.000Z" },
        { id: "cred_pat", kind: "pat" as const, label: "repository PAT (acme)", fingerprint: "sha256:pat", subject: { kind: "owner" as const, id: "acme" }, purpose: "repository-pat" as const, recordedAt: "2026-01-01T00:00:00.000Z" },
      ];
      return all.filter((c) => !filter?.kind || c.kind === filter.kind);
    },
    open: async (id) => {
      opened.push(id);
      if (id === "cred_app") return Buffer.from(minted.value, "utf8");
      if (id === "cred_pat") return Buffer.from("github_pat_shop", "utf8");
      if (id === "cred_pkg") return Buffer.from("ghp_packages_acme", "utf8");
      throw new Error(`credential ${id} not found`);
    },
  };
  return { store, opened };
}

function fakeSeeder(failFor: string[] = []): { seeder: { refreshBuildRepoPat: (i: BuildRepoPatSeedInput) => Promise<void> }; written: BuildRepoPatSeedInput[] } {
  const written: BuildRepoPatSeedInput[] = [];
  return {
    written,
    seeder: {
      refreshBuildRepoPat: async (i) => {
        if (failFor.includes(i.consumerName)) throw new Error(`vault build repo-pat put failed for secret/build/${i.consumerName}/repo-pat (403)`);
        written.push(i);
      },
    },
  };
}

/** The owner identities: acme records its packages reader and its repository PAT; any other owner none. */
const owners: OwnerIdentityReader = (org) => (org === "acme" ? { packagesCredentialId: "cred_pkg", repoCredentialId: "cred_pat" } : null);

/** The App installed with acme, reaching every repository of it but shop — which is therefore
 *  reached with the owner's repository PAT. */
function app(): FakeGitHubApp {
  const a = new FakeGitHubApp();
  a.org = "acme";
  a.reachable.set("acme/shop", false);
  return a;
}

function fakeLogger(): { logger: Logger; errors: string[]; warns: string[]; infos: string[] } {
  const errors: string[] = [];
  const warns: string[] = [];
  const infos: string[] = [];
  const logger = {
    error: (fields: unknown, msg: string) => { errors.push(`${msg} ${JSON.stringify(fields)}`); },
    warn: (fields: unknown, msg: string) => { warns.push(`${msg} ${JSON.stringify(fields)}`); },
    info: (fields: unknown, msg: string) => { infos.push(`${msg} ${JSON.stringify(fields)}`); },
    debug: () => undefined,
  } as unknown as Logger;
  return { logger, errors, warns, infos };
}

/** Three build registrations of the owner acme: two the App reaches, one (shop) it does not. */
async function registrations(): Promise<Registrations> {
  const reg = new Registrations(new FakePlatformRepo());
  const unit = (name: string) => ({ name, repoURL: `https://github.com/acme/${name}.git`, owner: "acme", onboardedAt: "2026-01-01T00:00:00Z", suspended: false, quiesced: false });
  await reg.commitRegistration({ unit: unit("acme-apps"), builds: ["acme-apps"], runId: "run_1" });
  await reg.commitRegistration({ unit: unit("shop"), builds: ["shop-api"], runId: "run_2" });
  await reg.commitRegistration({ unit: unit("beta-apps"), builds: ["beta-apps"], runId: "run_3" });
  return reg;
}

// THE DEPLOY REPOSITORY'S BUMP ENTRY (#197): the App's token is written to build/deploy/repo-pat on
// every tick and ESO is asked to write bump-git-https again in EVERY build namespace, because every unit's release
// pushes the deploy repository's books branch with that one entry — the App is the deploy
// repository's one identity (hostyour-cloud#237).
describe("refreshAppTokens — the deploy repository bump credential from the App", () => {
  const deployRepoOf = (owner: string) => ({ repoURL: `https://github.com/${owner}/deploy.git` });

  it("writes the App's token to the deploy repository entry and asks ESO to write bump-git-https again in every build namespace, the pat unit's included, deleting nothing", async () => {
    const { store } = fakeStore({ value: "ghs_unit" });
    const { seeder, written } = fakeSeeder();
    const { logger, errors } = fakeLogger();
    const kube = buildPlane();
    const githubApp = app();
    githubApp.token = "ghs_deploy_now";
    const r = await refreshAppTokens({ store, owners, registrations: await registrations(), seeder, kube, logger, deployRepo: deployRepoOf("acme"), githubApp });
    expect(r.refreshed).toEqual(["acme-apps", "shop", "beta-apps", DEPLOY_BUMP_UNIT]);
    expect(written.at(-1)).toEqual({ consumerName: DEPLOY_BUMP_UNIT, pat: "ghs_deploy_now", packages: "" }); // the bump entry installs nothing
    // Each unit's own rewrite asks for its three Secrets; the deploy repository's rewrite behind them
    // asks for bump-git-https alone, the one Secret that carries its entry.
    expect(kube.refreshedExternalSecrets).toHaveLength(3 * 3 + 3);
    expect(kube.refreshedExternalSecrets.slice(-3)).toEqual(["acme-apps-build/bump-git-https", "shop-build/bump-git-https", "beta-apps-build/bump-git-https"]);
    expect(kube.secretWrites).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("refuses by name where the App does not reach the deploy repository, and writes no bump entry", async () => {
    const { store } = fakeStore({ value: "ghs_unit" });
    const { seeder, written } = fakeSeeder();
    const { logger, errors } = fakeLogger();
    const githubApp = app();
    const unreached = await refreshAppTokens({ store, owners, registrations: await registrations(), seeder, kube: buildPlane(), logger, deployRepo: deployRepoOf("other-org"), githubApp });
    expect(unreached.failed).toEqual([DEPLOY_BUMP_UNIT]);
    expect(written.some((w) => w.consumerName === DEPLOY_BUMP_UNIT)).toBe(false);
    expect(errors.at(-1)).toContain("does not reach the deploy repository");
  });
});

describe("refreshAppTokens", () => {
  it("rewrites the repo-pat of every unit whose build registration names a credential with the value opened NOW — the pat unit's PAT included — and asks ESO to write its three build Secrets again behind the rewrite, deleting none", async () => {
    const minted = { value: "ghs_minted_at_tick_1" };
    const { store, opened } = fakeStore(minted);
    const { seeder, written } = fakeSeeder();
    const { logger, errors, warns, infos } = fakeLogger();
    const kube = buildPlane();
    const reg = await registrations();
    const githubApp = app();
    expect(await refreshAppTokens({ store, owners, registrations: reg, seeder, kube, logger, githubApp })).toEqual({ refreshed: ["acme-apps", "shop", "beta-apps"], failed: [] });
    expect(written).toEqual([
      // `pat` is what the store opens to, unchanged; `push` is the token the App minted for the unit's own repository.
      { consumerName: "acme-apps", pat: "ghs_minted_at_tick_1", packages: "ghp_packages_acme", push: "ghs_fake_installation_token_scoped_1" },
      { consumerName: "shop", pat: "github_pat_shop", packages: "ghp_packages_acme", push: "github_pat_shop" }, // the PAT itself in all three, and the reader of its owner
      { consumerName: "beta-apps", pat: "ghs_minted_at_tick_1", packages: "ghp_packages_acme", push: "ghs_fake_installation_token_scoped_2" },
    ]);
    // One mint per App unit, none for the PAT unit: the repository NAME alone, and the write right alone.
    expect(githubApp.scopedMints).toEqual([
      { repositories: ["acme-apps"], permissions: { contents: "write" } },
      { repositories: ["beta-apps"], permissions: { contents: "write" } },
    ]);
    expect(opened).toEqual(["cred_app", "cred_pkg", "cred_pat", "cred_pkg", "cred_app", "cred_pkg"]); // the unit's credential and the owner's packages reader, per unit
    // The ExternalSecret that writes each of the three, in ITS build namespace. No Secret is deleted
    // for it, so an ESO that does not answer leaves the Secrets it wrote before standing.
    expect(kube.refreshedExternalSecrets).toEqual([...refreshesOf("acme-apps"), ...refreshesOf("shop"), ...refreshesOf("beta-apps")]);
    expect(kube.secretWrites).toEqual([]);
    expect(errors).toEqual([]);
    expect(warns).toEqual([]);
    expect(infos.some((l) => l.includes("build repo-pat entries rewritten"))).toBe(true);
    // The next tick writes the token of that hour — the value is never remembered between ticks —
    // and asks ESO again, because ESO reads Vault at no other moment.
    minted.value = "ghs_minted_at_tick_2";
    await refreshAppTokens({ store, owners, registrations: reg, seeder, kube, logger, githubApp: app() });
    expect(written.at(-1)).toEqual({ consumerName: "beta-apps", pat: "ghs_minted_at_tick_2", packages: "ghp_packages_acme", push: "ghs_fake_installation_token_scoped_2" });
    expect(kube.refreshedExternalSecrets).toHaveLength(18);
  });

  // ONE UNREACHABLE UNIT IS ITS OWN FAILURE (#240): the tick goes on to the others and the deploy
  // repository.
  it("counts a unit whose repository the App does not reach and whose owner records no PAT as failed by name, and rewrites the others and the deploy repository in the same tick", async () => {
    const { store, opened } = fakeStore({ value: "ghs_unit" });
    const { seeder, written } = fakeSeeder();
    const { logger, errors } = fakeLogger();
    const reg = await registrations();
    await reg.commitRegistration({ unit: { name: "gone", repoURL: "https://github.com/nobody/gone.git", owner: "nobody", onboardedAt: "2026-01-01T00:00:00Z", suspended: false, quiesced: false }, builds: ["gone"], runId: "run_4" });
    const githubApp = app();
    // The unreached unit's build namespace stands as an onboarding left it, its bump ExternalSecret included.
    const kube = buildPlane({}, ["acme-apps", "shop", "beta-apps", "gone"]);
    const r = await refreshAppTokens({ store, owners, registrations: reg, seeder, kube, logger, deployRepo: { repoURL: "https://github.com/acme/deploy.git" }, githubApp });
    expect(r.failed).toEqual(["gone"]);
    expect(r.refreshed).toEqual(["acme-apps", "shop", "beta-apps", DEPLOY_BUMP_UNIT]);
    expect(written.map((w) => w.consumerName)).toEqual(["acme-apps", "shop", "beta-apps", DEPLOY_BUMP_UNIT]);
    expect(opened).not.toContain("cred_gone");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('"unit":"gone"');
    expect(errors[0]).toContain("has no identity");
    expect(errors[0]).toContain("owner nobody records no repository PAT");
  });

  // A REFUSED SCOPED MINT IS THAT UNIT'S FAILURE: GitHub refuses it where the installation does not
  // reach the repository or the App lacks the write right. The unit's entry is not written at all (a
  // `pat` without its `push` beside it would be a half-refreshed entry), and the others go on.
  it("counts a unit whose scoped mint GitHub refuses as failed by name, writes nothing for it and asks no refresh of its Secrets, and refreshes the others", async () => {
    const { store } = fakeStore({ value: "ghs_x" });
    const { seeder, written } = fakeSeeder();
    const { logger, errors } = fakeLogger();
    const kube = buildPlane();
    const githubApp = app();
    const mint = githubApp.scopedInstallationToken.bind(githubApp);
    githubApp.scopedInstallationToken = async (input) => {
      if (input.repositories[0] === "acme-apps") throw new GitHubAppError("GitHub POST /app/installations/42/access_tokens → 422: The permissions requested are not granted to this installation.", 422);
      return mint(input);
    };
    expect(await refreshAppTokens({ store, owners, registrations: await registrations(), seeder, kube, logger, githubApp })).toEqual({ refreshed: ["shop", "beta-apps"], failed: ["acme-apps"] });
    expect(written.map((w) => w.consumerName)).toEqual(["shop", "beta-apps"]);
    expect(kube.refreshedExternalSecrets).toEqual([...refreshesOf("shop"), ...refreshesOf("beta-apps")]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('"unit":"acme-apps"');
    expect(errors[0]).toContain("permissions requested are not granted");
    expect(errors[0]).not.toContain("ghs_x");
  });

  it("logs the unit whose write fails, with its name, asks no refresh of its Secrets, and refreshes the others", async () => {
    const { store } = fakeStore({ value: "ghs_x" });
    const { seeder, written } = fakeSeeder(["acme-apps"]);
    const { logger, errors } = fakeLogger();
    const kube = buildPlane();
    expect(await refreshAppTokens({ store, owners, registrations: await registrations(), seeder, kube, logger, githubApp: app() })).toEqual({ refreshed: ["shop", "beta-apps"], failed: ["acme-apps"] });
    expect(written.map((w) => w.consumerName)).toEqual(["shop", "beta-apps"]);
    // A refresh behind a write that did not happen would make ESO write the DEAD value again —
    // nothing is gained, so nothing is asked.
    expect(kube.refreshedExternalSecrets).toEqual([...refreshesOf("shop"), ...refreshesOf("beta-apps")]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('"unit":"acme-apps"');
    expect(errors[0]).toContain("repo-pat put failed");
    expect(errors[0]).not.toContain("ghs_x");
  });

  it("logs the unit whose refresh request fails, with its name and its build namespace, counts it failed, and the tick goes on to the next unit without rejecting", async () => {
    const { store } = fakeStore({ value: "ghs_x" });
    const { seeder, written } = fakeSeeder();
    const { logger, errors } = fakeLogger();
    const kube = buildPlane({ throwOnRefreshExternalSecret: new Error("annotate ExternalSecret acme-apps-build/build-git-https for a refresh: externalsecrets.external-secrets.io is forbidden (403)") });
    expect(await refreshAppTokens({ store, owners, registrations: await registrations(), seeder, kube, logger, githubApp: app() })).toEqual({ refreshed: [], failed: ["acme-apps", "shop", "beta-apps"] });
    // Every Vault write happened: the failure is behind the write, and the next unit was reached.
    expect(written.map((w) => w.consumerName)).toEqual(["acme-apps", "shop", "beta-apps"]);
    expect(errors).toHaveLength(3);
    expect(errors[0]).toContain('"unit":"acme-apps"');
    expect(errors[0]).toContain('"namespace":"acme-apps-build"');
    expect(errors[0]).toContain("could not be asked to write its build Secrets again");
    expect(errors[1]).toContain('"unit":"shop"');
    expect(errors[2]).toContain('"unit":"beta-apps"');
    for (const l of errors) expect(l).not.toContain("ghs_x");
  });

  it("without a wired kube it rewrites Vault, counts the units refreshed, and logs the skipped refresh request naming them", async () => {
    const { store } = fakeStore({ value: "ghs_x" });
    const { seeder, written } = fakeSeeder();
    const { logger, errors, warns } = fakeLogger();
    expect(await refreshAppTokens({ store, owners, registrations: await registrations(), seeder, logger, githubApp: app() })).toEqual({ refreshed: ["acme-apps", "shop", "beta-apps"], failed: [] });
    expect(written.map((w) => w.consumerName)).toEqual(["acme-apps", "shop", "beta-apps"]);
    expect(errors).toEqual([]);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("no kube is wired");
    expect(warns[0]).toContain('"units":["acme-apps","shop","beta-apps"]');
  });

  it("logs, writes nothing and does not reject when the registration tree cannot be read", async () => {
    const { store } = fakeStore({ value: "ghs_x" });
    const { seeder, written } = fakeSeeder();
    const { logger, errors } = fakeLogger();
    const kube = buildPlane();
    const broken = { listBuildRegistrations: async () => { throw new Error("registrations/broken/build.yaml is not a readable build registration"); } };
    expect(await refreshAppTokens({ store, owners, registrations: broken, seeder, kube, logger, githubApp: app() })).toEqual({ refreshed: [], failed: [] });
    expect(written).toEqual([]);
    expect(kube.refreshedExternalSecrets).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("could not read which units");
  });

  it("does nothing, and says nothing, on an installation without a credentialed build unit", async () => {
    const { store } = fakeStore({ value: "ghs_x" });
    const { seeder, written } = fakeSeeder();
    const { logger, errors, warns, infos } = fakeLogger();
    const kube = buildPlane();
    const reg = new Registrations(new FakePlatformRepo()); // no build registration at all
    expect(await refreshAppTokens({ store, owners, registrations: reg, seeder, kube, logger, githubApp: app() })).toEqual({ refreshed: [], failed: [] });
    expect(written).toEqual([]);
    expect(kube.refreshedExternalSecrets).toEqual([]);
    expect(errors).toEqual([]);
    expect(warns).toEqual([]);
    expect(infos).toEqual([]);
  });
});

// A CI-ONLY UNIT'S BUILD NAMESPACE has no release pipeline, so ESO renders two of the three build
// Secrets there, and refreshBuildSecrets refuses to ask for one the namespace does not hold.
describe("refreshAppTokens — a CI-only unit", () => {
  const CI_SECRETS = ["build-git-https", "build-npmrc"] as const;
  const row = (name: string) => ({ name, ready: true, reason: "SecretSynced", targetSecret: name, refreshTime: "2026-01-01T00:00:00Z", remoteKeys: [] });
  const plane = () => new FakeClusterReader({
    externalSecretsByNamespace: {
      "ci-check-build": CI_SECRETS.map(row),
      "acme-apps-build": BUILD_TARGET_SECRETS.map(row),
    },
  });
  async function mixed(): Promise<Registrations> {
    const reg = new Registrations(new FakePlatformRepo());
    const unit = (name: string) => ({ name, repoURL: `https://github.com/acme/${name}.git`, owner: "acme", onboardedAt: "2026-01-01T00:00:00Z", suspended: false, quiesced: false });
    await reg.createBuildRegistration({ unit: unit("ci-check"), builds: [], runId: "run_ci" }, () => undefined);
    await reg.commitRegistration({ unit: unit("acme-apps"), builds: ["acme-apps"], runId: "run_2" });
    return reg;
  }

  it("rewrites its repo-pat and asks ESO for the two Secrets it holds, counts it refreshed, and leaves bump-git-https to the units that release", async () => {
    const { store } = fakeStore({ value: "ghs_unit" });
    const { seeder, written } = fakeSeeder();
    const { logger, errors } = fakeLogger();
    const kube = plane();
    const githubApp = app();
    const r = await refreshAppTokens({ store, owners, registrations: await mixed(), seeder, kube, logger, deployRepo: { repoURL: "https://github.com/acme/deploy.git" }, githubApp });
    expect(r).toEqual({ refreshed: ["ci-check", "acme-apps", DEPLOY_BUMP_UNIT], failed: [] });
    expect(written.map((w) => w.consumerName)).toEqual(["ci-check", "acme-apps", DEPLOY_BUMP_UNIT]);
    // The CI-only unit pushes nothing: its entry holds no `push` and no write token was minted for it,
    // while the unit that releases, in the same tick, has its own. The deploy repository's entry stays on `pat`.
    expect(written[0]).not.toHaveProperty("push");
    expect(written[1]).toHaveProperty("push", "ghs_fake_installation_token_scoped_1");
    expect(written[2]).not.toHaveProperty("push");
    expect(githubApp.scopedMints).toEqual([{ repositories: ["acme-apps"], permissions: { contents: "write" } }]);
    // Planted innocent in the same tick: the unit that builds asks for all three, and for the bump
    // entry's Secret once more behind the deploy repository rewrite.
    expect(kube.refreshedExternalSecrets).toEqual([
      "ci-check-build/build-git-https", "ci-check-build/build-npmrc",
      ...refreshesOf("acme-apps"),
      "acme-apps-build/bump-git-https",
    ]);
    expect(errors).toEqual([]);
  });

  it("PLANTED DEFECT: a refresh of the full three Secrets in a CI-only namespace fails the unit", async () => {
    const kube = plane();
    await expect(refreshBuildSecrets(kube, "ci-check", BUILD_TARGET_SECRETS)).rejects.toThrow(/no ExternalSecret in ci-check-build writes bump-git-https/);
  });
});

describe("refreshBuildSecrets / readBuildSecretRefreshTimes", () => {
  it("asks ESO to write exactly the three Secrets again, through the ExternalSecret that writes each, in the declared order, and deletes none", async () => {
    const kube = new FakeClusterReader({ externalSecretsByNamespace: { "acme-apps-build": [
      // Matched by the Secret written, not by the ExternalSecret's own name; one without a target writes its own name.
      { name: "git", ready: true, reason: "SecretSynced", targetSecret: "build-git-https", refreshTime: "", remoteKeys: [] },
      { name: "bump-git-https", ready: true, reason: "SecretSynced", targetSecret: "", refreshTime: "", remoteKeys: [] },
      { name: "build-npmrc", ready: true, reason: "SecretSynced", targetSecret: "build-npmrc", refreshTime: "", remoteKeys: [] },
    ] } });
    await refreshBuildSecrets(kube, "acme-apps");
    expect(kube.refreshedExternalSecrets).toEqual(["acme-apps-build/git", "acme-apps-build/bump-git-https", "acme-apps-build/build-npmrc"]);
    expect(kube.secretWrites).toEqual([]);
    expect(BUILD_TARGET_SECRETS).toEqual(["build-git-https", "bump-git-https", "build-npmrc"]);
  });

  it("refuses by namespace and Secret where no ExternalSecret writes a target, before it asks for any", async () => {
    const kube = new FakeClusterReader({ externalSecretsByNamespace: { "acme-apps-build": [
      { name: "build-git-https", ready: true, reason: "SecretSynced", targetSecret: "build-git-https", refreshTime: "", remoteKeys: [] },
    ] } });
    await expect(refreshBuildSecrets(kube, "acme-apps")).rejects.toThrow("no ExternalSecret in acme-apps-build writes bump-git-https, build-npmrc, so ESO cannot be asked to write them again");
    expect(kube.refreshedExternalSecrets).toEqual([]);
  });

  it("reads each Secret's refreshTime off the ExternalSecret row that TARGETS it, and the empty text where no row does", async () => {
    const kube = new FakeClusterReader({ externalSecretsByNamespace: { "acme-apps-build": [
      // Matched by target, not by the ExternalSecret's own name.
      { name: "git", ready: true, reason: "SecretSynced", targetSecret: "build-git-https", refreshTime: "2026-09-17T10:00:00Z", remoteKeys: [] },
      { name: "build-npmrc", ready: true, reason: "SecretSynced", targetSecret: "build-npmrc", refreshTime: "", remoteKeys: [] },
    ] } });
    expect(await readBuildSecretRefreshTimes(kube, "acme-apps")).toEqual({ "build-git-https": "2026-09-17T10:00:00Z", "bump-git-https": "", "build-npmrc": "" });
    expect(kube.listedExternalSecrets).toEqual(["acme-apps-build"]);
  });
});

describe("refreshUnitRepoPat", () => {
  const target = { name: "acme-apps", repoURL: "https://github.com/acme/acme-apps.git", ciOnly: false };

  it("opens both credentials under the purpose given, writes them as the unit's entry (pat, packages, push) and zeroes them — the owner's PAT is its own push token", async () => {
    const handed: Buffer[] = [];
    const store: Pick<CredentialStore, "open" | "list"> = { list: async () => [], open: async (id, use) => { expect(use.purpose).toBe("consumer-onboard:refresh-repo-pat"); const b = Buffer.from(`token-of-${id}`); handed.push(b); return b; } };
    const { seeder, written } = fakeSeeder();
    const githubApp = new FakeGitHubApp();
    await refreshUnitRepoPat({ store, seeder, githubApp }, target, "cred_pat", "cred_pkg", { purpose: "consumer-onboard:refresh-repo-pat" });
    expect(written).toEqual([{ consumerName: "acme-apps", pat: "token-of-cred_pat", packages: "token-of-cred_pkg", push: "token-of-cred_pat" }]);
    expect(githubApp.scopedMints).toEqual([]); // a PAT cannot be limited by the Manager, so nothing is minted for it
    expect(handed).toHaveLength(2);
    expect(handed.every((b) => b.every((x) => x === 0))).toBe(true);
  });

  it("zeroes the push token it minted for an App unit, after the write", async () => {
    const { store } = fakeStore({ value: "ghs_minted" });
    const { seeder, written } = fakeSeeder();
    const copies: { text: string; buffer: Buffer }[] = [];
    const real = Buffer.from.bind(Buffer) as (...a: unknown[]) => Buffer;
    const spy = vi.spyOn(Buffer, "from").mockImplementation(((...a: unknown[]) => {
      const buffer = real(...a);
      if (typeof a[0] === "string") copies.push({ text: a[0], buffer });
      return buffer;
    }) as never);
    try {
      await refreshUnitRepoPat({ store, seeder, githubApp: new FakeGitHubApp() }, target, "cred_app", null, { purpose: "app-token-refresh" });
    } finally {
      spy.mockRestore();
    }
    expect(written).toEqual([{ consumerName: "acme-apps", pat: "ghs_minted", packages: "", push: "ghs_fake_installation_token_scoped_1" }]);
    const minted = copies.find((c) => c.text === "ghs_fake_installation_token_scoped_1");
    expect(minted).toBeDefined();
    expect(minted!.buffer.every((x) => x === 0)).toBe(true);
  });
});
