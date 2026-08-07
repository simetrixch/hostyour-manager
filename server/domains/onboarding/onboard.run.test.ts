import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { seedUnitSizes } from "./unit-size.ts";
import { createPublicKey } from "node:crypto";
import { eq } from "drizzle-orm";
import { openDb, type DbHandle } from "../../db/client.ts";
import { servers, clusters, apps } from "../../db/schema/inventory.ts";
import { makeOnboardDef, OnboardParams, DeployableOnboardParams, type OnboardPorts } from "./onboard.run.ts";
import { Registry, type ClusterStageResolver } from "./registry.ts";
import { seedClusterMaps } from "./cluster-map.fixture.ts";
import { FakeRepoReader, FakePlatformRepo, FakeConsumerRepo } from "../../adapters/git/testing/fake.ts";
import { FakeGateRunner } from "../../adapters/gate-runner/testing/fake.ts";
import { FakeMasterArgoReader, FakeClusterReader, FakeMasterProjectWriter, FakeClusterKubeResolver, FakeBuildRbacWriter, FakeRepoCredentialWriter } from "../../adapters/kube/testing/fake.ts";
import type { RoleManifest } from "../../adapters/kube/port.ts";
import { FakeGitHubConsumer } from "../../adapters/github-consumer/testing/fake.ts";
import { FakeBuildPlane } from "../../adapters/build-plane/testing/fake.ts";
import { FakeDnsProvider } from "../../adapters/dns/testing/fake.ts";
import type { StepCtx } from "../../executor/types.ts";
import type { CredentialStore } from "../../security/store.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { GateReport } from "../../../shared/gates.ts";
import type { ConsumerManifest } from "../../../shared/consumer.ts";
import type { VaultSeeder, VaultSeedInput, VaultSeedOutcome, BuildRepoPatSeedInput, BuildRepoPatDeleteInput, AppSecretsDeleteInput } from "./vault-seeder.ts";

const SHA = "a".repeat(40);
/** The tag the release cycle minted for the fixture release {version 1.0.0, channel stable} — what
 *  the bump wrote into the delivery branch's values file and the build run's release-tag param. */
const MINTED_TAG = "1.0.0-stable-20260719120000";

/** The manifest every DEPLOYABLE fixture onboards: a chart + one declared build. */
const MANIFEST: ConsumerManifest = {
  apiVersion: "hostyour.cloud/v1", kind: "ConsumerManifest", mongodb: "shared" as const,
  name: "acme", owner: "team-acme", envs: ["prod"],
  chart: { path: "deploy/chart" }, services: [], databases: [], secrets: [],
  builds: [{ name: "acme-api", containerfile: "Containerfile" }],
};
/** The BUILD-ONLY twin: no chart — the deploy is central, only the build belongs to the unit. */
const BUILD_ONLY_MANIFEST: ConsumerManifest = { ...MANIFEST, chart: undefined } as ConsumerManifest;
/** The chart's per-stage pins: the builds[] entry whose `image` is the build name (G18's chart half)
 *  — and, on the delivery branch, the file the bump wrote the minted tag into (watch-deployment). */
const CHART_PINS = `builds:\n  - name: acme-api\n    image: acme-api\n    tag: "${MINTED_TAG}-abc1234"\n`;

let db: DbHandle;
// The size table is seeded at BOOT (boot/wire.ts), not by the migration, so an in-memory database
// starts without it — and write-registration resolves the unit's ceiling against it. Seeding here is
// what a running Controller has done long before an onboard reaches it; without it the run fails at
// exactly that step, which is the correct behaviour and not what these tests are about.
beforeEach(() => { db = openDb(":memory:"); seedUnitSizes(db.db); });
afterEach(() => { db.sqlite.close(); });

function passReport(manifest: ConsumerManifest = MANIFEST): GateReport {
  return {
    contractVersion: "1.3", runnerVersion: "t", repoURL: "https://github.com/x/acme.git",
    requestedRef: "HEAD", resolvedSha: SHA, startedAt: 1, finishedAt: 2, manifest,
    dependencies: [],
    gates: [{ id: "G1", title: "manifest present", severity: "hard", status: "pass", expected: "x", found: "y", reason: null, detail: "ok" }],
    sandbox: { mustFailTargets: [], mustFailTargetsConfirmedListening: true, mustFailDenied: true, controllerAddrDenied: true, mustPassReached: true },
    verdict: "pass", reportHash: "h",
  };
}

