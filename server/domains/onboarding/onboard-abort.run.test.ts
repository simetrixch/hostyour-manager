import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { seedUnitSizes } from "./unit-size.ts";
import { eq } from "drizzle-orm";
import { pino } from "pino";
import { openDb, type DbHandle } from "../../db/client.ts";
import { servers, clusters, apps } from "../../db/schema/inventory.ts";
import { RunEventBus } from "../../executor/bus.ts";
import { Executor } from "../../executor/executor.ts";
import { buildRegistry } from "../runs/registry.ts";
import { getRun } from "../../executor/read.ts";
import { makeOnboardDef, type OnboardPorts } from "./onboard.run.ts";
import { Registry, type ClusterStageResolver } from "./registry.ts";
import { seedClusterMaps } from "./cluster-map.fixture.ts";
import { FakeRepoReader, FakePlatformRepo, FakeConsumerRepo } from "../../adapters/git/testing/fake.ts";
import { FakeGateRunner } from "../../adapters/gate-runner/testing/fake.ts";
import { FakeMasterArgoReader, FakeClusterReader, FakeMasterProjectWriter, FakeClusterKubeResolver, FakeBuildRbacWriter, FakeRepoCredentialWriter } from "../../adapters/kube/testing/fake.ts";
import { FakeGitHubConsumer } from "../../adapters/github-consumer/testing/fake.ts";
import { FakeBuildPlane } from "../../adapters/build-plane/testing/fake.ts";
import { FakeDnsProvider } from "../../adapters/dns/testing/fake.ts";
import { FakeActivator } from "../../adapters/activation/testing/fake.ts";
import type { ArgoAppStatus } from "../../adapters/kube/port.ts";
import type { CredentialStore } from "../../security/store.ts";
import type { SshFactory } from "../../adapters/ssh/port.ts";
import type { AnyRunDefinition } from "../../executor/types.ts";
import type { GateReport } from "../../../shared/gates.ts";
import type { ConsumerManifest } from "../../../shared/consumer.ts";
import type { VaultSeeder, VaultSeedInput, VaultSeedOutcome, BuildRepoPatSeedInput, BuildRepoPatDeleteInput, AppSecretsDeleteInput, PostgresSecretDeleteInput } from "./vault-seeder.ts";

// ABORT-WITH-CLEANUP on a consumer onboard, driven through the REAL executor (planStreamed -> approve
// -> fail -> abort) — the consumer mirror of create-tenant-abort.run.test.ts. Four properties, each a
// property of that path and of nothing else:
//
//   1. THE ABORT MUST NOT UN-DEPLOY A LIVE CONSUMER. `activate` is deliberately the LAST step, so a
//      run that failed only there stands behind a consumer that is deployed, recorded active and
//      serving — and the rollback is a full GitOps un-deploy whose prune drops the consumer's
//      databases with its ServiceClaim. The refusal lives on the definition (assertAbortable).
//
//   2. A STEP THAT FAILED vs A STEP THAT TIMED OUT WHILE SUCCEEDING. A watch that ran out its budget
//      says nothing about the minutes after it: the deployment can converge late, with NO apps row to
//      say so. The abort re-reads the generated Application at the moment it is asked, refuses when
//      the work is live, and the RETRY is the reconciliation — every step re-reads the world, so the
//      run settles green with the inventory agreeing with the cluster.
//
//   3. THE COMPENSATIONS RUN IN REGISTRATION-SAFE ORDER AND WAIT FOR THE PRUNE — the registration is
//      removed FIRST and the AppProject only after the generated Application is gone.
//
//   4. A COMPENSATION THAT FAILS FAILS VISIBLY. The old bare catches committed a failed kube delete as
//      an ok cleanup step and the run ended "cancelled — cleanup complete" over standing objects.

const SHA = "a".repeat(40);
const MINTED_TAG = "1.0.0-stable-20260719120000";
const CHART_PINS = `builds:\n  - name: acme-api\n    image: acme-api\n    tag: "${MINTED_TAG}-abc1234"\n`;

/** The deployable manifest with ONE platform-minted secret — enough for seed-secrets to make a real
 *  create, which is what arms the ceremony-secret inverse. */
