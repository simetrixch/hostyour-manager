// The repo-pat refresh (app-token-refresh.ts): every unit whose build registration names a
// credential has its build repo-pat rewritten with the value the store opens to now — a token minted
// for the App, the PAT itself for a pat unit — beside its owner's packages reader, and its
// three build Secrets deleted behind the rewrite (#230); one unit's failure is logged and the rest go
// on; nothing rejects.
import { describe, it, expect } from "vitest";
import type { Logger } from "#core/server/kernel/logger.ts";
import type { CredentialStore } from "#core/server/security/store.ts";
import type { BuildRepoPatSeedInput } from "./adapters/vault/seeder-port.ts";
import { FakePlatformRepo } from "#core/server/adapters/git/testing/fake.ts";
import { FakeClusterReader } from "#core/server/adapters/kube/testing/fake.ts";
import { Registrations } from "./registrations.ts";
import { FakeGitHubApp } from "#core/server/adapters/github-app/testing/fake.ts";
import { BUILD_TARGET_SECRETS, CATALOG_BUMP_UNIT, deleteBuildSecrets, readBuildSecretRefreshTimes, refreshAppTokens, refreshUnitRepoPat } from "./app-token-refresh.ts";
import type { OwnerIdentityReader } from "./repo-identity.ts";

/** The three deletes one unit's refresh issues, in the order the names are declared. */
const deletesOf = (unit: string) => BUILD_TARGET_SECRETS.map((name) => ({ op: "delete" as const, namespace: `${unit}-build`, name }));

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

// THE CATALOG'S BUMP ENTRY (#197): the App's token is written to build/catalog/repo-pat on every tick
// and bump-git-https is deleted in EVERY build namespace, because every unit's release pushes the
// catalog's books branch with that one entry — the App is the catalog's one identity (hostyour-cloud#237).
describe("refreshAppTokens — the catalog bump credential from the App", () => {
  const catalogOf = (owner: string) => ({ repoURL: `https://github.com/${owner}/catalog.git` });

  it("writes the App's token to the catalog entry and deletes bump-git-https in every build namespace, the pat unit's included", async () => {
    const { store } = fakeStore({ value: "ghs_unit" });
    const { seeder, written } = fakeSeeder();
    const { logger, errors } = fakeLogger();
    const kube = new FakeClusterReader();
    const githubApp = app();
    githubApp.token = "ghs_catalog_now";
    const r = await refreshAppTokens({ store, owners, registrations: await registrations(), seeder, kube, logger, catalog: catalogOf("acme"), githubApp });
    expect(r.refreshed).toEqual(["acme-apps", "shop", "beta-apps", CATALOG_BUMP_UNIT]);
    expect(written.at(-1)).toEqual({ consumerName: "catalog", pat: "ghs_catalog_now", packages: "" }); // the bump entry installs nothing
    const bumpDeletes = kube.secretWrites.filter((w) => w.name === "bump-git-https").map((w) => w.namespace);
    expect(bumpDeletes.slice(-3)).toEqual(["acme-apps-build", "shop-build", "beta-apps-build"]);
    expect(errors).toEqual([]);
  });

  it("refuses by name where the App does not reach the catalog, and writes no bump entry", async () => {
    const { store } = fakeStore({ value: "ghs_unit" });
    const { seeder, written } = fakeSeeder();
    const { logger, errors } = fakeLogger();
    const githubApp = app();
    const unreached = await refreshAppTokens({ store, owners, registrations: await registrations(), seeder, kube: new FakeClusterReader(), logger, catalog: catalogOf("other-org"), githubApp });
    expect(unreached.failed).toEqual([CATALOG_BUMP_UNIT]);
    expect(written.some((w) => w.consumerName === "catalog")).toBe(false);
    expect(errors.at(-1)).toContain("does not reach the catalog");
  });
});

