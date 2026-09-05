// The shared onboard fixture: the manifests every onboard test is written against, the fake port
// set with every release-cycle fake wired green, and the platform repo behind both. It lives beside
// the tests rather than inside one of them because three test files drive the same run kind, and a
// second copy of a fixture is a second idea of what a consumer looks like.
import { type OnboardPorts } from "./onboard.run.ts";
import { Registrations, type ClusterStageResolver } from "./registrations.ts";
import { seedClusterMaps } from "./cluster-map.fixture.ts";
import { FakeRepoReader, FakePlatformRepo, FakeConsumerRepo } from "../../adapters/git/testing/fake.ts";
import { FakeGateRunner } from "../../adapters/gate-runner/testing/fake.ts";
import { FakeMasterArgoReader, FakeClusterReader, FakeMasterProjectWriter, FakeClusterKubeResolver, FakeBuildRbacWriter, FakeRepoCredentialWriter } from "../../adapters/kube/testing/fake.ts";
import { FakeGitHubConsumer } from "../../adapters/github-consumer/testing/fake.ts";
import { FakeBuildPlane } from "../../adapters/build-plane/testing/fake.ts";
import { FakeDnsProvider } from "../../adapters/dns/testing/fake.ts";
import type { GateReport } from "../../../shared/gates.ts";
import type { ConsumerManifest } from "../../../shared/consumer.ts";
import type { VaultSeeder, VaultSeedInput, VaultSeedOutcome, BuildRepoPatSeedInput, BuildRepoPatDeleteInput, AppSecretsDeleteInput } from "./vault-seeder.ts";
import { clusterMapPath } from "../../../shared/cluster-values.ts";

export const SHA = "a".repeat(40);
/** The tag the release cycle minted for the fixture release {version 1.0.0, channel stable} — what
 *  the bump wrote into the delivery branch's values file and the build run's release-tag param. */
export const MINTED_TAG = "1.0.0-stable-20260719120000";

/** The manifest every DEPLOYABLE fixture onboards: a chart + one declared build. */
export const MANIFEST: ConsumerManifest = {
  apiVersion: "hostyour.cloud/v1", kind: "ConsumerManifest", mongodb: "shared" as const,
  name: "acme", owner: "team-acme", envs: ["prod"],
  chart: { path: "deploy/chart" }, services: [], databases: [], secrets: [],
  builds: [{ name: "acme-api", containerfile: "Containerfile" }],
};
/** The BUILD-ONLY twin: no chart — the deploy is central, only the build belongs to the unit. */
export const BUILD_ONLY_MANIFEST: ConsumerManifest = { ...MANIFEST, chart: undefined } as ConsumerManifest;
/** The chart's per-stage pins: the builds[] entry whose `image` is the build name (G18's chart half)
 *  — and, on the delivery branch, the file the bump wrote the minted tag into (watch-deployment). */
export const CHART_PINS = `builds:\n  - name: acme-api\n    image: acme-api\n    tag: "${MINTED_TAG}-abc1234"\n`;

export function passReport(manifest: ConsumerManifest = MANIFEST): GateReport {
  return {
    contractVersion: "1.5", runnerVersion: "t", repoURL: "https://github.com/x/acme.git",
    requestedRef: "HEAD", resolvedSha: SHA, startedAt: 1, finishedAt: 2, manifest,
    dependencies: [],
    gates: [{ id: "G1", title: "manifest present", severity: "hard", status: "pass", expected: "x", found: "y", reason: null, detail: "ok" }],
    sandbox: { mustFailTargets: [], mustFailTargetsDeclaredListening: true, mustFailDenied: true, managerAddrDenied: true, mustPassReached: true },
    verdict: "pass", reportHash: "h",
  };
}

// The ceremony-secret seed must NOT fire in the zero-secret path; the build repo-pat seed fires on
// EVERY onboard (one PAT per unit), so it is a recording attest-or-create here.
export class FakeSeeder implements VaultSeeder {
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
// the stage boundary Registrations.commitRegistration checks before it ever writes a stage file.
const prodClusterStage: ClusterStageResolver = async (cluster) => ({ name: cluster, stage: "prod" });

/** A FakePlatformRepo whose cluster values chain carries `global.unitApex` for each domain — onboard's
 *  planStream resolves unitApex from exactly this chain (admission-policy.ts unitApexFromChain). */
export function platformRepo(...domains: string[]): FakePlatformRepo {
  const repo = new FakePlatformRepo();
  repo.seed(repo.booksBranch, "clusters/platform/values-common.yaml", "global:\n  timezone: Europe/Amsterdam\n");
  for (const stage of ["dev", "test", "prod"]) repo.seed(repo.booksBranch, `clusters/platform/values-${stage}.yaml`, `global:\n  env: ${stage}\n`);
  // ONE BRANCH, MANY MAPS: an installation keeps every cluster map on the books branch, so the
  // platform files are seeded once and one clusters/active/<domain>.yaml per named cluster.
  for (const domain of domains) {
    repo.seed(repo.booksBranch, clusterMapPath(domain), `global:\n  unitApex: example.com\n  endpoints:\n    vault:\n      url: https://vault.${domain}:8200\n`);
  }
  return repo;
}

export type FakeKube = { argo?: FakeMasterArgoReader; cluster?: FakeClusterReader; projects?: FakeMasterProjectWriter };

/** The full port set with every release-cycle fake wired green: the dispatched workflow run
 *  completes with success, the build plane carries the unit's Succeeded release run, and the DNS
 *  fake knows the target cluster's own A record. */
export function ports(over: Partial<OnboardPorts> & FakeKube = {}): OnboardPorts {
  const { argo, cluster, projects, ...portOver } = over;
  const buildPlane = new FakeBuildPlane();
  buildPlane.seedReleaseRun("acme", { runName: "acme-release-1", releaseTag: MINTED_TAG, succeeded: true });
  const dns = new FakeDnsProvider();
  dns.seed("s1.example", "A", "203.0.113.10");
  // ONE repo behind both the registrations and the build-plane read: the registrations and the cluster maps
  // live in the same platform repo, exactly as they do in the wiring. The deployable form targets
  // s1 and the build-only form the master m1, so both carry a map.
  const platform = platformRepo("s1.example", "m1.example");
  return {
    repo: new FakeRepoReader({ resolvedSha: SHA, files: { "deploy/chart/values-prod.yaml": CHART_PINS } }),
    runner: new FakeGateRunner({ report: passReport() }),
    registrations: new Registrations(platform, prodClusterStage),
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
    tenantSubdomains: async () => [],
    declareListening: true,
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
    // The master-local reader await-build-namespace waits through. Scripted CONVERGED by default,
    // because that step's subject is the wait and not the outcome: a fixture whose build Application
    // never arrives would make every unrelated journey time out on it. A test that wants the wait to
    // fail overrides this port and scripts the set empty, which is what the live watch answers for an
    // Application its ApplicationSet has not generated yet.
    buildArgo: new FakeMasterArgoReader({
      everyName: { syncRevision: SHA, targetRevision: null, sync: "Synced", health: "Healthy" },
    }),
    repoCredential: new FakeRepoCredentialWriter(),
    buildPlane,
    dns,
    ...portOver,
  };
}

