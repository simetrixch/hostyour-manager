import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { seedUnitSizes } from "./unit-size.ts";
import { eq } from "drizzle-orm";
import { pino } from "pino";
import { openDb, type DbHandle } from "../../db/client.ts";
import { servers, clusters, apps } from "../../db/schema/inventory.ts";
import { Executor } from "../../executor/executor.ts";
import { RunEventBus } from "../../executor/bus.ts";
import { CredentialStore } from "../../security/store.ts";
import { buildRegistry } from "../../domains/runs/registry.ts";
import { getRun, readEvents } from "../../executor/read.ts";
import { makeOnboardDef, type OnboardPorts } from "./onboard.run.ts";
import { Registry, type ClusterStageResolver } from "./registry.ts";
import { seedClusterMaps } from "./cluster-map.fixture.ts";
import { FakeRepoReader, FakePlatformRepo, FakeConsumerRepo } from "../../adapters/git/testing/fake.ts";
import { FakeGateRunner } from "../../adapters/gate-runner/testing/fake.ts";
import { FakeMasterArgoReader, FakeClusterReader, FakeMasterProjectWriter, FakeClusterKubeResolver, FakeBuildRbacWriter } from "../../adapters/kube/testing/fake.ts";
import { FakeActivator } from "../../adapters/activation/testing/fake.ts";
import { FakeGitHubConsumer } from "../../adapters/github-consumer/testing/fake.ts";
import { FakeBuildPlane } from "../../adapters/build-plane/testing/fake.ts";
import { FakeDnsProvider } from "../../adapters/dns/testing/fake.ts";
import { FakeRepoCredentialWriter } from "../../adapters/kube/testing/fake.ts";
import { ACTIVATION_RESULT_MARKER } from "../../../shared/api-types.ts";
import type { SshFactory } from "../../adapters/ssh/port.ts";
import type { GateReport, GateResult } from "../../../shared/gates.ts";
import type { ConsumerManifest } from "../../../shared/consumer.ts";
import type { VaultSeeder, VaultSeedInput, VaultSeedOutcome } from "./vault-seeder.ts";

const SHA = "a".repeat(40);
const logger = pino({ level: "silent" });
const noSsh: SshFactory = () => Promise.reject(new Error("no ssh in the onboard journey"));
const noSeeder: VaultSeeder = { seed: async () => ({ created: true }), seedPostgres: async () => ({ created: true }), seedMongodb: async () => ({ created: true }), seedBuildRepoPat: async () => ({ created: true }), deleteBuildRepoPat: async () => {}, deleteApp: async () => {}, deletePostgres: async () => {}, deleteMongodb: async () => {}, seedTenantCrypto: async () => ({ created: true }), deleteTenantCrypto: async () => {} };

// Every fixture onboards to the prod stage, so a fixed resolver answers every cluster with "prod" —
// the stage boundary Registry.commitRegistration checks before it ever writes a stage file.
const prodClusterStage: ClusterStageResolver = async (cluster) => ({ name: cluster, stage: "prod" });

/** A FakePlatformRepo whose cluster values chain carries `global.unitApex` — onboard's planStream
 *  resolves OnboardParams.unitApex from exactly this chain (admission-policy.ts unitApexFromChain),
 *  and the fake's own default chain does not state it. Seeded directly (not via fetchResetBranch) so
 *  the fake's lazy default-chain seed never overwrites it. */
function platformRepo(domain: string): FakePlatformRepo {
  const repo = new FakePlatformRepo();
  repo.seed(domain, "platform/values-common.yaml", "global:\n  timezone: Europe/Amsterdam\n");
  for (const stage of ["dev", "test", "prod"]) repo.seed(domain, `platform/values-${stage}.yaml`, `global:\n  env: ${stage}\n`);
  repo.seed(domain, "cluster/profile.yaml", `global:\n  vaultUrl: https://vault.${domain}:8200\n  unitApex: example.com\n`);
  return repo;
}

let db: DbHandle;
// The size table is seeded at BOOT (boot/wire.ts), not by the migration, so an in-memory database
// starts without it — and write-registration resolves the unit's ceiling against it. Seeding here is
// what a running Controller has done long before an onboard reaches it; without it the run fails at
// exactly that step, which is the correct behaviour and not what these tests are about.
beforeEach(() => { db = openDb(":memory:"); seedUnitSizes(db.db); });
afterEach(() => { db.sqlite.close(); });

/** The manifest every fixture onboards: one declared build, so gate G18's manifest half holds. */
const MANIFEST: ConsumerManifest = {
  apiVersion: "hostyour.cloud/v1", kind: "ConsumerManifest", mongodb: "shared" as const,
  name: "acme", owner: "team-acme", envs: ["prod"],
  chart: { path: "deploy/chart" }, services: [], databases: [], secrets: [],
  builds: [{ name: "acme-api", containerfile: "Containerfile" }],
};
/** The chart's per-stage pin G18's chart half reads — the builds[] entry whose `image` is the build
 *  name, i.e. the key the release pipeline's bump task writes the tag into. */
