// The shared onboard fixture: the manifests every onboard test is written against, the fake port
// set with every release-cycle fake wired green, and the platform repo behind both. It lives beside
// the tests rather than inside one of them because three test files drive the same run kind, and a
// second copy of a fixture is a second idea of what a consumer looks like.
import { type OnboardPorts } from "./onboard.run.ts";
import { Registrations } from "#unit/server/registrations.ts";
import { seedClusterMaps } from "./cluster-map.fixture.ts";
import { FakeRepoReader, FakePlatformRepo, FakeRepoWriter } from "../../adapters/git/testing/fake.ts";
import { FakeGateRunner } from "../../adapters/gate-runner/testing/fake.ts";
import { FakeMasterArgoReader, FakeClusterReader, FakeMasterProjectWriter, FakeClusterKubeResolver, FakeBuildRbacWriter, FakeRepoCredentialWriter } from "../../adapters/kube/testing/fake.ts";
import type { ExternalSecretRow } from "../../adapters/kube/port.ts";
import { BUILD_TARGET_SECRETS } from "#unit/server/app-token-refresh.ts";
import { unitBuildNamespace } from "#unit/server/build-rbac.ts";
import { FakeGitHubConsumer } from "#unit/server/adapters/github-consumer/testing/fake.ts";
import { FakeBuildPlane } from "../../adapters/build-plane/testing/fake.ts";
import { FakeDnsProvider } from "../../adapters/dns/testing/fake.ts";
import type { GateReport } from "../../../shared/gates.ts";
import type { ConsumerManifest } from "../../../shared/consumer.ts";
import type { VaultSeeder, VaultSeedInput, VaultSeedOutcome, BuildRepoPatSeedInput, BuildRepoPatDeleteInput, AppSecretsDeleteInput } from "#unit/server/adapters/vault/seeder-port.ts";
import { clusterMapPath } from "../../../shared/cluster-values.ts";
import type { ChannelStages } from "../inventory/channel-stages.ts";

export const SHA = "a".repeat(40);
/** The tag the release cycle minted for the fixture release {version 1.0.0, channel stable} — what
 *  the bump wrote into the delivery branch's values file and the build run's release-tag param. */
export const MINTED_TAG = "1.0.0-stable-20260719120000";

/** The manifest every DEPLOYABLE fixture onboards: a chart + one declared build. */
export const MANIFEST: ConsumerManifest = {
  apiVersion: "hostyour.cloud/v1", kind: "ConsumerManifest", mongodb: "shared" as const,
  name: "acme", owner: "team-acme", envs: ["prod"],
  chart: { path: "deploy/chart" }, services: [], databases: [], keyPatterns: [], channelPatterns: [], secrets: [],
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
  /** Every REWRITE of a unit's repo-pat — the refresh before a release of an App-credentialed unit. */
  refreshedRepoPats: BuildRepoPatSeedInput[] = [];
  deletedBuildRepoPats: BuildRepoPatDeleteInput[] = [];
  deletedApp: AppSecretsDeleteInput[] = [];
  /** Overridable so a test can drive the create-only re-run / attest paths. */
  created = true;
  async seed(i: VaultSeedInput): Promise<VaultSeedOutcome> { this.seeded.push(i); return { created: this.created }; }
  async seedPostgres(): Promise<VaultSeedOutcome> { return { created: true }; }
  async seedMongodb(): Promise<VaultSeedOutcome> { return { created: true }; }
  async seedBuildRepoPat(i: BuildRepoPatSeedInput): Promise<VaultSeedOutcome> { this.buildRepoPats.push(i); return { created: this.created }; }
  async refreshBuildRepoPat(i: BuildRepoPatSeedInput): Promise<void> { this.refreshedRepoPats.push(i); }
  async deleteBuildRepoPat(i: BuildRepoPatDeleteInput): Promise<void> { this.deletedBuildRepoPats.push(i); }
  /** Every merge write, in order — what a set-secrets run handed over (#245). */
  patchedApps: VaultSeedInput[] = [];
  /** Set to make the next patchApp throw, the way a missing entry or policy gap does. */
  patchAppFails: Error | null = null;
  async patchApp(i: VaultSeedInput): Promise<void> {
    if (this.patchAppFails) throw this.patchAppFails;
    this.patchedApps.push(i);
  }
  async deleteApp(i: AppSecretsDeleteInput): Promise<void> { this.deletedApp.push(i); }
  async deletePostgres(): Promise<void> {}
  async deleteMongodb(): Promise<void> {}
  async seedTenantCrypto(): Promise<VaultSeedOutcome> { return { created: true }; }
  async deleteTenantCrypto(): Promise<void> {}
}


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

/** The channel table the fixtures plan against — the shape of platform/values-common.yaml
 *  global.channelStages: alpha reaches dev alone, beta test as well, stable every stage. */
export const CHANNEL_STAGES: ChannelStages = { alpha: ["dev"], beta: ["dev", "test"], stable: ["dev", "test", "prod"] };

export type FakeKube = { argo?: FakeMasterArgoReader; cluster?: FakeClusterReader; projects?: FakeMasterProjectWriter };