// The ceremony-secret seed must NOT fire in the zero-secret path; the build repo-pat seed fires on
// EVERY onboard (one PAT per unit), so it is a recording attest-or-create here.
class FakeSeeder implements VaultSeeder {
  seeded: VaultSeedInput[] = [];
  buildRepoPats: BuildRepoPatSeedInput[] = [];
  deletedBuildRepoPats: BuildRepoPatDeleteInput[] = [];
  deletedApp: AppSecretsDeleteInput[] = [];
  /** Overridable so a test can drive the create-only re-run / attest paths. */
  created = true;
  async seed(i: VaultSeedInput): Promise<VaultSeedOutcome> { this.seeded.push(i); return { created: this.created }; }
  async seedPostgres(): Promise<VaultSeedOutcome> { return { created: true }; }
  async seedMongodb(): Promise<VaultSeedOutcome> { return { created: true }; }
  async seedBuildRepoPat(i: BuildRepoPatSeedInput): Promise<VaultSeedOutcome> { this.buildRepoPats.push(i); return { created: this.created }; }
  async deleteBuildRepoPat(i: BuildRepoPatDeleteInput): Promise<void> { this.deletedBuildRepoPats.push(i); }
  async deleteApp(i: AppSecretsDeleteInput): Promise<void> { this.deletedApp.push(i); }
  async deletePostgres(): Promise<void> {}
  async deleteMongodb(): Promise<void> {}
  async seedTenantCrypto(): Promise<VaultSeedOutcome> { return { created: true }; }
  async deleteTenantCrypto(): Promise<void> {}
}

// Every fixture onboards to the prod stage, so a fixed resolver answers every cluster with "prod" —
// the stage boundary Registry.commitRegistration checks before it ever writes a stage file.
const prodClusterStage: ClusterStageResolver = async (cluster) => ({ name: cluster, stage: "prod" });

/** A FakePlatformRepo whose cluster values chain carries `global.unitApex` for each domain — onboard's
 *  planStream resolves unitApex from exactly this chain (admission-policy.ts unitApexFromChain). */
function platformRepo(...domains: string[]): FakePlatformRepo {
  const repo = new FakePlatformRepo();
  for (const domain of domains) {
    repo.seed(domain, "platform/values-common.yaml", "global:\n  timezone: Europe/Amsterdam\n");
    for (const stage of ["dev", "test", "prod"]) repo.seed(domain, `platform/values-${stage}.yaml`, `global:\n  env: ${stage}\n`);
    repo.seed(domain, "cluster/profile.yaml", `global:\n  vaultUrl: https://vault.${domain}:8200\n  unitApex: example.com\n`);
  }
  return repo;
}

type FakeKube = { argo?: FakeMasterArgoReader; cluster?: FakeClusterReader; projects?: FakeMasterProjectWriter };

/** The full port set with every release-cycle fake wired green: the dispatched workflow run
 *  completes with success, the build plane carries the unit's Succeeded release run, and the DNS
 *  fake knows the target cluster's own A record. */