/** The minted tag of the fixture release {1.0.0, stable} — the delivery branch's pins carry it, and
 *  watch-deployment reads it off exactly that file. */
const MINTED_TAG = "1.0.0-stable-20260719120000";
const CHART_PINS = `builds:\n  - name: acme-api\n    image: acme-api\n    tag: "${MINTED_TAG}-abc1234"\n`;

function report(gate: GateResult, verdict: "pass" | "fail"): GateReport {
  return {
    contractVersion: "1.3", runnerVersion: "t", repoURL: "https://github.com/x/acme.git",
    requestedRef: "main", resolvedSha: SHA, startedAt: 1, finishedAt: 2, manifest: MANIFEST,
    dependencies: [], gates: [gate], verdict, reportHash: "h",
    sandbox: { mustFailTargets: [], mustFailTargetsConfirmedListening: true, mustFailDenied: true, controllerAddrDenied: true, mustPassReached: true },
  };
}
const g1Pass: GateResult = { id: "G1", title: "manifest", severity: "hard", status: "pass", expected: "x", found: "y", reason: null, detail: "ok" };
const g1Fail: GateResult = { id: "G1", title: "manifest", severity: "hard", status: "fail", expected: "x", found: "missing", reason: "no manifest; rejected", detail: "missing" };

function fakePorts(over: Partial<OnboardPorts> = {}): OnboardPorts {
  const platform = platformRepo("s1.example");
  return {
    repo: new FakeRepoReader({ resolvedSha: SHA, files: { "deploy/chart/values-prod.yaml": CHART_PINS } }),
    runner: new FakeGateRunner({ report: report(g1Pass, "pass") }),
    registry: new Registry(platform, prodClusterStage),
    resolveBuildPlaneFqdn: seedClusterMaps(platform, { "s1.example": "prod" }),
    seeder: noSeeder,
    // The steps resolve their kube clients per target cluster; the master path resolves to
    // the master-local fakes + argoNamespace "argocd", behavior-identical to the pre-resolver wiring.
    resolver: new FakeClusterKubeResolver({
      clusterReader: new FakeClusterReader({
        deployState: { domain: "s1.example", stage: "prod", writtenAt: "2026-01-01T00:00:00Z", generation: 3 },
        smoke: { namespaceExists: true, workloads: [{ kind: "Deployment", name: "acme", available: true, desired: 1, ready: 1 }], externalSecretsReady: true },
      }),
      argoReader: new FakeMasterArgoReader({ status: { syncRevision: SHA, targetRevision: null, sync: "Synced", health: "Healthy" } }),
      projectWriter: new FakeMasterProjectWriter(),
      argoNamespace: "argocd",
    }),
    platformRepoURL: "https://github.com/x/hostyour-cloud.git",
    tenantSubdomains: async () => [],
    attestListening: true,
    argoWatchTimeoutMs: 1000,
    releaseWorkflowTimeoutMs: 200,
    releaseBuildTimeoutMs: 200,
    releasePollIntervalMs: 1,
    dispatchRetry: { budgetMs: 50, intervalMs: 1 },
    github: new FakeGitHubConsumer(),
    webhookSecret: "hmac_journey",
    webhookSubdomain: "build",
    consumerRepo: new FakeConsumerRepo(),
    buildRbac: new FakeBuildRbacWriter(),
    repoCredential: new FakeRepoCredentialWriter(),
    buildPlane: journeyBuildPlane(),
    dns: journeyDns(),
    ...over,
  };
}

/** The build plane already carries the unit's Succeeded release run — the EventListener would have
 *  created it when the triggered workflow pushed the deploy ref. */
function journeyBuildPlane(): FakeBuildPlane {
  const bp = new FakeBuildPlane();
  bp.seedReleaseRun("acme", { runName: "acme-release-1", releaseTag: MINTED_TAG, succeeded: true });
  return bp;
}

/** The target cluster's own A record — what provision-dns points the unit's record at. */
function journeyDns(): FakeDnsProvider {
  const dns = new FakeDnsProvider();
  dns.seed("s1.example", "A", "203.0.113.10");
  return dns;
}

function makeExecutor(ports: OnboardPorts): { executor: Executor; store: CredentialStore; bus: RunEventBus } {
  const store = new CredentialStore({ db: db.db, logger });
  const bus = new RunEventBus();
  const executor = new Executor({ db: db.db, creds: store, bus, logger, registry: buildRegistry({ db: db.db }, [makeOnboardDef(ports)]), sshFactory: noSsh, actor: () => "op_system" });
  return { executor, store, bus };
}