/** The moment every build ExternalSecret of the fixture last materialized, before any deletion. */
export const BUILD_SECRETS_MATERIALIZED_AT = "2026-01-01T00:00:00Z";

/** The three ExternalSecret rows of a unit's build namespace as the consumer-build inventory renders
 *  them: named after the Secret each targets, Ready, materialized once at `at`. */
export function buildSecretRows(at = BUILD_SECRETS_MATERIALIZED_AT): ExternalSecretRow[] {
  return BUILD_TARGET_SECRETS.map((name) => ({ name, ready: true, reason: "SecretSynced", targetSecret: name, refreshTime: at }));
}

/** The build plane's cluster reader with ESO standing behind it: the unit's three build
 *  ExternalSecrets are materialized, and a deletion of a Secret one of them targets is answered the
 *  way `refreshPolicy: OnChange` answers it — the row is written again, and its `refreshTime` moves
 *  to a later instant. `ready` does not change across it, which is why a test cannot read the
 *  return off that bit. A test about ESO NOT coming back uses a plain FakeClusterReader instead. */
export class FakeBuildPlaneClusterReader extends FakeClusterReader {
  private materializations = 0;
  constructor(unit: string) {
    super({ externalSecretsByNamespace: { [unitBuildNamespace(unit)]: buildSecretRows() } });
  }
  override async deleteSecret(namespace: string, name: string): Promise<void> {
    await super.deleteSecret(namespace, name);
    const rows = await this.listExternalSecrets(namespace);
    if (!rows.some((r) => r.targetSecret === name)) return;
    this.materializations += 1;
    const at = new Date(Date.parse(BUILD_SECRETS_MATERIALIZED_AT) + this.materializations * 1000).toISOString();
    this.setExternalSecrets(namespace, rows.map((r) => (r.targetSecret === name ? { ...r, refreshTime: at } : r)));
  }
}

/** The zone every onboarding harness starts from since G27 reads it at the plan: nothing stands
 *  under the unit's host, and the unit's CNAME needs no address of its cluster. */
export function emptyZone(): FakeDnsProvider {
  return new FakeDnsProvider();
}

/** The full port set with every release-cycle fake wired green: the dispatched workflow run
 *  completes with success, the build plane carries the unit's Succeeded release run, and the DNS
 *  fake starts from an empty zone. */
export function ports(over: Partial<OnboardPorts> & FakeKube = {}): OnboardPorts {
  const { argo, cluster, projects, ...portOver } = over;
  const buildPlane = new FakeBuildPlane();
  buildPlane.seedReleaseRun("acme", { runName: "acme-release-1", releaseTag: MINTED_TAG, succeeded: true });
  const dns = emptyZone();
  // ONE repo behind both the registrations and the build-plane read: the registrations and the cluster maps
  // live in the same platform repo, exactly as they do in the wiring. The deployable form targets
  // s1 and the build-only form the master m1, so both carry a map.
  const platform = platformRepo("s1.example", "m1.example");
  return {
    repo: new FakeRepoReader({ resolvedSha: SHA, files: { "deploy/chart/values-prod.yaml": CHART_PINS } }),
    runner: new FakeGateRunner({ report: passReport() }),
    registrations: new Registrations(platform),
    channelStages: async () => CHANNEL_STAGES,
    resolveBuildPlaneFqdn: seedClusterMaps(platform, { "s1.example": "prod", "m1.example": "prod" }),
    seeder: new FakeSeeder(),
    resolver: new FakeClusterKubeResolver({
      clusterReader: cluster ?? new FakeClusterReader({
        deployState: { domain: "s1.example", stage: "prod", writtenAt: "2026-01-01T00:00:00Z", generation: 3 },
        smoke: { namespaceExists: true, workloads: [{ kind: "Deployment", name: "acme-web", available: true, desired: 1, ready: 1 }], externalSecretsReady: true },
      }),
      argoReader: argo ?? new FakeMasterArgoReader({ status: { syncRevision: SHA, targetRevision: null, sync: "Synced", health: "Healthy" }, everyName: { syncRevision: SHA, targetRevision: null, sync: "Synced", health: "Healthy" } }),
      projectWriter: projects ?? new FakeMasterProjectWriter(),
      argoNamespace: "argocd",
    }),
    tenantSubdomains: async () => [],
    declareListening: true,
    argoWatchTimeoutMs: 1000,
    deployRefVisibleMs: 200,
    releaseBuildAppearMs: 200,
    releasePollIntervalMs: 1,
    dispatchRetry: { budgetMs: 50, intervalMs: 1 },
    github: new FakeGitHubConsumer(),
    webhookSecret: "hmac_test",
    webhookSubdomain: "build",
    consumerRepo: new FakeRepoWriter(),
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
    // The build plane's cluster reader refresh-repo-pat deletes the build Secrets through, with ESO
    // materializing them again behind every deletion — scripted for the fixture unit, so a journey
    // through the release re-run converges; a test about the wait scripts its own.
    buildClusterReader: new FakeBuildPlaneClusterReader("acme"),
    buildSecretsMaterializeMs: 200,
    dns,
    ...portOver,
  };
}

