import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { seedQuota } from "../../../shared/unit-size.ts";
import { eq } from "drizzle-orm";
import { openDb, type DbHandle } from "../../db/client.ts";
import { servers, clusters, apps } from "../../db/schema/inventory.ts";
import { makeOffboardDef, type OffboardPorts } from "./offboard.run.ts";
import { renderConsumerAppProject } from "./appproject.ts";
import { renderBuildRbac, renderConsumerArgoSync } from "./build-rbac.ts";
import { renderConsumerAdmissionPolicy } from "./admission-policy.ts";
import { renderConsumerRepoCredential } from "./repo-credential.ts";
import { Registrations, type ClusterStageResolver } from "./registrations.ts";
import { FakePlatformRepo } from "../../adapters/git/testing/fake.ts";
import { FakeMasterArgoReader, FakeClusterReader, FakeMasterProjectWriter, FakeClusterKubeResolver, FakeBuildRbacWriter, FakeRepoCredentialWriter } from "../../adapters/kube/testing/fake.ts";
import { FakeDnsProvider } from "../../adapters/dns/testing/fake.ts";
import type { StepCtx } from "../../executor/types.ts";
import type { CredentialStore } from "../../security/store.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { VaultSeeder, VaultSeedOutcome } from "./vault-seeder.ts";

// assert-no-orphans, the offboard's one measuring step. It reads back the objects the MANAGER wrote
// outside any chart — the isolation AppProject, the ArgoCD repository Secret, the admission policy and
// the build grants — plus the registration and the unit's DNS record, because no ArgoCD prune reaches
// any of them and two of the steps that remove them are fail-soft. The pair of tests below is the
// whole point of the step: the SAME `acme-build` grants standing are an orphan when the unit has left
// the platform and a deliberate remainder while another stage still releases through them, and the
// registration tree is what tells the two apart.

const REPO = "https://github.com/x/acme.git";

let db: DbHandle;
beforeEach(() => { db = openDb(":memory:"); });
afterEach(() => { db.sqlite.close(); });

// s1 carries prod (the offboard target), s2 carries dev (the stage that may survive) — a
// cluster carries exactly one stage, so a unit's two stages never share one.
const twoStageClusterStage: ClusterStageResolver = async (cluster) => ({ name: cluster, stage: cluster === "s2" ? "dev" : "prod" });

class FakeSeeder implements VaultSeeder {
  async seed(): Promise<VaultSeedOutcome> { throw new Error("offboard never seeds"); }
  async seedPostgres(): Promise<VaultSeedOutcome> { throw new Error("offboard never seeds postgres"); }
  async seedMongodb(): Promise<VaultSeedOutcome> { throw new Error("offboard never seeds mongodb"); }
  async seedBuildRepoPat(): Promise<VaultSeedOutcome> { throw new Error("offboard never seeds a repo pat"); }
  async deleteBuildRepoPat(): Promise<void> {}
  async deleteApp(): Promise<void> {}
  async deletePostgres(): Promise<void> {}
  async deleteMongodb(): Promise<void> {}
  async seedTenantCrypto(): Promise<VaultSeedOutcome> { return { created: true }; }
  async deleteTenantCrypto(): Promise<void> {}
}

function seedApp(): void {
  db.db.insert(servers).values({ id: "srv_1", name: "m1", host: "1.2.3.4", sshUser: "root", role: "master", status: "healthy" }).run();
  db.db.insert(clusters).values({ id: "cls_1", serverId: "srv_1", stage: "prod", domain: "s1.example", status: "active" }).run();
  db.db.insert(apps).values({ id: "app_1", clusterId: "cls_1", name: "acme", stage: "prod", repoUrl: REPO, chartPath: "deploy/chart", provenance: "manager", status: "active" }).run();
}

/** Register acme at prod on s1, and — when `alsoDev` — at dev on s2 as well, then git-rm the
 *  prod stage the way remove-registration does. What is left is the tree the scan reads. */
