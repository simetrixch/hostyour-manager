import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { seedQuota } from "../../../shared/unit-size.ts";
import { eq } from "drizzle-orm";
import { openDb, type DbHandle } from "../../db/client.ts";
import { servers, clusters, apps } from "../../db/schema/inventory.ts";
import { makeOffboardDef, type OffboardPorts } from "./offboard.run.ts";
import { renderConsumerAppProject } from "./appproject.ts";
import { renderBuildRbac, renderConsumerArgoSync } from "./build-rbac.ts";
import { Registrations, type ClusterStageResolver } from "./registrations.ts";
import { BUILD_HOOK_URL } from "./cluster-map.fixture.ts";
import { FakePlatformRepo, FakeConsumerRepo } from "../../adapters/git/testing/fake.ts";
import { FakeMasterArgoReader, FakeClusterReader, FakeMasterProjectWriter, FakeClusterKubeResolver, FakeBuildRbacWriter } from "../../adapters/kube/testing/fake.ts";
import { FakeGitHubConsumer } from "../../adapters/github-consumer/testing/fake.ts";
import { FakeDnsProvider } from "../../adapters/dns/testing/fake.ts";
import type { StepCtx } from "../../executor/types.ts";
import type { CredentialStore } from "../../security/store.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { VaultSeeder, VaultSeedOutcome, BuildRepoPatDeleteInput, AppSecretsDeleteInput, PostgresSecretDeleteInput, MongodbSecretDeleteInput } from "./vault-seeder.ts";

// The SCOPE half of offboard — split from offboard.run.test.ts, whose fixtures are all single-stage.
// An offboard removes ONE STAGE of a unit, and a unit deployed at two stages is two of some things and
// one of others. Per stage, because a cluster carries exactly one stage and the unit's stages therefore
// stand on different clusters: the registration, the Application, the AppProject, the repository
// credential, the admission policy, the namespace, the DNS record, the argo-sync grant, the
// <stage>/consumer/<name>/* Vault entries and the apps row. Per UNIT, one copy shared by every stage:
// the `<name>-build` namespace's two grants, secret/build/<name>/repo-pat, the ONE build webhook on the
// consumer repo, and the release kit committed into it. These tests hold both halves: offboarding prod
// while dev stands leaves dev everything it releases and deploys through, and offboarding dev afterwards
// — the unit's last stage — takes the shared set with it.

let db: DbHandle;
beforeEach(() => { db = openDb(":memory:"); });
afterEach(() => { db.sqlite.close(); });

// The unit's two stages stand on two clusters, so the stage boundary is asked about both: s1 is the
// prod cluster (the offboard target) and s2 the dev one (the stage that must survive).
const twoStageClusterStage: ClusterStageResolver = async (cluster) => ({ name: cluster, stage: cluster === "s2" ? "dev" : "prod" });

const REPO = "https://github.com/x/acme.git";
const KIT_PATHS = ["release/release.sh", ".github/workflows/release.yml"];

class FakeSeeder implements VaultSeeder {
  deleted: BuildRepoPatDeleteInput[] = [];
  deletedApp: AppSecretsDeleteInput[] = [];
  deletedPostgres: PostgresSecretDeleteInput[] = [];
  deletedMongodb: MongodbSecretDeleteInput[] = [];
  async seed(): Promise<VaultSeedOutcome> { throw new Error("offboard never seeds"); }
  async seedPostgres(): Promise<VaultSeedOutcome> { throw new Error("offboard never seeds postgres"); }
  async seedMongodb(): Promise<VaultSeedOutcome> { throw new Error("offboard never seeds mongodb"); }
  async seedBuildRepoPat(): Promise<VaultSeedOutcome> { throw new Error("offboard never seeds a repo pat"); }
  async deleteBuildRepoPat(i: BuildRepoPatDeleteInput): Promise<void> { this.deleted.push(i); }
  async deleteApp(i: AppSecretsDeleteInput): Promise<void> { this.deletedApp.push(i); }
  async deletePostgres(i: PostgresSecretDeleteInput): Promise<void> { this.deletedPostgres.push(i); }
  async deleteMongodb(i: MongodbSecretDeleteInput): Promise<void> { this.deletedMongodb.push(i); }
  async seedTenantCrypto(): Promise<VaultSeedOutcome> { return { created: true }; }
  async deleteTenantCrypto(): Promise<void> {}
}

/** Commit acme at BOTH stages: prod on s1 and dev on s2, each with the build.yaml both share. */
async function seedTwoStages(reg: Registrations): Promise<void> {
  const unit = { name: "acme", repoURL: REPO, suspended: false, quiesced: false };
  for (const deploy of [{ stage: "prod" as const, cluster: "s1" }, { stage: "dev" as const, cluster: "s2" }]) {
    await reg.commitRegistration({
      unit,
      builds: ["acme"],
      deploy: { ...deploy, chartPath: "deploy/chart", databases: [], services: [], size: "small", mongodb: "shared", quota: seedQuota("small") },
      runId: `run_onb_${deploy.stage}`,
    });
  }
}