describe("refreshAppTokens", () => {
  it("rewrites the repo-pat of every unit whose build registration names a credential with the value opened NOW — the pat unit's PAT included — and deletes its three build Secrets behind the rewrite", async () => {
    const minted = { value: "ghs_minted_at_tick_1" };
    const { store, opened } = fakeStore(minted);
    const { seeder, written } = fakeSeeder();
    const { logger, errors, warns, infos } = fakeLogger();
    const kube = new FakeClusterReader();
    const reg = await registrations();
    expect(await refreshAppTokens({ store, owners, registrations: reg, seeder, kube, logger, githubApp: app() })).toEqual({ refreshed: ["acme-apps", "shop", "beta-apps"], failed: [] });
    expect(written).toEqual([
      { consumerName: "acme-apps", pat: "ghs_minted_at_tick_1", packages: "ghp_packages_acme" },
      { consumerName: "shop", pat: "github_pat_shop", packages: "ghp_packages_acme" }, // the PAT itself, and the reader of its owner (#230)
      { consumerName: "beta-apps", pat: "ghs_minted_at_tick_1", packages: "ghp_packages_acme" },
    ]);
    expect(opened).toEqual(["cred_app", "cred_pkg", "cred_pat", "cred_pkg", "cred_app", "cred_pkg"]); // the unit's credential and the owner's packages reader, per unit
    // The three target Secrets of each unit, by name, in ITS build namespace. None of them stood in
    // the fake — an absent Secret is done, not an error, exactly as the live port treats a 404.
    expect(kube.secretWrites).toEqual([...deletesOf("acme-apps"), ...deletesOf("shop"), ...deletesOf("beta-apps")]);
    expect(errors).toEqual([]);
    expect(warns).toEqual([]);
    expect(infos.some((l) => l.includes("build repo-pat entries rewritten"))).toBe(true);
    // The next tick writes the token of that hour — the value is never remembered between ticks —
    // and deletes the Secrets again, because ESO reads Vault at no other moment.
    minted.value = "ghs_minted_at_tick_2";
    await refreshAppTokens({ store, owners, registrations: reg, seeder, kube, logger, githubApp: app() });
    expect(written.at(-1)).toEqual({ consumerName: "beta-apps", pat: "ghs_minted_at_tick_2", packages: "ghp_packages_acme" });
    expect(kube.secretWrites).toHaveLength(18);
  });

  // ONE UNREACHABLE UNIT IS ITS OWN FAILURE (#240): the tick goes on to the others and the catalog.
  it("counts a unit whose repository the App does not reach and whose owner records no PAT as failed by name, and rewrites the others and the catalog in the same tick", async () => {
    const { store, opened } = fakeStore({ value: "ghs_unit" });
    const { seeder, written } = fakeSeeder();
    const { logger, errors } = fakeLogger();
    const reg = await registrations();
    await reg.commitRegistration({ unit: { name: "gone", repoURL: "https://github.com/nobody/gone.git", owner: "nobody", onboardedAt: "2026-01-01T00:00:00Z", suspended: false, quiesced: false }, builds: ["gone"], runId: "run_4" });
    const githubApp = app();
    const r = await refreshAppTokens({ store, owners, registrations: reg, seeder, kube: new FakeClusterReader(), logger, catalog: { repoURL: "https://github.com/acme/catalog.git" }, githubApp });
    expect(r.failed).toEqual(["gone"]);
    expect(r.refreshed).toEqual(["acme-apps", "shop", "beta-apps", CATALOG_BUMP_UNIT]);
    expect(written.map((w) => w.consumerName)).toEqual(["acme-apps", "shop", "beta-apps", "catalog"]);
    expect(opened).not.toContain("cred_gone");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('"unit":"gone"');
    expect(errors[0]).toContain("has no identity");
    expect(errors[0]).toContain("owner nobody records no repository PAT");
  });

  it("logs the unit whose write fails, with its name, deletes none of its Secrets, and refreshes the others", async () => {
    const { store } = fakeStore({ value: "ghs_x" });
    const { seeder, written } = fakeSeeder(["acme-apps"]);
    const { logger, errors } = fakeLogger();
    const kube = new FakeClusterReader();
    expect(await refreshAppTokens({ store, owners, registrations: await registrations(), seeder, kube, logger, githubApp: app() })).toEqual({ refreshed: ["shop", "beta-apps"], failed: ["acme-apps"] });
    expect(written.map((w) => w.consumerName)).toEqual(["shop", "beta-apps"]);
    // A Secret deleted behind a write that did not happen would make ESO materialize the DEAD value
    // again — nothing is gained, so nothing is deleted.
    expect(kube.secretWrites).toEqual([...deletesOf("shop"), ...deletesOf("beta-apps")]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('"unit":"acme-apps"');
    expect(errors[0]).toContain("repo-pat put failed");
    expect(errors[0]).not.toContain("ghs_x");
  });

  it("logs the unit whose Secret deletion fails, with its name and its build namespace, counts it failed, and the tick goes on to the next unit without rejecting", async () => {
    const { store } = fakeStore({ value: "ghs_x" });
    const { seeder, written } = fakeSeeder();
    const { logger, errors } = fakeLogger();
    const kube = new FakeClusterReader({ throwOnDeleteSecret: new Error("delete Secret acme-apps-build/build-git-https: secrets is forbidden (403)") });
    expect(await refreshAppTokens({ store, owners, registrations: await registrations(), seeder, kube, logger, githubApp: app() })).toEqual({ refreshed: [], failed: ["acme-apps", "shop", "beta-apps"] });
    // Every Vault write happened: the failure is behind the write, and the next unit was reached.
    expect(written.map((w) => w.consumerName)).toEqual(["acme-apps", "shop", "beta-apps"]);
    expect(errors).toHaveLength(3);
    expect(errors[0]).toContain('"unit":"acme-apps"');
    expect(errors[0]).toContain('"namespace":"acme-apps-build"');
    expect(errors[0]).toContain("could not be deleted");
    expect(errors[1]).toContain('"unit":"shop"');
    expect(errors[2]).toContain('"unit":"beta-apps"');
    for (const l of errors) expect(l).not.toContain("ghs_x");
  });

  it("without a wired kube it rewrites Vault, counts the units refreshed, and logs the skipped deletion naming them", async () => {
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
    const kube = new FakeClusterReader();
    const broken = { listBuildRegistrations: async () => { throw new Error("registrations/broken/build.yaml is not a readable build registration"); } };
    expect(await refreshAppTokens({ store, owners, registrations: broken, seeder, kube, logger, githubApp: app() })).toEqual({ refreshed: [], failed: [] });
    expect(written).toEqual([]);
    expect(kube.secretWrites).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("could not read which units");
  });

  it("does nothing, and says nothing, on an installation without a credentialed build unit", async () => {
    const { store } = fakeStore({ value: "ghs_x" });
    const { seeder, written } = fakeSeeder();
    const { logger, errors, warns, infos } = fakeLogger();
    const kube = new FakeClusterReader();
    const reg = new Registrations(new FakePlatformRepo()); // no build registration at all
    expect(await refreshAppTokens({ store, owners, registrations: reg, seeder, kube, logger, githubApp: app() })).toEqual({ refreshed: [], failed: [] });
    expect(written).toEqual([]);
    expect(kube.secretWrites).toEqual([]);
    expect(errors).toEqual([]);
    expect(warns).toEqual([]);
    expect(infos).toEqual([]);
  });
});

describe("deleteBuildSecrets / readBuildSecretRefreshTimes", () => {
  it("deletes exactly the three target Secrets of the ExternalSecrets in <unit>-build, in the declared order", async () => {
    const kube = new FakeClusterReader();
    await deleteBuildSecrets(kube, "acme-apps");
    expect(kube.secretWrites).toEqual(deletesOf("acme-apps"));
    expect(BUILD_TARGET_SECRETS).toEqual(["build-git-https", "bump-git-https", "build-npmrc"]);
  });

  it("reads each Secret's refreshTime off the ExternalSecret row that TARGETS it, and the empty text where no row does", async () => {
    const kube = new FakeClusterReader({ externalSecretsByNamespace: { "acme-apps-build": [
      // Matched by target, not by the ExternalSecret's own name.
      { name: "git", ready: true, reason: "SecretSynced", targetSecret: "build-git-https", refreshTime: "2026-09-17T10:00:00Z" },
      { name: "build-npmrc", ready: true, reason: "SecretSynced", targetSecret: "build-npmrc", refreshTime: "" },
    ] } });
    expect(await readBuildSecretRefreshTimes(kube, "acme-apps")).toEqual({ "build-git-https": "2026-09-17T10:00:00Z", "bump-git-https": "", "build-npmrc": "" });
    expect(kube.listedExternalSecrets).toEqual(["acme-apps-build"]);
  });
});

describe("refreshUnitRepoPat", () => {
  it("opens both credentials under the purpose given, writes them as the unit's entry (pat, packages) and zeroes both", async () => {
    const handed: Buffer[] = [];
    const store: Pick<CredentialStore, "open"> = { open: async (id, use) => { expect(use.purpose).toBe("consumer-onboard:refresh-repo-pat"); const b = Buffer.from(`token-of-${id}`); handed.push(b); return b; } };
    const { seeder, written } = fakeSeeder();
    await refreshUnitRepoPat({ store, seeder }, "acme-apps", "cred_app", "cred_pkg", { purpose: "consumer-onboard:refresh-repo-pat" });
    expect(written).toEqual([{ consumerName: "acme-apps", pat: "token-of-cred_app", packages: "token-of-cred_pkg" }]);
    expect(handed).toHaveLength(2);
    expect(handed.every((b) => b.every((x) => x === 0))).toBe(true);
  });
});