async function seedRegistrationsAndRemoveProd(reg: Registrations, alsoDev: boolean): Promise<void> {
  const unit = { name: "acme", repoURL: REPO, suspended: false, quiesced: false };
  await reg.commitRegistration({ unit, builds: ["acme"], deploy: { stage: "prod", cluster: "s1", chartPath: "deploy/chart", databases: [], services: [], size: "small", mongodb: "shared", quota: seedQuota("small") }, runId: "run_onb_prod" });
  if (alsoDev) {
    await reg.commitRegistration({ unit, builds: ["acme"], deploy: { stage: "dev", cluster: "s2", chartPath: "deploy/chart", databases: [], services: [], size: "small", mongodb: "shared", quota: seedQuota("small") }, runId: "run_onb_dev" });
  }
  await reg.removeRegistration("prod", "acme", "run_off");
}

function ctx(logs: string[]): StepCtx {
  return {
    runId: "run_off", stepName: "assert-no-orphans", db: db.db, creds: {} as unknown as CredentialStore, params: { appId: "app_1" },
    secrets: { get: () => undefined, wipe: () => undefined }, signal: new AbortController().signal, logger: {} as unknown as Logger,
    ssh: () => Promise.reject(new Error("no ssh")), openPasswordSession: () => Promise.reject(new Error("no ssh")),
    closePasswordSession: () => undefined, attest: () => Promise.reject(new Error("no attest")),
    log: (_s, t) => logs.push(t), checkpoint: () => undefined, readCheckpoint: () => undefined, registerCleanup: () => undefined,
  };
}

/** The offboard ports over one world: a master resolver on argoNamespace "argocd", the given writers,
 *  and the registrations the tree was seeded on. */
function ports(reg: Registrations, world: { cluster: FakeClusterReader; projects: FakeMasterProjectWriter; buildRbac: FakeBuildRbacWriter; repoCredential: FakeRepoCredentialWriter; dns: FakeDnsProvider }): OffboardPorts {
  return {
    registrations: reg,
    resolver: new FakeClusterKubeResolver({
      clusterReader: world.cluster,
      argoReader: new FakeMasterArgoReader({ status: { syncRevision: null, targetRevision: null, sync: "Unknown", health: "Missing" } }),
      projectWriter: world.projects,
      argoNamespace: "argocd",
    }),
    argoWatchTimeoutMs: 1000,
    seeder: new FakeSeeder(),
    dns: world.dns,
    buildRbac: world.buildRbac,
    repoCredential: world.repoCredential,
  };
}

function scanStep(prt: OffboardPorts): { run: (c: StepCtx) => Promise<void> } {
  return makeOffboardDef(prt).steps({ appId: "app_1" }).find((s) => s.name === "assert-no-orphans")!;
}

