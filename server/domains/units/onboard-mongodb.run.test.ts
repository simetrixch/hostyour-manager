import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { seedUnitSizes } from "./unit-size.ts";
import { openDb, type DbHandle } from "../../db/client.ts";
import { servers, clusters } from "../../db/schema/inventory.ts";
import { makeOnboardDef, type OnboardPorts } from "./onboard.run.ts";
import { seedMongodbInstanceStep } from "./onboard-seed-mongodb.ts";
import { Registrations, type ClusterStageResolver } from "./registrations.ts";
import { FakeRepoReader, FakePlatformRepo } from "../../adapters/git/testing/fake.ts";
import { FakeGateRunner } from "../../adapters/gate-runner/testing/fake.ts";
import { FakeMasterArgoReader, FakeClusterReader, FakeMasterProjectWriter, FakeClusterKubeResolver } from "../../adapters/kube/testing/fake.ts";
import type { StepCtx } from "../../executor/types.ts";
import type { CredentialStore } from "../../security/store.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { GateReport } from "../../../shared/gates.ts";
import type { ConsumerManifest } from "../../../shared/consumer.ts";
import type { MongodbMode } from "../../../shared/unit-size.ts";
import type { MongodbSeedInput, VaultSeeder, VaultSeedOutcome } from "./vault-seeder.ts";
import type { DeployableOnboardParams } from "./onboard.run.ts";
import { clusterMapPath } from "../../../shared/cluster-values.ts";

// What the manifest's `mongodb` word DOES, at run level. It decides two things that must agree: the
// registration the appset renders the instance from, and whether a credential is seeded at all. A
// consumer on the cluster's shared replica set needs neither; one that brings its own needs both,
// before its first pod starts — the mongo image creates the root user at first init and never again.
//
// A dedicated file per step concern, the onboard-activate/onboard-fqdn pattern, so
// onboard.run.test.ts stays within the file-size doctrine.

const SHA = "a".repeat(40);

const MANIFEST: ConsumerManifest = {
  apiVersion: "hostyour.cloud/v1", kind: "ConsumerManifest", mongodb: "shared",
  name: "acme", owner: "team-acme", envs: ["prod"],
  chart: { path: "deploy/chart" }, services: [], databases: [], secrets: [],
  builds: [{ name: "acme-api", containerfile: "Containerfile" }],
};
const CHART_PINS = 'builds:\n  - name: acme-api\n    image: acme-api\n    tag: "0.0.0"\n';

let db: DbHandle;
// The size table is seeded at BOOT (boot/wire.ts), not by the migration — and the quota this word
// feeds into is resolved against it.
beforeEach(() => { db = openDb(":memory:"); seedUnitSizes(db.db); });
afterEach(() => { db.sqlite.close(); });

const prodClusterStage: ClusterStageResolver = async (cluster) => ({ name: cluster, stage: "prod" });

function passReport(mongodb: MongodbMode): GateReport {
  return {
    contractVersion: "1.5", runnerVersion: "t", repoURL: "https://github.com/x/acme.git",
    requestedRef: "HEAD", resolvedSha: SHA, startedAt: 1, finishedAt: 2,
    manifest: { ...MANIFEST, mongodb },
    dependencies: [],
    gates: [{ id: "G1", title: "manifest present", severity: "hard", status: "pass", expected: "x", found: "y", reason: null, detail: "ok" }],
    sandbox: { mustFailTargets: [], mustFailTargetsDeclaredListening: true, mustFailDenied: true, managerAddrDenied: true, mustPassReached: true },
    verdict: "pass", reportHash: "h",
  };
}

function platformRepo(): FakePlatformRepo {
  const repo = new FakePlatformRepo();
  repo.seed("s1.example", "clusters/platform/values-common.yaml", "global:\n  timezone: Europe/Amsterdam\n");
  for (const stage of ["dev", "test", "prod"]) repo.seed("s1.example", `clusters/platform/values-${stage}.yaml`, `global:\n  env: ${stage}\n`);
  repo.seed("s1.example", clusterMapPath("s1.example"), "global:\n  unitApex: example.com\n");
  return repo;
}

/** Records what reached the seeder, which is the only observable the step has: the seeder is
 *  write-only by design, so nothing can read a seeded value back — not the step, not this test. */
class RecordingSeeder {
  seeded: MongodbSeedInput[] = [];
  async seedMongodb(i: MongodbSeedInput): Promise<VaultSeedOutcome> { this.seeded.push(i); return { created: true }; }
}

function ports(mongodb: MongodbMode, seeder?: RecordingSeeder): OnboardPorts {
  return {
    repo: new FakeRepoReader({ resolvedSha: SHA, files: { "deploy/chart/values-prod.yaml": CHART_PINS } }),
    runner: new FakeGateRunner({ report: passReport(mongodb) }),
    registrations: new Registrations(platformRepo(), prodClusterStage),
    seeder: (seeder ?? {}) as unknown as VaultSeeder,
    resolver: new FakeClusterKubeResolver({
      clusterReader: new FakeClusterReader(),
      argoReader: new FakeMasterArgoReader(),
      projectWriter: new FakeMasterProjectWriter(),
      argoNamespace: "argocd",
    }),
    tenantSubdomains: async () => [],
    declareListening: true,
    argoWatchTimeoutMs: 1000,
    releaseWorkflowTimeoutMs: 200,
    releaseBuildTimeoutMs: 200,
    resolveBuildPlaneFqdn: async () => "s1.example",
  };
}