function ports(over: Partial<OnboardPorts> & FakeKube = {}): OnboardPorts {
  const { argo, cluster, projects, ...portOver } = over;
  const buildPlane = new FakeBuildPlane();
  buildPlane.seedReleaseRun("acme", { runName: "acme-release-1", releaseTag: MINTED_TAG, succeeded: true });
  const dns = new FakeDnsProvider();
  dns.seed("s1.example", "A", "203.0.113.10");
  // ONE repo behind both the registry and the build-plane read: the registrations and the cluster maps
  // live in the same platform repo, exactly as they do in the wiring. The deployable form targets
  // s1 and the build-only form the master m1, so both carry a map.
  const platform = platformRepo("s1.example", "m1.example");
  return {
    repo: new FakeRepoReader({ resolvedSha: SHA, files: { "deploy/chart/values-prod.yaml": CHART_PINS } }),
    runner: new FakeGateRunner({ report: passReport() }),
    registry: new Registry(platform, prodClusterStage),
    resolveBuildPlaneFqdn: seedClusterMaps(platform, { "s1.example": "prod", "m1.example": "prod" }),
    seeder: new FakeSeeder(),
    resolver: new FakeClusterKubeResolver({
      clusterReader: cluster ?? new FakeClusterReader({
        deployState: { domain: "s1.example", stage: "prod", writtenAt: "2026-01-01T00:00:00Z", generation: 3 },
        smoke: { namespaceExists: true, workloads: [{ kind: "Deployment", name: "acme-web", available: true, desired: 1, ready: 1 }], externalSecretsReady: true },
      }),
      argoReader: argo ?? new FakeMasterArgoReader({ status: { syncRevision: SHA, targetRevision: null, sync: "Synced", health: "Healthy" } }),
      projectWriter: projects ?? new FakeMasterProjectWriter(),
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
    webhookSecret: "hmac_test",
    webhookSubdomain: "build",
    consumerRepo: new FakeConsumerRepo(),
    buildRbac: new FakeBuildRbacWriter(),
    repoCredential: new FakeRepoCredentialWriter(),
    buildPlane,
    dns,
    ...portOver,
  };
}

const BASE = {
  consumerName: "acme", repoURL: "https://github.com/x/acme.git", owner: "team-acme",
  repoCredentialId: "cred_pat", version: "1.0.0", channel: "stable", resolvedSha: SHA,
  builds: ["acme-api"],
};

function params(over: Partial<DeployableOnboardParams> = {}): OnboardParams {
  return OnboardParams.parse({
    ...BASE, form: "deployable", stage: "prod", domain: "s1.example",
    clusterId: "cls_1", cluster: "s1", namespace: "acme", unitApex: "example.com",
    chartPath: "deploy/chart", argoAppName: "acme-prod", report: passReport(),
    ...over,
  });
}

function buildOnlyParams(): OnboardParams {
  return OnboardParams.parse({
    ...BASE, form: "build-only", stage: "dev", domain: "m1.example", report: passReport(BUILD_ONLY_MANIFEST),
  });
}

function fakeCreds(openedIds: string[] = []): CredentialStore {
  return {
    open: (id: string) => { openedIds.push(id); return Promise.resolve(Buffer.from("github_pat_test", "utf8")); },
  } as unknown as CredentialStore;
}

function ctx(p: OnboardParams, stepName: string, logs: string[], creds: CredentialStore = fakeCreds(), runSecrets: Record<string, string> = {}): StepCtx {
  return {
    runId: "run_onb", stepName, db: db.db, creds, params: p,
    secrets: {
      get: (name: string) => {
        const v = runSecrets[name];
        return v === undefined ? undefined : Buffer.from(v, "utf8");
      },
      wipe: () => undefined,
    }, signal: new AbortController().signal,
    logger: {} as unknown as Logger,
    ssh: () => Promise.reject(new Error("no ssh")), openPasswordSession: () => Promise.reject(new Error("no ssh")),
    closePasswordSession: () => undefined, attest: () => Promise.reject(new Error("no attest")),
    log: (_s, t) => logs.push(t), checkpoint: () => undefined, readCheckpoint: () => undefined, registerCleanup: () => undefined,
  };
}

function seedClusters(): void {
  db.db.insert(servers).values({ id: "srv_1", name: "m1", host: "1.2.3.4", sshUser: "root", role: "master", status: "healthy" }).run();
  db.db.insert(clusters).values({ id: "cls_1", serverId: "srv_1", stage: "prod", domain: "s1.example", status: "active" }).run();
}

async function runAll(p: OnboardParams, prt: OnboardPorts, logs: string[]): Promise<void> {
  for (const step of makeOnboardDef(prt).steps(p)) await step.run(ctx(p, step.name, logs));
}

describe("onboard run definition", () => {
  it("builds the deployable chain from steps({}), attest-target first and refuses the synchronous plan() path", () => {
    const def = makeOnboardDef(ports());
    expect(def.mutating).toBe(true);
    expect(def.steps({} as OnboardParams).map((s) => s.name)).toEqual([
      "attest-target", "preflight-scopes", "check", "record-provisional", "write-registration", "seed-secrets", "seed-postgres-superuser", "seed-mongodb-instance", "seed-repo-pat",
      "provision-repo-credential", "apply-appproject", "apply-admission-policy", "provision-build-rbac", "provision-dns",
      "inject-release-kit", "setup-webhook", "trigger-release", "watch-release-workflow", "watch-release-build", "watch-deployment",
      "smoke", "record-inventory",
    ]);
    expect(() => def.plan({} as OnboardParams, { db: db.db })).toThrow(/planStream/);
  });

  it("the build-only form is a SUBSET of the same chain — no attest, no provisioning of a target, no deployment watch", () => {
    expect(makeOnboardDef(ports()).steps(buildOnlyParams()).map((s) => s.name)).toEqual([
      "preflight-scopes", "check", "write-registration", "seed-repo-pat", "provision-build-rbac",
      "inject-release-kit", "setup-webhook", "trigger-release", "watch-release-build", "record",
    ]);
  });

  it("walking skeleton: a zero-secret consumer onboards green — the release cycle is triggered once and its results read back", async () => {
    seedClusters();
    const prt = ports();
    const logs: string[] = [];
    await runAll(params(), prt, logs);

    // write-registration committed build.yaml + registrations/acme/prod.yaml
    const reg = await prt.registry.readRegistration("prod", "acme");
    expect(reg?.entry.cluster).toBe("s1");
    expect((await prt.registry.listAttestedBuildNames("someone-else"))).toEqual([{ unit: "acme", build: "acme-api" }]);

    // the trigger dispatched the injected workflow EXACTLY once with {version, channel, stage}
    const github = prt.github as FakeGitHubConsumer;
    expect(github.dispatches).toHaveLength(1);
    expect(github.dispatches[0]).toMatchObject({ workflowFile: "release.yml", inputs: { version: "1.0.0", channel: "stable", stage: "prod" } });

    // provision-dns created the unit's ONE record, pointing at the target cluster's own address
    const dns = prt.dns as FakeDnsProvider;
    expect(dns.record("acme.example.com", "A")).toBe("203.0.113.10");

    // provision-repo-credential put the ArgoCD repository Secret beside the Applications
    const cred = (prt.repoCredential as FakeRepoCredentialWriter).get("argocd", "repo-acme");
    expect(cred?.stringData.url).toBe("https://github.com/x/acme.git");
    expect(cred?.stringData.username).toBe("hostyour-cloud");

    // seed-repo-pat wrote the stage-free build credential (local Vault)
    expect((prt.seeder as FakeSeeder).buildRepoPats).toEqual([{ consumerName: "acme", pat: "github_pat_test" }]);

    // record-inventory wrote the apps row — provenance "controller", the SAME word create-tenant writes
    // for a tenant (create-tenant.run.test.ts asserts it on the other side), so one query answers about
    // both unit kinds. It records no revision, and the table has no column for one: the pin is the
    // delivery branch's.
    const row = db.db.select().from(apps).where(eq(apps.name, "acme")).get();
    expect(row?.provenance).toBe("controller");
    expect(row).not.toHaveProperty("version");

    // the watches read the cycle's own results — the minted tag is read, never computed
    expect(logs.some((l) => l.includes("release run \"Release 1.0.0-stable\" completed with conclusion success"))).toBe(true);
    expect(logs.some((l) => l.includes(`the bump wrote ${MINTED_TAG}-abc1234`))).toBe(true);
  });

  it("walking skeleton (build-only): the seven-platform-unit form attests the registration and proves the cycle without an Application", async () => {
    seedClusters();
    const prt = ports();
    const seeder = prt.seeder as FakeSeeder;
    seeder.created = false; // the ATTEST case: the hand-seeded build repo-pat already stands
    const logs: string[] = [];
    await runAll(buildOnlyParams(), prt, logs);

    // build.yaml stands, NO stage file — nothing of the unit deploys
    expect(await prt.registry.readRegistration("dev", "acme")).toBeNull();
    expect(await prt.registry.listAttestedBuildNames("someone-else")).toEqual([{ unit: "acme", build: "acme-api" }]);

    // the repo-pat seed ATTESTED the existing path instead of writing again
    expect(seeder.buildRepoPats).toEqual([{ consumerName: "acme", pat: "github_pat_test" }]);
    expect(logs.some((l) => l.includes("attested and left untouched"))).toBe(true);

    // only the two build-namespace grants — a build-only unit has no Applications to argo-sync
    expect((prt.buildRbac as FakeBuildRbacWriter).keys()).toEqual([
      "Role acme-build/acme-build-controller-read",
      "Role acme-build/acme-build-eventlistener",
      "RoleBinding acme-build/acme-build-controller-read",
      "RoleBinding acme-build/acme-build-eventlistener",
    ]);

    // the release run was watched in the UNIT's own namespace and the record ties tag to builds
    expect(logs.some((l) => l.includes(`release ${MINTED_TAG} proven through the injected cycle`))).toBe(true);
  });

  // The check step's drift belt (builds/secrets/activation moved since approval) is covered in its
  // dedicated sibling, onboard-check.run.test.ts; the fqdn leg in onboard-fqdn.run.test.ts.

  it("provision-dns fails loud without a wired provider, and on a cluster with no address record of its own", async () => {
    const p = params();
    const noDns = ports();
    delete (noDns as { dns?: unknown }).dns;
    const step = (prt: OnboardPorts) => makeOnboardDef(prt).steps(p).find((s) => s.name === "provision-dns")!;
    await expect(step(noDns).run(ctx(p, "provision-dns", []))).rejects.toThrow(/requires the DNS provider/);
    const blankDns = ports({ dns: new FakeDnsProvider() });
    await expect(step(blankDns).run(ctx(p, "provision-dns", []))).rejects.toThrow(/has no A record of its own/);
  });

  it("apply-appproject writes the consumer's isolation AppProject into argocd", async () => {
    seedClusters();
    const projects = new FakeMasterProjectWriter();
    await runAll(params(), ports({ projects }), []);
    const project = projects.get("argocd", "acme");
    expect(project?.metadata.namespace).toBe("argocd");
    expect(project?.spec.destinations).toEqual([{ server: "*", namespace: "acme" }]);
  });

  it("provision-build-rbac writes the six grant objects for a deployable unit", async () => {
    seedClusters();
    const buildRbac = new FakeBuildRbacWriter();
    await runAll(params(), ports({ buildRbac }), []);
    expect(buildRbac.keys()).toEqual([
      "Role acme-build/acme-build-controller-read",
      "Role acme-build/acme-build-eventlistener",
      "Role argocd/acme-argo-sync",
      "RoleBinding acme-build/acme-build-controller-read",
      "RoleBinding acme-build/acme-build-eventlistener",
      "RoleBinding argocd/acme-argo-sync",
    ]);
    const sync = buildRbac.get("Role", "argocd", "acme-argo-sync") as RoleManifest;
    expect(sync.rules[0]!.resourceNames).toEqual(["acme-dev", "acme-test", "acme-prod"]);
  });

  it("a build-grant write that fails aborts the onboard AFTER the registration was committed — the abort cleanup removes it", async () => {
    seedClusters();
    const buildRbac = new FakeBuildRbacWriter();
    buildRbac.failApply(new Error("forbidden: cannot create Role"));
    const prt = ports({ buildRbac });
    await expect(runAll(params(), prt, [])).rejects.toThrow(/cannot create Role/);
    // the registration comes FIRST; the abort's registered cleanup is what takes it back.
    expect(await prt.registry.readRegistration("prod", "acme")).not.toBeNull();
    const cleanup = makeOnboardDef(prt).cleanups!(params()).find((c) => c.name === "remove-consumer-registration")!;
    await cleanup.run(ctx(params(), "remove-consumer-registration", []));
    expect(await prt.registry.readRegistration("prod", "acme")).toBeNull();
  });

  it("seed-repo-pat opens the sealed PAT, never logs it, and fails the run when the local write fails", async () => {
    const seeder = new FakeSeeder();
    const prt = ports({ seeder });
    const p = params();
    const opened: string[] = [];
    const step = makeOnboardDef(prt).steps(p).find((s) => s.name === "seed-repo-pat")!;
    const logs: string[] = [];
    await step.run(ctx(p, "seed-repo-pat", logs, fakeCreds(opened)));
    expect(opened).toEqual(["cred_pat"]);
    expect(logs.some((l) => l.includes("secret/build/acme/repo-pat"))).toBe(true);
    expect(logs.every((l) => !l.includes("github_pat_test"))).toBe(true);
    seeder.seedBuildRepoPat = async () => { throw new Error("vault build repo-pat put failed for secret/build/acme/repo-pat (403)"); };
    await expect(step.run(ctx(p, "seed-repo-pat", []))).rejects.toThrow(/repo-pat put failed/);
  });

  it("routes a slave-targeted onboard to the RESOLVED slave clients + per-slave ArgoCD namespace", async () => {
    const slaveArgo = new FakeMasterArgoReader({ status: { syncRevision: SHA, targetRevision: null, sync: "Synced", health: "Healthy" } });
    const slaveCluster = new FakeClusterReader({
      deployState: { domain: "s2.example", stage: "prod", writtenAt: "x", generation: 5 },
      smoke: { namespaceExists: true, workloads: [{ kind: "Deployment", name: "acme-web", available: true, desired: 1, ready: 1 }], externalSecretsReady: true },
    });
    const slaveProjects = new FakeMasterProjectWriter();
    const resolver = new FakeClusterKubeResolver({
      clusterReader: new FakeClusterReader(), argoReader: new FakeMasterArgoReader(), projectWriter: new FakeMasterProjectWriter(), argoNamespace: "argocd",
    });
    resolver.set("cls_s2", { clusterReader: slaveCluster, argoReader: slaveArgo, projectWriter: slaveProjects, argoNamespace: "s2" });

    const prt = ports({ resolver });
    const p = params({ clusterId: "cls_s2", domain: "s2.example" });
    (prt.dns as FakeDnsProvider).seed("s2.example", "A", "203.0.113.20");
    const steps = makeOnboardDef(prt).steps(p);
    const byName = (n: string) => steps.find((s) => s.name === n)!;
    await byName("attest-target").run(ctx(p, "attest-target", []));
    await byName("apply-appproject").run(ctx(p, "apply-appproject", []));
    await byName("watch-deployment").run(ctx(p, "watch-deployment", []));
    await byName("smoke").run(ctx(p, "smoke", []));
    expect(slaveProjects.get("s2", "acme")?.metadata.name).toBe("acme");
    expect(resolver.resolved.every((c) => c === "cls_s2")).toBe(true);
  });

  it("seed-secrets MINTS generate keys and takes required non-generate keys from the operator", async () => {
    const seeder = new FakeSeeder();
    const p = params({
      secretSpecs: [
        { key: "SESSION_SECRET", required: true, generate: "hex32" },
        { key: "SMTP_PASSWORD", required: true },
      ],
    });
    const step = makeOnboardDef(ports({ seeder })).steps(p).find((s) => s.name === "seed-secrets")!;
    const logs: string[] = [];
    await step.run(ctx(p, "seed-secrets", logs, fakeCreds(), { "consumer-secret:SMTP_PASSWORD": "operator-supplied" }));
    const seeded = seeder.seeded[0]!;
    expect(seeded.data["SESSION_SECRET"]).toMatch(/^[0-9a-f]{64}$/);
    expect(seeded.data["SMTP_PASSWORD"]).toBe("operator-supplied");
    for (const l of logs) {
      expect(l).not.toContain(seeded.data["SESSION_SECRET"]!);
      expect(l).not.toContain("operator-supplied");
    }
  });

  it("seed-secrets MINTS a matched RSA-2048 keypair and fails closed on a dangling pairWith", async () => {
    const seeder = new FakeSeeder();
    const p = params({
      secretSpecs: [
        { key: "AUTH_JWT_PRIVATE_KEY", required: true, generate: "rsa2048" },
        { key: "AUTH_JWT_PUBLIC_KEY", required: true, generate: "rsa2048-public", pairWith: "AUTH_JWT_PRIVATE_KEY" },
      ],
    });
    const step = makeOnboardDef(ports({ seeder })).steps(p).find((s) => s.name === "seed-secrets")!;
    await step.run(ctx(p, "seed-secrets", []));
    const seeded = seeder.seeded[0]!;
    expect(createPublicKey(seeded.data["AUTH_JWT_PRIVATE_KEY"]!).export({ type: "spki", format: "pem" }).toString()).toBe(seeded.data["AUTH_JWT_PUBLIC_KEY"]);

    const dangling = params({ secretSpecs: [{ key: "K", required: true, generate: "rsa2048-public", pairWith: "NOPE" }] });
    const step2 = makeOnboardDef(ports({ seeder: new FakeSeeder() })).steps(dangling).find((s) => s.name === "seed-secrets")!;
    await expect(step2.run(ctx(dangling, "seed-secrets", []))).rejects.toThrow(/pairWith/);
  });

  it("seed-secrets is a NO-OP on a re-run (create-only) and fails closed on a missing required operator secret", async () => {
    const seeder = new FakeSeeder();
    seeder.created = false; // Vault: the entry already exists (cas=0 refused the write)
    const p = params({ secretSpecs: [{ key: "AUTH_JWT_PRIVATE_KEY", required: true, generate: "rsa2048" }] });
    const step = makeOnboardDef(ports({ seeder })).steps(p).find((s) => s.name === "seed-secrets")!;
    const logs: string[] = [];
    await step.run(ctx(p, "seed-secrets", logs));
    expect(logs.some((l) => l.includes("already present") && l.includes("left untouched"))).toBe(true);
    for (const l of logs) expect(l).not.toContain("-----BEGIN PRIVATE KEY-----");

    const missing = params({ secretSpecs: [{ key: "SMTP_PASSWORD", required: true }] });
    const step2 = makeOnboardDef(ports({ seeder: new FakeSeeder() })).steps(missing).find((s) => s.name === "seed-secrets")!;
    await expect(step2.run(ctx(missing, "seed-secrets", []))).rejects.toThrow(/consumer-secret:SMTP_PASSWORD/);
  });

  it("planStream freezes the release + the manifest facts into params and demands only required non-generate keys", async () => {
    seedClusters();
    const manifest: ConsumerManifest = { ...MANIFEST, secrets: [
      { key: "SESSION_SECRET", required: true, generate: "hex32" },
      { key: "SMTP_PASSWORD", required: true },
    ] };
    const prt = ports({ runner: new FakeGateRunner({ report: passReport(manifest) }) });
    const res = await makeOnboardDef(prt).planStream!(
      { consumerName: "acme", repoURL: "https://github.com/x/acme.git", version: "1.0.0", channel: "stable", clusterId: "cls_1", owner: "team-acme", chartPath: "deploy/chart", repoCredentialId: "cred_pat" },
      { db: db.db, log: () => undefined, signal: new AbortController().signal },
    );
    expect(res.outcome).toBe("planned");
    if (res.outcome !== "planned") return;
    expect(res.params.form).toBe("deployable");
    expect(res.params).toMatchObject({ version: "1.0.0", channel: "stable", stage: "prod", builds: ["acme-api"] });
    if (res.params.form !== "deployable") return;
    expect(res.params.argoAppName).toBe("acme-prod");
    expect(res.params.unitApex).toBe("example.com");
    expect(res.plan.requiredSecrets).toEqual(["consumer-secret:SMTP_PASSWORD"]);
  });

  it("planStream rejects the form the manifest contradicts: a chartless manifest with a cluster, a charted one with a bare stage", async () => {
    seedClusters();
    const streamCtx = { db: db.db, log: () => undefined, signal: new AbortController().signal };
    const buildOnlyPrt = ports({ runner: new FakeGateRunner({ report: passReport(BUILD_ONLY_MANIFEST) }) });
    const r1 = await makeOnboardDef(buildOnlyPrt).planStream!(
      { consumerName: "acme", repoURL: "https://github.com/x/acme.git", version: "1.0.0", channel: "stable", clusterId: "cls_1", owner: "team-acme", chartPath: "deploy/chart", repoCredentialId: "cred_pat" },
      streamCtx,
    );
    expect(r1).toMatchObject({ outcome: "rejected", summary: expect.stringContaining("declares NO chart") });
    const r2 = await makeOnboardDef(ports()).planStream!(
      { consumerName: "acme", repoURL: "https://github.com/x/acme.git", version: "1.0.0", channel: "stable", stage: "dev", owner: "team-acme", chartPath: "deploy/chart", repoCredentialId: "cred_pat" },
      streamCtx,
    );
    expect(r2).toMatchObject({ outcome: "rejected", summary: expect.stringContaining("declares a chart") });
  });

  it("planStream (build-only) targets the master cluster and plans the subset chain", async () => {
    seedClusters(); // cls_1 sits on the master server — the only cluster a build-only run is about
    const prt = ports({ runner: new FakeGateRunner({ report: passReport(BUILD_ONLY_MANIFEST) }) });
    const res = await makeOnboardDef(prt).planStream!(
      { consumerName: "acme", repoURL: "https://github.com/x/acme.git", version: "1.0.0", channel: "stable", stage: "dev", owner: "team-acme", chartPath: "deploy/chart", repoCredentialId: "cred_pat" },
      { db: db.db, log: () => undefined, signal: new AbortController().signal },
    );
    expect(res.outcome).toBe("planned");
    if (res.outcome !== "planned") return;
    expect(res.params.form).toBe("build-only");
    // The master row's domain. Nothing deploys, so this is the only cluster the run is about; the
    // webhook host is whatever THIS cluster's map names in build-plane, resolved at the step.
    expect(res.params.domain).toBe("s1.example");
    expect(res.plan.targetId).toBe("cls_1");
    expect(res.plan.steps.map((s) => s.name)).not.toContain("watch-deployment");
  });
});