function seedCluster(): void {
  db.db.insert(servers).values({ id: "srv_1", name: "m1", host: "1.2.3.4", sshUser: "root", role: "master", status: "healthy" }).run();
  db.db.insert(clusters).values({ id: "cls_1", serverId: "srv_1", stage: "prod", domain: "s1.example", status: "active" }).run();
}

// What the API handler hands the executor AFTER sealing the operator's raw PAT: the request minus
// repoPat plus the sealed reference (OnboardPlanRequest). sealPat mirrors that handler here.
// {version, channel} — the run TRIGGERS the release; it never carries a ref or a tag.
const REQUEST = { consumerName: "acme", repoURL: "https://github.com/x/acme.git", version: "1.0.0", channel: "stable", clusterId: "cls_1", owner: "team-acme", chartPath: "deploy/chart" };

async function sealPat(store: CredentialStore): Promise<string> {
  const ref = await store.seal({ kind: "pat", label: "consumer repo PAT (acme)", plaintext: Buffer.from("github_pat_journey", "utf8"), fingerprint: "sha256:test" });
  return ref.id;
}

describe("onboard end-to-end journey (real Executor, fake adapters)", () => {
  it("plan(streaming) -> planned -> approve -> execute -> succeeded, app recorded + pointer live", async () => {
    seedCluster();
    const ports = fakePorts();
    const { executor, store } = makeExecutor(ports);
    const credId = await sealPat(store);

    const { runId } = await executor.planStreamed("onboard", { ...REQUEST, repoCredentialId: credId });
    await executor.settle(runId);
    const planned = getRun(db.db, runId);
    expect(planned?.status).toBe("planned");
    expect(planned?.steps.map((s) => s.name)).toEqual([
      "attest-target", "preflight-scopes", "check", "record-provisional", "write-registration", "seed-secrets", "seed-postgres-superuser", "seed-mongodb-instance", "seed-repo-pat",
      "provision-repo-credential", "apply-appproject", "apply-admission-policy", "provision-build-rbac", "provision-dns",
      "inject-release-kit", "setup-webhook", "trigger-release", "watch-release-workflow", "watch-release-build", "watch-deployment",
      "smoke", "record-inventory",
    ]);
    expect(planned?.targetKind).toBe("cluster");
    expect(planned?.targetId).toBe("cls_1");

    await executor.approve(runId);
    await executor.settle(runId);
    expect(getRun(db.db, runId)?.status).toBe("succeeded");

    expect(await ports.registry.readRegistration("prod", "acme")).not.toBeNull();
    const app = db.db.select().from(apps).where(eq(apps.name, "acme")).get();
    expect(app?.provenance).toBe("controller"); // the word create-tenant writes for a tenant — one act, one word
    expect(app?.clusterId).toBe("cls_1");
    expect(app?.lastRunId).toBe(runId);

    // The release cycle was TRIGGERED once through the injected workflow and its results read back.
    const github = ports.github as FakeGitHubConsumer;
    expect(github.dispatches).toHaveLength(1);
    expect(github.dispatches[0]!.inputs).toEqual({ version: "1.0.0", channel: "stable", stage: "prod" });
    expect((ports.dns as FakeDnsProvider).record("acme.example.com", "A")).toBe("203.0.113.10");
  });

  it("a rejected validation settles the run failed with no steps and no inventory", async () => {
    seedCluster();
    const { executor, store } = makeExecutor(fakePorts({ runner: new FakeGateRunner({ report: report(g1Fail, "fail") }) }));
    const credId = await sealPat(store);

    const { runId } = await executor.planStreamed("onboard", { ...REQUEST, repoCredentialId: credId });
    await executor.settle(runId);
    const rejected = getRun(db.db, runId);
    expect(rejected?.status).toBe("failed");
    expect(rejected?.steps).toHaveLength(0); // nothing was planned
    expect(db.db.select().from(apps).where(eq(apps.name, "acme")).get()).toBeUndefined();
  });

  it("an unknown target cluster fails planning cleanly (no run left stuck in planning)", async () => {
    // no seedCluster() — cls_1 does not exist
    const { executor } = makeExecutor(fakePorts());
    const { runId } = await executor.planStreamed("onboard", { ...REQUEST, repoCredentialId: "cred_x" });
    await executor.settle(runId);
    expect(getRun(db.db, runId)?.status).toBe("failed");
  });

  it("a manifest-declared activation runs the endpoint at approve-time, surfaces the activate_url once, and never persists the token/url", async () => {
    seedCluster();
    // Records the seeded entry so the test can read the minted token back and prove it never lands
    // anywhere persisted (the seed itself is create-only, returning created:true this first onboard).
    class RecordingSeeder implements VaultSeeder {
      seeded: VaultSeedInput[] = [];
      async seed(i: VaultSeedInput): Promise<VaultSeedOutcome> { this.seeded.push(i); return { created: true }; }
      async seedPostgres(): Promise<VaultSeedOutcome> { return { created: true }; }
  async seedMongodb(): Promise<VaultSeedOutcome> { return { created: true }; }
      async seedBuildRepoPat(): Promise<VaultSeedOutcome> { return { created: true }; }
      async deleteBuildRepoPat(): Promise<void> {}
      async deleteApp(): Promise<void> {}
      async deletePostgres(): Promise<void> {}
  async deleteMongodb(): Promise<void> {}
      async seedTenantCrypto(): Promise<VaultSeedOutcome> { return { created: true }; }
      async deleteTenantCrypto(): Promise<void> {}
    }
    const seeder = new RecordingSeeder();
    const activator = new FakeActivator(); // 201 { activate_url: https://example-auth.s1.example/activate?token=inv_test }
    const manifest: ConsumerManifest = {
      apiVersion: "hostyour.cloud/v1", kind: "ConsumerManifest", mongodb: "shared" as const, name: "acme", owner: "team-acme",
      envs: ["prod"], chart: { path: "deploy/chart" }, services: [], databases: [], builds: [{ name: "acme-api", containerfile: "Containerfile" }],
      secrets: [{ key: "AUTH_BOOTSTRAP_TOKEN", required: true, generate: "hex32" }],
      activation: { path: "/api/v1/bootstrap/invite-admin", method: "POST", tokenSecret: "AUTH_BOOTSTRAP_TOKEN", tokenHeader: "X-Bootstrap-Token", prompt: [{ field: "email", label: "First administrator email" }] },
    };
    const ports = fakePorts({ seeder, activator, runner: new FakeGateRunner({ report: { ...report(g1Pass, "pass"), manifest } }) });
    const { executor, store, bus } = makeExecutor(ports);
    const credId = await sealPat(store);

    const { runId } = await executor.planStreamed("onboard", { ...REQUEST, repoCredentialId: credId });
    await executor.settle(runId);
    const planned = getRun(db.db, runId);
    expect(planned?.status).toBe("planned");
    expect(planned?.steps.map((s) => s.name).at(-1)).toBe("activate"); // the extra final step is planned
    expect(planned?.requiredInputs).toEqual([{ field: "email", label: "First administrator email" }]);

    // Watch the live SSE bus — the ONLY surface the activate_url may ever appear on.
    const live: string[] = [];
    const unsubscribe = bus.subscribe(runId, (e) => live.push(e.text));

    // Approve with the operator's NON-secret email (rides the run-secret channel, never sealed).
    await executor.approve(runId, { "activation-input:email": Buffer.from("admin@acme.test", "utf8") });
    await executor.settle(runId);
    unsubscribe();
    expect(getRun(db.db, runId)?.status).toBe("succeeded");

    // The endpoint was called on the consumer's own ingress with the seed-minted token + the email.
    expect(activator.calls).toHaveLength(1);
    const call = activator.calls[0]!;
    const mintedToken = seeder.seeded[0]!.data["AUTH_BOOTSTRAP_TOKEN"]!;
    // The unit's ONE host, <name>.<unitApex> — the same composition the admission policy pins.
    expect(call.url).toBe("https://acme.example.com/api/v1/bootstrap/invite-admin");
    expect(call.token).toBe(mintedToken);
    expect(call.body).toEqual({ email: "admin@acme.test" });

    // The activate_url reached the live watcher in EXACTLY one marked line.
    const liveUrlLines = live.filter((t) => t.includes(ACTIVATION_RESULT_MARKER));
    expect(liveUrlLines).toHaveLength(1);
    expect(liveUrlLines[0]!).toContain("https://example-auth.s1.example/activate?token=inv_test");

    // And it was NEVER persisted: the append-only events table holds neither the marked line, nor
    // the url, nor the token — a later reader of the run log (or the DB file) cannot recover it.
    const events = readEvents(db.db, runId);
    for (const e of events) {
      expect(e.text).not.toContain(ACTIVATION_RESULT_MARKER);
      expect(e.text).not.toContain("activate?token=inv_test");
      expect(e.text).not.toContain(mintedToken);
    }
    // The persisted log still records the credential-free outcome, so a later reader sees the invite happened.
    expect(events.some((e) => e.text.includes("✓ activation succeeded"))).toBe(true);

    // Never in the GitOps registration (the persisted deployment record): neither the token nor the url.
    const reg = await ports.registry.readRegistration("prod", "acme");
    const regJson = JSON.stringify(reg);
    expect(regJson).not.toContain(mintedToken);
    expect(regJson).not.toContain("activate?token=inv_test");
  });
});