/** prod: the master cluster s1.example + acme's row there (app_1) — the offboard under test. */
function seedProdApp(): void {
  db.db.insert(servers).values({ id: "srv_1", name: "m1", host: "1.2.3.4", sshUser: "root", role: "master", status: "healthy" }).run();
  db.db.insert(clusters).values({ id: "cls_1", serverId: "srv_1", stage: "prod", domain: "s1.example", status: "active" }).run();
  db.db.insert(apps).values({ id: "app_1", clusterId: "cls_1", name: "acme", stage: "prod", repoUrl: REPO, chartPath: "deploy/chart", provenance: "controller", status: "active", repoCredentialId: "cred_prod" }).run();
}

/** dev: its OWN server, cluster and row (app_2) — a cluster carries exactly one stage, so the unit's
 *  second stage cannot share s1. The row the "last stage" offboard is driven from. */
function seedDevApp(): void {
  db.db.insert(servers).values({ id: "srv_2", name: "s2", host: "1.2.3.5", sshUser: "root", role: "slave", status: "healthy" }).run();
  db.db.insert(clusters).values({ id: "cls_2", serverId: "srv_2", stage: "dev", domain: "s2.example", status: "active" }).run();
  db.db.insert(apps).values({ id: "app_2", clusterId: "cls_2", name: "acme", stage: "dev", repoUrl: REPO, chartPath: "deploy/chart", provenance: "controller", status: "active", repoCredentialId: "cred_dev" }).run();
}

/** The build grants as the two onboards left them: ONE `acme-build` namespace shared by both stages
 *  (four objects), plus one argo-sync pair per stage in ITS cluster's own ArgoCD namespace. */
async function seedBuildGrants(): Promise<FakeBuildRbacWriter> {
  const buildRbac = new FakeBuildRbacWriter();
  await buildRbac.applyBuildRbac(renderBuildRbac({ name: "acme", argoNamespace: "argocd" }));
  await buildRbac.applyBuildRbac([renderConsumerArgoSync({ name: "acme", argoNamespace: "s2" })]);
  return buildRbac;
}

/** A resolver that answers each cluster with ITS ArgoCD namespace + deploy-state: cls_1 the master's
 *  "argocd" on s1.example/prod, cls_2 the per-slave "s2" on s2.example/dev. */
function twoClusterResolver(projects: FakeMasterProjectWriter): FakeClusterKubeResolver {
  const pruned = new FakeMasterArgoReader({ status: { syncRevision: null, targetRevision: null, sync: "Unknown", health: "Missing" } });
  const resolver = new FakeClusterKubeResolver({
    clusterReader: new FakeClusterReader({ deployState: { domain: "s1.example", stage: "prod", writtenAt: "x", generation: 3 } }),
    argoReader: pruned,
    projectWriter: projects,
    argoNamespace: "argocd",
  });
  resolver.set("cls_2", {
    clusterReader: new FakeClusterReader({ deployState: { domain: "s2.example", stage: "dev", writtenAt: "x", generation: 4 } }),
    argoReader: pruned,
    projectWriter: projects,
    argoNamespace: "s2",
  });
  return resolver;
}

function ctx(stepName: string, logs: string[], creds: CredentialStore): StepCtx {
  return {
    runId: "run_off", stepName, db: db.db, creds, params: {},
    secrets: { get: () => undefined, wipe: () => undefined }, signal: new AbortController().signal, logger: {} as unknown as Logger,
    ssh: () => Promise.reject(new Error("no ssh")), openPasswordSession: () => Promise.reject(new Error("no ssh")),
    closePasswordSession: () => undefined, attest: () => Promise.reject(new Error("no attest")),
    log: (_s, t) => logs.push(t), checkpoint: () => undefined, readCheckpoint: () => undefined, registerCleanup: () => undefined,
  };
}