function seedCluster(): void {
  db.db.insert(servers).values({ id: "srv_1", name: "m1", host: "1.2.3.4", sshUser: "root", role: "master", status: "healthy" }).run();
  db.db.insert(clusters).values({ id: "cls_1", serverId: "srv_1", stage: "prod", domain: "s1.example", status: "active" }).run();
}

const REQ = {
  consumerName: "acme", repoURL: "https://github.com/x/acme.git", version: "1.0.0",
  channel: "stable" as const, clusterId: "cls_1", owner: "team-acme",
  chartPath: "deploy/chart", repoCredentialId: "cred_pat",
};
const streamCtx = (): { db: DbHandle["db"]; log: () => void; signal: AbortSignal } =>
  ({ db: db.db, log: () => undefined, signal: new AbortController().signal });

function stepCtx(logs: string[]): StepCtx {
  return {
    runId: "run_m", stepName: "seed-mongodb-instance", db: db.db, params: {},
    creds: {} as unknown as CredentialStore,
    secrets: { get: () => undefined, wipe: () => undefined },
    signal: new AbortController().signal, logger: {} as unknown as Logger,
    ssh: () => Promise.reject(new Error("no ssh")), openPasswordSession: () => Promise.reject(new Error("no ssh")),
    closePasswordSession: () => undefined, attest: () => Promise.reject(new Error("no attest")),
    log: (_s, t) => logs.push(t), checkpoint: () => undefined, readCheckpoint: () => undefined, registerCleanup: () => undefined,
  };
}

const params = (mongodb: MongodbMode): DeployableOnboardParams => ({
  consumerName: "acme", stage: "prod", mongodb,
} as unknown as DeployableOnboardParams);

describe("the manifest's mongodb word at plan time", () => {
  for (const mode of ["shared", "standalone", "replicaset"] as const) {
    it(`freezes "${mode}" into the params verbatim`, async () => {
      seedCluster();
      // A unit that brings its OWN MongoDB is sized above the frugal default, which is what G24
      // holds it to — the word being frozen here is not what that gate is about.
      const res = await makeOnboardDef(ports(mode)).planStream!({ ...REQ, size: mode === "shared" ? "small" : "medium" }, streamCtx());
      expect(res.outcome).toBe("planned");
      if (res.outcome !== "planned" || res.params.form !== "deployable") return;
      // The registration is what the consumers ApplicationSet gates its per-consumer MongoDB source
      // on, so a word altered here is an instance rendered in the wrong shape — or not at all.
      expect(res.params.mongodb).toBe(mode);
    });
  }
});

describe("seed-mongodb-instance", () => {
  it("seeds NOTHING for a consumer on the cluster's shared replica set", async () => {
    const seeder = new RecordingSeeder();
    const logs: string[] = [];
    await seedMongodbInstanceStep(ports("shared", seeder), params("shared")).run(stepCtx(logs));
    expect(seeder.seeded).toEqual([]);
    expect(logs.join(" ")).toContain("shared MongoDB replica set");
  });

  for (const mode of ["standalone", "replicaset"] as const) {
    it(`seeds the root password AND the keyfile for "${mode}"`, async () => {
      const seeder = new RecordingSeeder();
      await seedMongodbInstanceStep(ports(mode, seeder), params(mode)).run(stepCtx([]));

      expect(seeder.seeded).toHaveLength(1);
      const seeded = seeder.seeded[0];
      expect(seeded).toMatchObject({ stage: "prod", consumerName: "acme" });
      // 32 bytes as hex — the form that needs no escaping in a MONGODB_URI.
      expect(seeded?.rootPassword).toMatch(/^[0-9a-f]{64}$/);
      // The keyfile goes in for BOTH modes although only a replica set mounts it: the leaf is
      // create-only, so an entry written without it could never gain it, and a unit re-onboarded
      // from standalone to replicaset would come up with no keyfile to mount.
      expect(seeded?.keyfile).toMatch(/^[A-Za-z0-9+/]+=*$/);
      expect((seeded?.keyfile ?? "").length).toBeGreaterThan(1000);
    });
  }

  it("mints a DIFFERENT credential every time — nothing is derived from the consumer's name", async () => {
    const seeder = new RecordingSeeder();
    await seedMongodbInstanceStep(ports("replicaset", seeder), params("replicaset")).run(stepCtx([]));
    await seedMongodbInstanceStep(ports("replicaset", seeder), params("replicaset")).run(stepCtx([]));
    expect(seeder.seeded[0]?.rootPassword).not.toBe(seeder.seeded[1]?.rootPassword);
    expect(seeder.seeded[0]?.keyfile).not.toBe(seeder.seeded[1]?.keyfile);
  });
});