const MANIFEST: ConsumerManifest = {
  apiVersion: "hostyour.cloud/v1", kind: "ConsumerManifest", mongodb: "shared" as const,
  name: "acme", owner: "team-acme", envs: ["prod"],
  chart: { path: "deploy/chart" }, services: [], databases: [],
  // In the zod output shape (key, required, generate) — the check step holds the frozen params
  // against the report by JSON equality, so the fixture states the parsed order.
  secrets: [{ key: "AUTH_BOOTSTRAP_TOKEN", required: true, generate: "hex32" }],
  builds: [{ name: "acme-api", containerfile: "Containerfile" }],
};
/** The same manifest with a declared activation — the fixture whose run fails LAST, behind a live,
 *  recorded consumer. */
const ACTIVATION_MANIFEST: ConsumerManifest = {
  ...MANIFEST,
  activation: { path: "/api/v1/bootstrap/invite-admin", method: "POST", tokenSecret: "AUTH_BOOTSTRAP_TOKEN", tokenHeader: "X-Bootstrap-Token", prompt: [] },
} as ConsumerManifest;

const REQUEST = {
  consumerName: "acme", repoURL: "https://github.com/x/acme.git", version: "1.0.0", channel: "stable",
  owner: "team-acme", chartPath: "deploy/chart", clusterId: "cls_1", repoCredentialId: "cred_pat",
};

const logger = pino({ level: "silent" });
const noSsh: SshFactory = () => Promise.reject(new Error("no ssh"));
const fakeCreds = { open: async () => Buffer.from("github_pat_test", "utf8") } as unknown as CredentialStore;
const prodClusterStage: ClusterStageResolver = async (cluster) => ({ name: cluster, stage: "prod" });

let db: DbHandle;
// The size table is seeded at BOOT (boot/wire.ts), not by the migration, so an in-memory database
// starts without it — and write-registration resolves the unit's ceiling against it. Seeding here is
// what a running Controller has done long before an onboard reaches it; without it the run fails at
// exactly that step, which is the correct behaviour and not what these tests are about.
beforeEach(() => { db = openDb(":memory:"); seedUnitSizes(db.db); });
afterEach(() => { db.sqlite.close(); });

function passReport(manifest: ConsumerManifest): GateReport {
  return {
    contractVersion: "1.3", runnerVersion: "t", repoURL: REQUEST.repoURL,
    requestedRef: "HEAD", resolvedSha: SHA, startedAt: 1, finishedAt: 2, manifest,
    dependencies: [],
    gates: [{ id: "G1", title: "manifest present", severity: "hard", status: "pass", expected: "x", found: "y", reason: null, detail: "ok" }],
    sandbox: { mustFailTargets: [], mustFailTargetsConfirmedListening: true, mustFailDenied: true, controllerAddrDenied: true, mustPassReached: true },
    verdict: "pass", reportHash: "h",
  };
}

class FakeSeeder implements VaultSeeder {
  seeded: VaultSeedInput[] = [];
  buildRepoPats: BuildRepoPatSeedInput[] = [];
  deletedBuildRepoPats: BuildRepoPatDeleteInput[] = [];
  deletedApp: AppSecretsDeleteInput[] = [];
  deletedPostgres: PostgresSecretDeleteInput[] = [];
  created = true;
  async seed(i: VaultSeedInput): Promise<VaultSeedOutcome> { this.seeded.push(i); return { created: this.created }; }
  async seedPostgres(): Promise<VaultSeedOutcome> { return { created: true }; }
  async seedMongodb(): Promise<VaultSeedOutcome> { return { created: true }; }
  async seedBuildRepoPat(i: BuildRepoPatSeedInput): Promise<VaultSeedOutcome> { this.buildRepoPats.push(i); return { created: true }; }
  async deleteBuildRepoPat(i: BuildRepoPatDeleteInput): Promise<void> { this.deletedBuildRepoPats.push(i); }
  async deleteApp(i: AppSecretsDeleteInput): Promise<void> { this.deletedApp.push(i); }
  async deletePostgres(i: PostgresSecretDeleteInput): Promise<void> { this.deletedPostgres.push(i); }
  async deleteMongodb(): Promise<void> {}
  async seedTenantCrypto(): Promise<VaultSeedOutcome> { return { created: true }; }
  async deleteTenantCrypto(): Promise<void> {}
}