describe("offboard scope — one stage of a two-stage unit", () => {
  it("leaves the other stage everything it needs to build, release and deploy", async () => {
    seedProdApp();
    const platform = new FakePlatformRepo();
    const reg = new Registrations(platform, twoStageClusterStage);
    await seedTwoStages(reg);

    const buildRbac = await seedBuildGrants();
    const projects = new FakeMasterProjectWriter();
    await projects.applyAppProject("argocd", renderConsumerAppProject({ name: "acme", namespace: "acme", repoURL: REPO, platformRepoURL: "https://github.com/x/hostyour-cloud.git", argoNamespace: "argocd" }));
    const github = new FakeGitHubConsumer();
    github.seedHook("x", "acme", BUILD_HOOK_URL);
    const consumerRepo = new FakeConsumerRepo();
    for (const path of KIT_PATHS) consumerRepo.seed(REPO, path, "kit");
    const seeder = new FakeSeeder();
    const dns = new FakeDnsProvider();
    dns.seed("acme.s1.example", "A", "203.0.113.10"); // prod's own host
    dns.seed("acme.s2.example", "A", "203.0.113.20"); // dev's — under the OTHER cluster's apex
    const revoked: string[] = [];
    const creds = {
      open: () => Promise.resolve(Buffer.from("github_pat_test", "utf8")),
      revoke: (id: string) => { revoked.push(id); return Promise.resolve(); },
    } as unknown as CredentialStore;

    const logs: string[] = [];
    const prt: OffboardPorts = {
      registrations: reg, resolver: twoClusterResolver(projects), argoWatchTimeoutMs: 1000,
      seeder, dns, github, consumerRepo, buildRbac,
    };
    for (const step of makeOffboardDef(prt).steps({ appId: "app_1" })) await step.run(ctx(step.name, logs, creds));

    // PER STAGE — prod's own objects are gone.
    expect(await reg.readRegistration("prod", "acme")).toBeNull();
    expect(projects.get("argocd", "acme")).toBeUndefined();
    expect(dns.record("acme.s1.example", "A")).toBeUndefined();
    expect(seeder.deletedApp).toEqual([{ stage: "prod", consumerName: "acme" }]);
    expect(db.db.select().from(apps).where(eq(apps.id, "app_1")).get()?.status).toBe("offboarded");
    // The sealed clone credential is the ROW's own — every stage's onboard seals its own — so revoking
    // prod's leaves dev holding cred_dev.
    expect(revoked).toEqual(["cred_prod"]);

    // PER UNIT — everything dev still releases and deploys through is untouched.
    expect(await reg.readRegistration("dev", "acme")).not.toBeNull();
    expect(platform.read(platform.booksBranch, "registrations/acme/build.yaml")).not.toBeNull();
    expect(buildRbac.keys()).toEqual([
      "Role acme-build/acme-build-eventlistener",
      "Role acme-build/acme-build-manager-read",
      "Role s2/acme-argo-sync",
      "RoleBinding acme-build/acme-build-eventlistener",
      "RoleBinding acme-build/acme-build-manager-read",
      "RoleBinding s2/acme-argo-sync",
    ]);
    expect(github.hooksFor("x", "acme")).toHaveLength(1);
    expect(github.deletedCalls).toEqual([]);
    expect(consumerRepo.commits).toEqual([]);
    expect(seeder.deleted).toEqual([]);
    expect(dns.record("acme.s2.example", "A")).toBeDefined();
    // One skip line per per-unit cleanup: the build-namespace grants, the webhook, the release kit, the PAT.
    expect(logs.filter((l) => l.includes("stays registered at dev"))).toHaveLength(4);
  });

  it("removes what the stages shared once the LAST stage is offboarded", async () => {
    seedProdApp();
    seedDevApp();
    const platform = new FakePlatformRepo();
    const reg = new Registrations(platform, twoStageClusterStage);
    await seedTwoStages(reg);

    const buildRbac = await seedBuildGrants();
    const github = new FakeGitHubConsumer();
    github.seedHook("x", "acme", BUILD_HOOK_URL); // both stages' onboards resolved this one host, so there is one hook
    const consumerRepo = new FakeConsumerRepo();
    for (const path of KIT_PATHS) consumerRepo.seed(REPO, path, "kit");
    const seeder = new FakeSeeder();
    const creds = {
      open: () => Promise.resolve(Buffer.from("github_pat_test", "utf8")),
      revoke: () => Promise.resolve(),
    } as unknown as CredentialStore;

    const prt: OffboardPorts = {
      registrations: reg, resolver: twoClusterResolver(new FakeMasterProjectWriter()), argoWatchTimeoutMs: 1000,
      seeder, dns: new FakeDnsProvider(), github, consumerRepo, buildRbac,
    };
    const logs: string[] = [];
    // prod first (the unit survives at dev), then dev — the run that IS the unit's last stage.
    for (const step of makeOffboardDef(prt).steps({ appId: "app_1" })) await step.run(ctx(step.name, logs, creds));
    for (const step of makeOffboardDef(prt).steps({ appId: "app_2" })) await step.run(ctx(step.name, logs, creds));

    // The unit stands nowhere now, so removeRegistration took build.yaml and every per-unit cleanup ran.
    expect(platform.read(platform.booksBranch, "registrations/acme/build.yaml")).toBeNull();
    expect(buildRbac.keys()).toEqual([]);
    expect(github.hooksFor("x", "acme")).toEqual([]);
    expect(consumerRepo.commits.map((c) => c.remove)).toEqual([["release", ".github/workflows/release.yml"]]);
    expect(seeder.deleted).toEqual([{ consumerName: "acme" }]);
    expect(db.db.select().from(apps).where(eq(apps.id, "app_2")).get()?.status).toBe("offboarded");
  });
});