describe("offboard assert-no-orphans", () => {
  it("fails the run and names every object a fail-soft delete left behind", async () => {
    seedApp();
    const reg = new Registrations(new FakePlatformRepo(), twoStageClusterStage);
    await seedRegistrationsAndRemoveProd(reg, false); // acme has left the platform: prod was its only stage

    // The world a teardown leaves when the cluster refuses its writes: the isolation project, the
    // repository Secret, the admission boundary and every build grant are still standing, and so is the
    // unit's address. Each of them was WRITTEN by this manager outside any chart, so nothing else
    // will ever take them away.
    const projects = new FakeMasterProjectWriter();
    await projects.applyAppProject("argocd", renderConsumerAppProject({ name: "acme", namespace: "acme", repoURL: REPO, platformRepoURL: "https://github.com/x/hostyour-cloud.git", argoNamespace: "argocd" }));
    const repoCredential = new FakeRepoCredentialWriter();
    await repoCredential.applyRepoCredential(renderConsumerRepoCredential({ consumerName: "acme", argoNamespace: "argocd", repoURL: REPO, pat: "github_pat_test" }));
    const buildRbac = new FakeBuildRbacWriter();
    await buildRbac.applyBuildRbac(renderBuildRbac({ name: "acme", argoNamespace: "argocd" }));
    const cluster = new FakeClusterReader({ deployState: { domain: "s1.example", stage: "prod", writtenAt: "x", generation: 3 } });
    const { policy, binding } = renderConsumerAdmissionPolicy({ name: "acme", namespace: "acme", unitApex: "s1.example", argoAppName: "acme-prod" });
    await cluster.applyAdmissionPolicy(policy, binding);
    const dns = new FakeDnsProvider();
    dns.seed("acme.s1.example", "A", "203.0.113.10");

    const step = scanStep(ports(reg, { cluster, projects, buildRbac, repoCredential, dns }));
    const failure = await step.run(ctx([])).then(() => null, (e: Error) => e);
    expect(failure).not.toBeNull();
    const message = failure!.message;
    expect(message).toMatch(/left 10 object\(s\) standing on s1\.example/);

    // Every leftover is NAMED with where it stands — a report of what is gone would be useless here.
    for (const object of [
      "AppProject argocd/acme",
      "ArgoCD repository Secret argocd/repo-acme",
      "DNS A acme.s1.example",
      "Role acme-build/acme-build-eventlistener",
      "Role acme-build/acme-build-manager-read",
      "Role argocd/acme-argo-sync",
      "RoleBinding acme-build/acme-build-eventlistener",
      "RoleBinding acme-build/acme-build-manager-read",
      "RoleBinding argocd/acme-argo-sync",
      "admission policy consumer-acme",
    ]) {
      expect(message).toContain(object);
    }
    // The registration IS gone, so it is not among the findings.
    expect(message).not.toContain("registrations/acme/prod.yaml");
  });

  it("passes when only the remainders another stage needs are standing, and says they are kept on purpose", async () => {
    seedApp();
    const reg = new Registrations(new FakePlatformRepo(), twoStageClusterStage);
    await seedRegistrationsAndRemoveProd(reg, true); // acme still stands at dev

    // The exact objects the previous test flagged as orphans, standing for the exact same reason they
    // were never deleted: there is ONE `acme-build` namespace per unit, and dev releases through it.
    // Only prod's own argo-sync grant went, with prod.
    const buildRbac = new FakeBuildRbacWriter();
    await buildRbac.applyBuildRbac(renderBuildRbac({ name: "acme", argoNamespace: "argocd" }));
    await buildRbac.deleteBuildRbac([renderConsumerArgoSync({ name: "acme", argoNamespace: "argocd" })]);

    const logs: string[] = [];
    const step = scanStep(ports(reg, {
      cluster: new FakeClusterReader({ deployState: { domain: "s1.example", stage: "prod", writtenAt: "x", generation: 3 } }),
      projects: new FakeMasterProjectWriter(),
      buildRbac,
      repoCredential: new FakeRepoCredentialWriter(),
      dns: new FakeDnsProvider(),
    }));
    await expect(step.run(ctx(logs))).resolves.toBeUndefined();

    expect(buildRbac.keys()).toEqual([
      "Role acme-build/acme-build-eventlistener",
      "Role acme-build/acme-build-manager-read",
      "RoleBinding acme-build/acme-build-eventlistener",
      "RoleBinding acme-build/acme-build-manager-read",
    ]);
    const line = logs.find((l) => l.startsWith("nothing of acme (prod) is left standing"))!;
    expect(line).toContain("kept on purpose because the unit still stands at dev: the acme-build grants");
    expect(line).toContain("the apps row is kept as soft state");
  });

  it("is what stops record-offboard: a leftover leaves the row unsettled and the step retryable", async () => {
    seedApp();
    const reg = new Registrations(new FakePlatformRepo(), twoStageClusterStage);
    await seedRegistrationsAndRemoveProd(reg, false);
    const projects = new FakeMasterProjectWriter();
    await projects.applyAppProject("argocd", renderConsumerAppProject({ name: "acme", namespace: "acme", repoURL: REPO, platformRepoURL: "https://github.com/x/hostyour-cloud.git", argoNamespace: "argocd" }));

    const world = {
      cluster: new FakeClusterReader({ deployState: { domain: "s1.example", stage: "prod", writtenAt: "x", generation: 3 } }),
      projects,
      buildRbac: new FakeBuildRbacWriter(),
      repoCredential: new FakeRepoCredentialWriter(),
      dns: new FakeDnsProvider(),
    };
    const steps = makeOffboardDef(ports(reg, world)).steps({ appId: "app_1" });
    const scan = steps.findIndex((s) => s.name === "assert-no-orphans");
    expect(scan).toBe(steps.findIndex((s) => s.name === "record-offboard") - 1);

    await expect(steps[scan]!.run(ctx([]))).rejects.toThrow(/deliberately NOT recorded offboarded/);
    expect(db.db.select().from(apps).where(eq(apps.id, "app_1")).get()?.status).toBe("active");

    // Deleting the project is the repair, and re-running the step is how the run continues.
    await projects.deleteAppProject("argocd", "acme");
    await expect(steps[scan]!.run(ctx([]))).resolves.toBeUndefined();
  });
});