function platformRepo(...domains: string[]): FakePlatformRepo {
  const repo = new FakePlatformRepo();
  for (const domain of domains) {
    repo.seed(domain, "platform/values-common.yaml", "global:\n  timezone: Europe/Amsterdam\n");
    for (const stage of ["dev", "test", "prod"]) repo.seed(domain, `platform/values-${stage}.yaml`, `global:\n  env: ${stage}\n`);
    repo.seed(domain, "cluster/profile.yaml", `global:\n  vaultUrl: https://vault.${domain}:8200\n  unitApex: example.com\n`);
  }
  return repo;
}

interface Harness {
  executor: Executor;
  registry: Registry;
  argo: FakeMasterArgoReader;
  projects: FakeMasterProjectWriter;
  cluster: FakeClusterReader;
  seeder: FakeSeeder;
  dns: FakeDnsProvider;
}

function harness(over: { manifest?: ConsumerManifest; activator?: FakeActivator; projects?: FakeMasterProjectWriter; created?: boolean } = {}): Harness {
  const platform = platformRepo("s1.example", "m1.example");
  const registry = new Registry(platform, prodClusterStage);
  const argo = new FakeMasterArgoReader({ status: { syncRevision: SHA, targetRevision: null, sync: "Synced", health: "Healthy" } });
  const projects = over.projects ?? new FakeMasterProjectWriter();
  const cluster = new FakeClusterReader({
    deployState: { domain: "s1.example", stage: "prod", writtenAt: "2026-01-01T00:00:00Z", generation: 3 },
    smoke: { namespaceExists: true, workloads: [{ kind: "Deployment", name: "acme-web", available: true, desired: 1, ready: 1 }], externalSecretsReady: true },
  });
  const seeder = new FakeSeeder();
  seeder.created = over.created ?? true;
  const buildPlane = new FakeBuildPlane();
  buildPlane.seedReleaseRun("acme", { runName: "acme-release-1", releaseTag: MINTED_TAG, succeeded: true });
  const dns = new FakeDnsProvider();
  dns.seed("s1.example", "A", "203.0.113.10");
  const ports: OnboardPorts = {
    repo: new FakeRepoReader({ resolvedSha: SHA, files: { "deploy/chart/values-prod.yaml": CHART_PINS } }),
    runner: new FakeGateRunner({ report: passReport(over.manifest ?? MANIFEST) }),
    registry,
    resolveBuildPlaneFqdn: seedClusterMaps(platform, { "s1.example": "prod", "m1.example": "prod" }),
    seeder,
    resolver: new FakeClusterKubeResolver({ clusterReader: cluster, argoReader: argo, projectWriter: projects, argoNamespace: "argocd" }),
    platformRepoURL: "https://github.com/x/hostyour-cloud.git",
    tenantSubdomains: async () => [],
    attestListening: true,
    argoWatchTimeoutMs: 1000,
    releaseWorkflowTimeoutMs: 200,
    releaseBuildTimeoutMs: 200,
    releasePollIntervalMs: 1,
    dispatchRetry: { budgetMs: 50, intervalMs: 1 },
    github: new FakeGitHubConsumer(),
    webhookSecret: "hmac_test",
    webhookSubdomain: "build",
    consumerRepo: new FakeConsumerRepo(),
    buildRbac: new FakeBuildRbacWriter(),
    repoCredential: new FakeRepoCredentialWriter(),
    buildPlane,
    dns,
    ...(over.activator ? { activator: over.activator } : {}),
  };
  const def = makeOnboardDef(ports) as unknown as AnyRunDefinition;
  const executor = new Executor({ db: db.db, creds: fakeCreds, bus: new RunEventBus(), logger, registry: buildRegistry({ db: db.db }, [def]), sshFactory: noSsh, actor: () => "op_system" });
  return { executor, registry, argo, projects, cluster, seeder, dns };
}

