import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { seedUnitSizes } from "#unit/server/unit-size.ts";
import { seedQuota } from "#unit/shared/unit-size.ts";
import { serializePointer } from "#unit/server/registration-laws.ts";
import { Registrations } from "#unit/server/registrations.ts";
import { openDb, type DbHandle } from "../../db/client.ts";
import { servers, clusters } from "../../db/schema/inventory.ts";
import { makeOnboardDef, type OnboardPorts } from "./onboard.run.ts";
import { CHANNEL_STAGES, emptyZone } from "./onboard.fixture.ts";
import { FakeRepoReader, FakePlatformRepo } from "../../adapters/git/testing/fake.ts";
import { FakeGateRunner } from "../../adapters/gate-runner/testing/fake.ts";
import { FakeMasterArgoReader, FakeClusterReader, FakeMasterProjectWriter, FakeClusterKubeResolver } from "../../adapters/kube/testing/fake.ts";
import type { VaultSeeder } from "#unit/server/adapters/vault/seeder-port.ts";
import type { GateReport } from "../../../shared/gates.ts";
import { ConsumerRegistrationSchema, type ConsumerManifest } from "../../../shared/consumer.ts";
import { clusterMapPath } from "../../../shared/cluster-values.ts";
import { FakeGitHubApp } from "../../adapters/github-app/testing/fake.ts";

// The onboarding plan refuses a registration that would share a database on the cluster's shared
// MongoDB with a registration already standing there: one stage would read, and act on, the other's
// data. The planted case is two consumers whose served names meet; the innocent one is a consumer's
// TEST beside its own PROD, whose served names differ by the stage.

const SHA = "a".repeat(40);
const MANIFEST: ConsumerManifest = {
  apiVersion: "hostyour.cloud/v1", kind: "ConsumerManifest", mongodb: "shared", redis: "shared",
  name: "acme", owner: "team-acme", envs: ["test", "prod"],
  chart: { path: "deploy/chart" }, services: ["mongodb"], databases: ["acme"], keyPatterns: [], channelPatterns: [], secrets: [],
  builds: [{ name: "acme-api", containerfile: "Containerfile" }],
};
const CHART_PINS = 'builds:\n  - name: acme-api\n    image: acme-api\n    tag: "0.0.0"\n';

let db: DbHandle;
beforeEach(() => { db = openDb(":memory:"); seedUnitSizes(db.db); });
afterEach(() => { db.sqlite.close(); });

const report: GateReport = {
  contractVersion: "1.5", runnerVersion: "t", repoURL: "https://github.com/x/acme.git", requestedRef: "HEAD", resolvedSha: SHA, startedAt: 1, finishedAt: 2,
  manifest: MANIFEST, dependencies: [],
  gates: [{ id: "G1", title: "manifest present", severity: "hard", status: "pass", expected: "x", found: "y", reason: null, detail: "ok" }],
  sandbox: { mustFailTargets: [], mustFailTargetsDeclaredListening: true, mustFailDenied: true, managerAddrDenied: true, mustPassReached: true },
  verdict: "pass", reportHash: "h",
};

/** A books branch with the platform values and one standing registration on cluster s1. */
function books(standing: { name: string; stage: "test" | "prod"; databases: string[] }): FakePlatformRepo {
  const repo = new FakePlatformRepo();
  repo.seed("s1.example", "clusters/platform/values-common.yaml", "global:\n  timezone: Europe/Amsterdam\n");
  for (const stage of ["dev", "test", "prod"]) repo.seed("s1.example", `clusters/platform/values-${stage}.yaml`, `global:\n  env: ${stage}\n`);
  repo.seed("s1.example", clusterMapPath("s1.example"), "global:\n  unitApex: example.com\n");
  repo.seed(repo.booksBranch, `registrations/${standing.name}/${standing.stage}.yaml`, serializePointer(ConsumerRegistrationSchema, {
    name: standing.name, repoURL: `https://github.com/x/${standing.name}.git`, suspended: false, quiesced: false, removing: false,
    chartPath: "deploy/chart", host: standing.name, cluster: "s1", databases: standing.databases, keyPatterns: [], channelPatterns: [],
    services: ["mongodb"], size: "small", mongodb: "shared", quota: seedQuota("small"),
  }));
  return repo;
}

function ports(repo: FakePlatformRepo): OnboardPorts {
  return {
    repo: new FakeRepoReader({ resolvedSha: SHA, files: { "deploy/chart/values-test.yaml": CHART_PINS, "deploy/chart/values-prod.yaml": CHART_PINS } }),
    runner: new FakeGateRunner({ report }),
    registrations: new Registrations(repo),
    channelStages: async () => CHANNEL_STAGES,
    seeder: {} as unknown as VaultSeeder,
    githubApp: new FakeGitHubApp(),
    resolver: new FakeClusterKubeResolver({ clusterReader: new FakeClusterReader(), argoReader: new FakeMasterArgoReader(), projectWriter: new FakeMasterProjectWriter(), argoNamespace: "argocd" }),
    tenantSubdomains: async () => [],
    dns: emptyZone(),
    declareListening: true,
    argoWatchTimeoutMs: 1000,
    deployRefVisibleMs: 200,
    releaseBuildAppearMs: 200,
    resolveBuildPlaneFqdn: async () => "s1.example",
  };
}

function seedCluster(): void {
  db.db.insert(servers).values({ id: "srv_1", name: "m1", host: "1.2.3.4", sshUser: "root", role: "master", status: "healthy" }).run();
  db.db.insert(clusters).values({ id: "cls_1", serverId: "srv_1", stage: "prod", domain: "s1.example", name: "s1", status: "active" }).run();
}

const plan = (repo: FakePlatformRepo, stage: "test" | "prod") => makeOnboardDef(ports(repo)).planStream!({
  consumerName: "acme", repoURL: "https://github.com/x/acme.git", version: "1.0.0", channel: "stable", stage, clusterId: "cls_1",
  owner: "team-acme", chartPath: "deploy/chart", repoCredentialId: "cred_pat", size: "small",
}, { db: db.db, log: () => undefined, signal: new AbortController().signal });

describe("the onboarding plan and the cluster's shared MongoDB", () => {
  it("PLANTED: refuses a TEST stage whose served database another consumer on the cluster is served", async () => {
    seedCluster();
    const res = await plan(books({ name: "shop", stage: "prod", databases: ["acme_test"] }), "test");
    expect(res.outcome).toBe("rejected");
    if (res.outcome === "rejected") expect(res.summary).toMatch(/acme at test would be served the database acme_test on s1's shared MongoDB, which shop at prod is served already/);
  });

  it("admits a consumer's TEST beside its own PROD on one cluster", async () => {
    seedCluster();
    expect((await plan(books({ name: "acme", stage: "prod", databases: ["acme"] }), "test")).outcome).toBe("planned");
  });
});
