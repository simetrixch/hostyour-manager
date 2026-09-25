import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { seedQuota } from "../../../shared/unit-size.ts";
import { openDb, type DbHandle } from "../../db/client.ts";
import { servers, clusters } from "../../db/schema/inventory.ts";
import { makeTenantAppsRepoPurgeDef, scanOrphanBuilds } from "./tenant-apps-repo-purge.run.ts";
import { Registrations } from "./registrations.ts";
import { TenantRegistrations } from "./tenant-registrations.ts";
import { FakePlatformRepo } from "../../adapters/git/testing/fake.ts";
import { FakeGitHubApp } from "../../adapters/github-app/testing/fake.ts";
import { FakeMasterArgoReader, FakeClusterReader, FakeMasterProjectWriter, FakeClusterKubeResolver } from "../../adapters/kube/testing/fake.ts";
import { FakeSeeder } from "./onboard.fixture.ts";
import type { TenantLifecyclePorts } from "./lifecycle.ts";
import type { Step, StepCtx } from "../../executor/types.ts";
import type { CredentialStore } from "../../security/store.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { TenantRegistration } from "../../../shared/tenant.ts";
import { testMembers } from "./tenant-members.fixture.ts";

// The orphan scan's predicate and the purge run (#241): a build registration is orphaned when no
// stage file stands beside it AND no tenant registration names it as appsImage; the purge deletes
// the repository where the platform created it, the registration and the Vault entry.

const GUID = "zsjs023ctne0";
const ORG = "acme-org";
const UNIT = "example-apps-simetrix";
const REPO = `https://github.com/${ORG}/${UNIT}.git`;

let db: DbHandle;
beforeEach(() => {
  db = openDb(":memory:");
  db.db.insert(servers).values({ id: "srv_1", name: "m1", host: "1.2.3.4", sshUser: "root", role: "master", status: "healthy" }).run();
  db.db.insert(clusters).values({ id: "cls_1", serverId: "srv_1", stage: "prod", domain: "s1.example", name: "s1", status: "active" }).run();
});
afterEach(() => { db.sqlite.close(); });

function entry(over: Partial<TenantRegistration> = {}): TenantRegistration {
  const apps = [{ name: "erp", seedReference: false, seedDemo: false, selections: {} }];
  return {
    cluster: "s1", members: testMembers(apps), identityProvider: "auth", routing: "host", ownDomain: "", ownDomainRedirects: [], subdomain: "simetrix", apps,
    seedUsers: false, quota: seedQuota("small"), resetNonce: "1", suspended: false, quiesced: false,
    appsImage: "", appsImageTag: "",
    ...over,
  };
}

/** A build-only registration of `name` on the platform repo, with an optional stage file beside it. */
async function registered(reg: Registrations, name: string, opts: { stage?: boolean } = {}): Promise<void> {
  await reg.commitRegistration({
    unit: { name, repoURL: `https://github.com/${ORG}/${name}.git`, suspended: false, quiesced: false },
    builds: [name],
    ...(opts.stage ? { deploy: { stage: "prod", chartPath: "deploy/chart", cluster: "s1", host: name, databases: [], keyPatterns: [], channelPatterns: [], services: [], size: "small", mongodb: "shared", quota: seedQuota("small") } } : {}),
    runId: "run_onb",
  });
}

/** The catalog's own build units — what tenant.buildRepos names on the books branch. */
const CATALOG_UNITS = ["digita-auth", "digita-platform"];

function ports(over: Partial<TenantLifecyclePorts> = {}): TenantLifecyclePorts {
  return {
    registrations: new TenantRegistrations(new FakePlatformRepo()),
    catalogBuildUnits: async () => CATALOG_UNITS,
    resolver: new FakeClusterKubeResolver({
      clusterReader: new FakeClusterReader({ deployState: { domain: "s1.example", stage: "prod", writtenAt: "x", generation: 1 } }),
      argoReader: new FakeMasterArgoReader(),
      projectWriter: new FakeMasterProjectWriter(),
      argoNamespace: "argocd",
    }),
    catalogRepoUrl: "https://github.com/acme/acme-catalog.git",
    argoWatchTimeoutMs: 1000,
    resolveUnitApex: async () => "example.com",
    ...over,
  };
}

function ctx(stepName: string, logs: string[]): StepCtx {
  return {
    runId: "run_purge", stepName, db: db.db, creds: {} as unknown as CredentialStore, params: { unit: UNIT },
    secrets: { get: () => undefined, wipe: () => undefined }, signal: new AbortController().signal, logger: {} as unknown as Logger,
    ssh: () => Promise.reject(new Error("no ssh")), openPasswordSession: () => Promise.reject(new Error("no ssh")),
    closePasswordSession: () => undefined, attest: () => Promise.reject(new Error("no attest")),
    log: (_s, t) => logs.push(t), checkpoint: () => undefined, readCheckpoint: () => undefined, registerCleanup: () => undefined,
  };
}

async function runAll(steps: Step[], logs: string[]): Promise<void> {
  for (const step of steps) await step.run(ctx(step.name, logs));
}

