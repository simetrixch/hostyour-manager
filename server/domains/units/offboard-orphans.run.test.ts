import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { seedQuota } from "../../../shared/unit-size.ts";
import { eq } from "drizzle-orm";
import { openDb, type DbHandle } from "../../db/client.ts";
import { servers, clusters, apps } from "../../db/schema/inventory.ts";
import { makeOffboardDef, type OffboardPorts } from "./offboard.run.ts";
import { renderSmtpOpsGrant } from "./build-rbac.ts";
import { renderConsumerRepoCredential } from "./repo-credential.ts";
import { Registrations, type ClusterStageResolver } from "./registrations.ts";
import { FakePlatformRepo } from "../../adapters/git/testing/fake.ts";
import { FakeMasterArgoReader, FakeClusterReader, FakeMasterProjectWriter, FakeClusterKubeResolver, FakeBuildRbacWriter, FakeRepoCredentialWriter } from "../../adapters/kube/testing/fake.ts";
import { FakeDnsProvider } from "../../adapters/dns/testing/fake.ts";
import type { StepCtx } from "../../executor/types.ts";
import type { CredentialStore } from "../../security/store.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { VaultSeeder, VaultSeedOutcome } from "./vault-seeder.ts";

// assert-no-orphans, the offboard's one measuring step. It reads back the TWO objects the Manager
// still writes outside any chart — the ArgoCD repository Secret, whose value is a PAT, and the
// mail-ops grant, which stands in the relay's namespace on the master where a slave-hosted unit's
// reconciler cannot reach — plus the registration and the unit's DNS record, because no ArgoCD prune
// reaches any of them and both delete steps are fail-soft. Everything else a unit owns is rendered
// from its registration since hostyour-cloud#174 and goes with it, so it is not read here at all: a
// slow prune would otherwise be reported as a leftover.
//
// The pair of tests below is the whole point of the step: the SAME mail-ops grant standing is an
// orphan when the unit has left the platform and a deliberate remainder while another stage still
// mails through it, and the registration tree is what tells the two apart.

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

    // The world a teardown leaves when the cluster refuses its writes: the repository Secret and the
    // mail-ops grant are still standing, and so is the unit's address. Each was WRITTEN by this
    // manager outside any chart, so nothing else will ever take them away.
    const repoCredential = new FakeRepoCredentialWriter();
    await repoCredential.applyRepoCredential(renderConsumerRepoCredential({ consumerName: "acme", argoNamespace: "argocd", repoURL: REPO, pat: "github_pat_test" }));
    const buildRbac = new FakeBuildRbacWriter();
    await buildRbac.applyBuildRbac([renderSmtpOpsGrant({ name: "acme" })]);
    const cluster = new FakeClusterReader({ deployState: { domain: "s1.example", stage: "prod", writtenAt: "x", generation: 3 } });
    const dns = new FakeDnsProvider();
    dns.seed("acme.s1.example", "A", "203.0.113.10");

    const step = scanStep(ports(reg, { cluster, projects: new FakeMasterProjectWriter(), buildRbac, repoCredential, dns }));
    const failure = await step.run(ctx([])).then(() => null, (e: Error) => e);
    expect(failure).not.toBeNull();
    const message = failure!.message;
    expect(message).toMatch(/left 4 object\(s\) standing on s1\.example/);

    // Every leftover is NAMED with where it stands — a report of what is gone would be useless here.
    for (const object of [
      "ArgoCD repository Secret argocd/repo-acme",
      "DNS A acme.s1.example",
      "Role postfix/acme-smtp-ops",
      "RoleBinding postfix/acme-smtp-ops",
    ]) {
      expect(message).toContain(object);
    }
    // The registration IS gone, so it is not among the findings.
    expect(message).not.toContain("registrations/acme/prod.yaml");
  });

  // THE FENCES ARE SOMEBODY ELSE'S OBJECTS NOW, and this is what says so. An AppProject and an
  // admission policy still standing at the moment the scan runs are the NORMAL state of a prune that
  // has not finished — ArgoCD's clock, not this run's — so flagging them would fail a correct
  // offboard on a slow cluster.
  it("does not look at the objects a reconciler renders, so a prune still in flight is not a leftover", async () => {
    seedApp();
    const reg = new Registrations(new FakePlatformRepo(), twoStageClusterStage);
    await seedRegistrationsAndRemoveProd(reg, false);

    const projects = new FakeMasterProjectWriter();
    await projects.applyAppProject("argocd", { apiVersion: "argoproj.io/v1alpha1", kind: "AppProject", metadata: { name: "acme", namespace: "argocd", labels: { "hostyour.cloud/consumer": "true" } }, spec: { description: "d", sourceRepos: [], destinations: [], clusterResourceWhitelist: [], namespaceResourceBlacklist: [], roles: [] } });

    const logs: string[] = [];
    const step = scanStep(ports(reg, {
      cluster: new FakeClusterReader({ deployState: { domain: "s1.example", stage: "prod", writtenAt: "x", generation: 3 } }),
      projects,
      buildRbac: new FakeBuildRbacWriter(),
      repoCredential: new FakeRepoCredentialWriter(),
      dns: new FakeDnsProvider(),
    }));
    await expect(step.run(ctx(logs))).resolves.toBeUndefined();
    expect(projects.get("argocd", "acme"), "and the scan takes nothing away either").toBeDefined();
  });

  it("passes when only the remainders another stage needs are standing, and says they are kept on purpose", async () => {
    seedApp();
    const reg = new Registrations(new FakePlatformRepo(), twoStageClusterStage);
    await seedRegistrationsAndRemoveProd(reg, true); // acme still stands at dev

    // The exact object the previous test flagged as an orphan, standing for the exact same reason it
    // was never deleted: there is ONE mail-ops grant per unit, and dev mails through it.
    const buildRbac = new FakeBuildRbacWriter();
    await buildRbac.applyBuildRbac([renderSmtpOpsGrant({ name: "acme" })]);

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
      "Role postfix/acme-smtp-ops",
      "RoleBinding postfix/acme-smtp-ops",
    ]);
    const line = logs.find((l) => l.startsWith("nothing of acme (prod) is left standing"))!;
    expect(line).toContain("kept on purpose because the unit still stands at dev: the postfix grant");
    expect(line).toContain("the apps row is kept as soft state");
  });

  it("is what stops record-offboard: a leftover leaves the row unsettled and the step retryable", async () => {
    seedApp();
    const reg = new Registrations(new FakePlatformRepo(), twoStageClusterStage);
    await seedRegistrationsAndRemoveProd(reg, false);
    const buildRbac = new FakeBuildRbacWriter();
    await buildRbac.applyBuildRbac([renderSmtpOpsGrant({ name: "acme" })]);

    const world = {
      cluster: new FakeClusterReader({ deployState: { domain: "s1.example", stage: "prod", writtenAt: "x", generation: 3 } }),
      projects: new FakeMasterProjectWriter(),
      buildRbac,
      repoCredential: new FakeRepoCredentialWriter(),
      dns: new FakeDnsProvider(),
    };
    const steps = makeOffboardDef(ports(reg, world)).steps({ appId: "app_1" });
    const scan = steps.findIndex((s) => s.name === "assert-no-orphans");
    expect(scan).toBe(steps.findIndex((s) => s.name === "record-offboard") - 1);

    await expect(steps[scan]!.run(ctx([]))).rejects.toThrow(/deliberately NOT recorded offboarded/);
    expect(db.db.select().from(apps).where(eq(apps.id, "app_1")).get()?.status).toBe("active");

    // Deleting the grant is the repair, and re-running the step is how the run continues.
    await buildRbac.deleteBuildRbac([renderSmtpOpsGrant({ name: "acme" })]);
    await expect(steps[scan]!.run(ctx([]))).resolves.toBeUndefined();
  });
});