function seedClusters(): void {
  db.db.insert(servers).values({ id: "srv_1", name: "m1", host: "1.2.3.4", sshUser: "root", role: "master", status: "healthy" }).run();
  db.db.insert(clusters).values({ id: "cls_1", serverId: "srv_1", stage: "prod", domain: "s1.example", status: "active" }).run();
}

/** Plan + approve + settle — hands back the runId of the (usually failed) run under test. */
async function runOnboard(h: Harness): Promise<string> {
  const { runId } = await h.executor.planStreamed("onboard", REQUEST);
  await h.executor.settle(runId);
  expect(getRun(db.db, runId)?.status).toBe("planned");
  await h.executor.approve(runId);
  await h.executor.settle(runId);
  return runId;
}

const appRow = () => db.db.select().from(apps).where(eq(apps.name, "acme")).get();
const cleanupSteps = (runId: string): { name: string; status: string }[] =>
  (getRun(db.db, runId)?.steps ?? []).filter((s) => s.name.startsWith("cleanup:")).map((s) => ({ name: s.name, status: s.status }));

const STALLED: ArgoAppStatus = { syncRevision: null, targetRevision: null, sync: "OutOfSync", health: "Progressing" };
const PRUNED: ArgoAppStatus = { syncRevision: null, targetRevision: null, sync: "Unknown", health: "Missing" };
const LIVE: ArgoAppStatus = { syncRevision: SHA, targetRevision: null, sync: "Synced", health: "Healthy" };

describe("aborting an onboard whose consumer is LIVE", () => {
  it("is REFUSED after a failed activate — the run stands behind a recorded, serving consumer", async () => {
    seedClusters();
    const activator = new FakeActivator({ response: { status: 409, ok: false, json: null, bodyText: "admin_exists" } });
    const h = harness({ manifest: ACTIVATION_MANIFEST, activator });
    const runId = await runOnboard(h);

    // Precondition: failed ONLY at activate — deployed, recorded active, registration standing.
    expect(getRun(db.db, runId)?.status).toBe("failed");
    expect(getRun(db.db, runId)?.steps.find((s) => s.name === "activate")?.status).toBe("failed");
    expect(getRun(db.db, runId)?.steps.find((s) => s.name === "record-inventory")?.status).toBe("ok");
    expect(appRow()?.status).toBe("active");
    expect(await h.registry.readRegistration("prod", "acme")).not.toBeNull();

    await expect(h.executor.abortWithCleanup(runId)).rejects.toThrow(/is active on s1\.example \(prod\).*un-deploying a consumer that is serving/s);

    // Nothing was scheduled and nothing ran: the consumer is exactly as it was, and so is the run.
    expect(await h.registry.readRegistration("prod", "acme")).not.toBeNull();
    expect(h.projects.get("argocd", "acme")).toBeDefined();
    expect(appRow()?.status).toBe("active");
    expect(h.seeder.deletedApp).toEqual([]);
    expect(getRun(db.db, runId)?.status).toBe("failed");
    expect(cleanupSteps(runId)).toEqual([]);
  });

  it("distinguishes a step that FAILED from one that TIMED OUT WHILE SUCCEEDING: refused, and the retry settles the run green", async () => {
    // The run dies at watch-deployment — the Application is still converging when the budget runs out,
    // so there is NO apps row. The deployment then converges. The abort must read that truth back and
    // refuse; the retry is the reconciliation that makes the database agree with the cluster.
    seedClusters();
    const h = harness();
    h.argo.setStatus(STALLED);
    const runId = await runOnboard(h);
    expect(getRun(db.db, runId)?.status).toBe("failed");
    expect(getRun(db.db, runId)?.steps.find((s) => s.name === "watch-deployment")?.status).toBe("failed");
    // The row EXISTS and says provisioning: record-provisional wrote it before the first mutation, so
    // everything this failed run left behind — the registration, the Vault entries, the AppProject,
    // the DNS record, the webhook — is accounted for. It used to be undefined here, which is what
    // made a failed onboard's leftovers findable only by an explicit detected-scan.
    expect(appRow()?.status).toBe("provisioning");

    h.argo.setStatus(LIVE); // the deployment landed after the watch budget
    await expect(h.executor.abortWithCleanup(runId)).rejects.toThrow(/has since SUCCEEDED.*Retry the run from its failed step/s);
    expect(await h.registry.readRegistration("prod", "acme")).not.toBeNull(); // nothing torn down

    // The reconciliation: retry re-reads the world, records the consumer, and the run ends GREEN.
    await h.executor.retryFromStep(runId);
    await h.executor.settle(runId);
    expect(getRun(db.db, runId)?.status).toBe("succeeded");
    expect(appRow()?.status).toBe("active"); // the SAME row settles — intent became outcome, never a second row
  });
});