describe("scanOrphanBuilds", () => {
  it("lists a build registration no stage file, no tenant and no catalog build unit names, and nothing else", async () => {
    const builds = new Registrations(new FakePlatformRepo());
    const tenants = new TenantRegistrations(new FakePlatformRepo());
    await registered(builds, UNIT);                      // orphaned
    await registered(builds, "acme", { stage: true });   // a consumer: its stage file stands beside it
    await registered(builds, "example-apps-other");      // named by a tenant below
    await registered(builds, "digita-platform");         // the catalog's own build unit, build-only (#241)
    await tenants.commitTenant({ stage: "prod", guid: GUID, registration: entry({ appsRepo: `https://github.com/${ORG}/example-apps-other.git`, appsImage: "example-apps-other", appsImageTag: "1.0.0" }), runId: "run_onb" });
    expect(await scanOrphanBuilds({ registrations: tenants, buildRegistrations: builds, catalogBuildUnits: async () => CATALOG_UNITS })).toEqual([{ unit: UNIT, repoURL: REPO }]);
  });

  it("finds nothing where every build registration is accounted for, and refuses where the catalog cannot be read", async () => {
    const builds = new Registrations(new FakePlatformRepo());
    await registered(builds, "acme", { stage: true });
    await registered(builds, "digita-platform");
    const tenants = new TenantRegistrations(new FakePlatformRepo());
    expect(await scanOrphanBuilds({ registrations: tenants, buildRegistrations: builds, catalogBuildUnits: async () => CATALOG_UNITS })).toEqual([]);
    await expect(scanOrphanBuilds({ registrations: tenants, buildRegistrations: builds, catalogBuildUnits: async () => { throw new Error("catalog unreachable"); } })).rejects.toThrow(/catalog unreachable/);
  });
});

describe("tenant-apps-repo-purge run", () => {
  it("plans the three steps for an orphan and refuses a unit that is accounted for", async () => {
    const builds = new Registrations(new FakePlatformRepo());
    await registered(builds, UNIT);
    await registered(builds, "acme", { stage: true });
    await registered(builds, "digita-platform");
    const def = makeTenantAppsRepoPurgeDef(ports({ buildRegistrations: builds }));
    const plan = await def.plan({ unit: UNIT }, { db: db.db });
    expect(plan.kind).toBe("tenant-apps-repo-purge");
    expect(plan.targetId).toBe("cls_1");
    expect(plan.steps.map((s) => s.name)).toEqual(["attest-target", "remove-build-registration", "remove-repo-pat"]);
    expect(plan.summary).toContain(`The repository ${REPO} stands`);
    expect(plan.locks).toContainEqual({ resource: "git-branch", key: builds.branch });
    for (const unit of ["acme", "digita-platform", "never-registered"]) {
      await expect(def.plan({ unit }, { db: db.db })).rejects.toThrow(/not an orphaned build registration/);
    }
    const { catalogBuildUnits: _unwired, ...withoutCatalog } = ports({ buildRegistrations: builds });
    await expect(makeTenantAppsRepoPurgeDef(withoutCatalog).plan({ unit: UNIT }, { db: db.db })).rejects.toThrow(/cannot be read on this manager/);
  });

  it("removes the registration and the Vault entry and leaves the repository standing; a resume finds each already gone", async () => {
    const builds = new Registrations(new FakePlatformRepo());
    await registered(builds, UNIT);
    const githubApp = new FakeGitHubApp();
    githubApp.org = ORG;
    githubApp.seedRepository(ORG, UNIT);
    const seeder = new FakeSeeder();
    const def = makeTenantAppsRepoPurgeDef(ports({ buildRegistrations: builds, githubApp, seeder }));
    const logs: string[] = [];
    await runAll(def.steps({ unit: UNIT }), logs);
    expect(githubApp.repos.has(`${ORG}/${UNIT}`)).toBe(true);
    expect(await builds.readBuildRegistration(UNIT)).toBeNull();
    expect(seeder.deletedBuildRepoPats).toEqual([{ consumerName: UNIT }]);
    expect(logs.some((l) => l === `repository ${REPO} stands — this Manager deletes no repository (#241); it is the owner's to delete by hand once it is to go`)).toBe(true);
    expect(logs.some((l) => l === `build registration of ${UNIT} removed`)).toBe(true);
    await runAll(def.steps({ unit: UNIT }), logs);
    expect(githubApp.repos.has(`${ORG}/${UNIT}`)).toBe(true);
    expect(logs.some((l) => l === `build registration of ${UNIT} already absent`)).toBe(true);
    expect(seeder.deletedBuildRepoPats).toEqual([{ consumerName: UNIT }, { consumerName: UNIT }]);
  });

  it("says where no Vault seeder is wired, and needs no App at all", async () => {
    const builds = new Registrations(new FakePlatformRepo());
    await registered(builds, UNIT);
    const logs: string[] = [];
    await runAll(makeTenantAppsRepoPurgeDef(ports({ buildRegistrations: builds })).steps({ unit: UNIT }), logs);
    expect(await builds.readBuildRegistration(UNIT)).toBeNull();
    expect(logs.some((l) => l.includes("no Vault seeder is wired"))).toBe(true);
  });
});