describe("aborting an onboard whose consumer never came up", () => {
  it("rolls back in registration-safe order — registration first, prune awaited, ceremony secrets destroyed", async () => {
    seedClusters();
    const h = harness();
    h.argo.setStatus(STALLED);
    const runId = await runOnboard(h);
    expect(getRun(db.db, runId)?.status).toBe("failed");

    h.argo.setStatus(PRUNED); // the half-deployed Application is gone from ArgoCD's view
    await h.executor.abortWithCleanup(runId);
    await h.executor.settle(runId);

    expect(getRun(db.db, runId)?.status).toBe("cancelled");
    // The order IS the property: the registration goes first (it is what generates the Application),
    // the prune is awaited, and only then do the per-unit objects come down. The ceremony-secret
    // inverse was armed by seed-secrets (a later step), so it runs ahead of the block.
    expect(cleanupSteps(runId)).toEqual([
      { name: "cleanup:remove-ceremony-secrets", status: "ok" },
      { name: "cleanup:remove-consumer-registration", status: "ok" },
      { name: "cleanup:watch-consumer-prune", status: "ok" },
      { name: "cleanup:delete-appproject", status: "ok" },
      { name: "cleanup:delete-admission-policy", status: "ok" },
      { name: "cleanup:delete-build-rbac", status: "ok" },
      { name: "cleanup:delete-repo-credential", status: "ok" },
      { name: "cleanup:remove-dns", status: "ok" },
      { name: "cleanup:remove-consumer-webhook", status: "ok" },
    ]);
    expect(await h.registry.readRegistration("prod", "acme")).toBeNull();
    expect(h.projects.get("argocd", "acme")).toBeUndefined();
    // The Vault entry THIS run created is destroyed, so the next onboard reaches created:true
    // instead of inheriting this run's keys under the cas=0 create-only seed.
    expect(h.seeder.deletedApp).toEqual([{ stage: "prod", consumerName: "acme" }]);
    expect(h.dns.record("acme.example.com", "A")).toBeUndefined();
  });

  it("keeps a PRE-EXISTING Vault entry: created:false means the entry is not this run's to destroy", async () => {
    seedClusters();
    const h = harness({ created: false }); // the cas=0 seed found the entry already standing
    h.argo.setStatus(STALLED);
    const runId = await runOnboard(h);

    h.argo.setStatus(PRUNED);
    await h.executor.abortWithCleanup(runId);
    await h.executor.settle(runId);

    expect(getRun(db.db, runId)?.status).toBe("cancelled");
    expect(h.seeder.deletedApp).toEqual([]); // an earlier onboard's entry survives this run's abort
    expect(cleanupSteps(runId).map((s) => s.name)).not.toContain("cleanup:remove-ceremony-secrets");
  });

  it("a compensation that fails FAILS the cleanup step — never a swallowed ok", async () => {
    seedClusters();
    class RefusingProjectWriter extends FakeMasterProjectWriter {
      override async deleteAppProject(): Promise<{ deleted: boolean }> {
        throw new Error("the master API server is unreachable");
      }
    }
    const h = harness({ projects: new RefusingProjectWriter() });
    h.argo.setStatus(STALLED);
    const runId = await runOnboard(h);

    h.argo.setStatus(PRUNED);
    await h.executor.abortWithCleanup(runId);
    await h.executor.settle(runId);

    // The failed delete is VISIBLE: the cleanup step is failed and the run is failed — re-abortable —
    // instead of "cancelled — cleanup complete" over a standing AppProject.
    expect(getRun(db.db, runId)?.status).toBe("failed");
    expect(cleanupSteps(runId).find((s) => s.name === "cleanup:delete-appproject")?.status).toBe("failed");
  });
});
