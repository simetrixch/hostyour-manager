// Tests that a consumer restore keeps the unit's build list in registrations/<unit>/build.yaml.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { DbHandle } from "../../db/client.ts";
import { ConsumerRegistrationSchema, type ConsumerRegistration } from "../../../shared/consumer.ts";
import { parseRegistration, serializePointer } from "#unit/server/registration-laws.ts";
import { seedQuota } from "#unit/shared/unit-size.ts";
import type { GitHubConsumer } from "#unit/server/adapters/github-consumer/port.ts";
import {
  openFixtureDb, seedClusters, seedConsumerRow, makeFakes, consumerPorts,
  stepCtx, CONSUMER, TARGET, SOURCE, missing,
} from "./relocation.fixture.ts";
import { consumerWorld } from "./relocation-world-consumer.ts";
import { restoreCleanups } from "./restore-cleanups.ts";

let db: DbHandle;
beforeEach(() => { db = openFixtureDb(); });
afterEach(() => { db.sqlite.close(); });

const DUMPED_ENTRY: ConsumerRegistration = {
  name: CONSUMER,
  repoURL: "https://github.com/x/acme.git",
  suspended: false,
  quiesced: false,
  removing: false,
  chartPath: "deploy/chart",
  host: "acme",
  cluster: "s1",
  databases: ["acme_db"],
  services: ["mongodb"],
  size: "small",
  mongodb: "shared",
  quota: seedQuota("small"),
};
const DUMPED = serializePointer(ConsumerRegistrationSchema, DUMPED_ENTRY);

// A dump whose unit fields differ from the standing unit file: the restore must keep what stands.
const DUMPED_OTHER_UNIT = serializePointer(ConsumerRegistrationSchema, {
  ...DUMPED_ENTRY,
  repoURL: "https://github.com/old-owner/acme.git",
  suspended: true,
});

const MANIFEST_WITH_BUILDS = `
apiVersion: hostyour.cloud/v1
kind: ConsumerManifest
name: acme
owner: x
envs: [prod, test, dev]
chart:
  path: deploy/chart
builds:
  - name: acme-frontend
    containerfile: Containerfile
  - name: acme-worker
    containerfile: Containerfile
`;

describe("restore build list", () => {
  // Planted defect: setting builds: [] in writeRegistrationFromDump makes build.yaml differ
  // from beforeBuild, which fails the byte-identical check below.
  it("keeps a standing build.yaml byte-identical when another stage stands, while quiescing the restored stage", async () => {
    seedClusters(db);
    seedConsumerRow(db, "offboarded");
    const f = makeFakes();
    const ports = consumerPorts(f);

    // Seed dev stage: build.yaml stands with builds: ["acme-api"] and quiesced: false.
    await ports.registrations.commitRegistration({
      unit: { name: CONSUMER, repoURL: "https://github.com/x/acme.git", owner: "team-acme", onboardedAt: "2026-10-01T08:00:00.000Z", suspended: false, quiesced: false },
      builds: ["acme-api"],
      deploy: {
        stage: "dev", chartPath: "deploy/chart", cluster: SOURCE.cluster, host: "acme-dev",
        databases: ["acme_dev"], keyPatterns: [], channelPatterns: [], services: ["mongodb"],
        size: "small", mongodb: "shared", quota: seedQuota("small"),
      },
      runId: "run_seed",
    });

    const beforeBuild = await f.platformRepo.withBranch(ports.registrations.branch, (b) => b.readFile(`registrations/${CONSUMER}/build.yaml`));
    expect(beforeBuild).not.toBeNull();

    const world = await consumerWorld(ports, "app_1")(stepCtx(db, "write-reg", {}, []));
    await world.writeRegistrationFromDump(stepCtx(db, "write-reg", {}, []), DUMPED_OTHER_UNIT, { clusterId: TARGET.clusterId, cluster: TARGET.cluster, domain: TARGET.domain });

    const afterBuild = await f.platformRepo.withBranch(ports.registrations.branch, (b) => b.readFile(`registrations/${CONSUMER}/build.yaml`));
    expect(afterBuild).toBe(beforeBuild);

    const stageFile = await f.platformRepo.withBranch(ports.registrations.branch, (b) => b.readFile(`registrations/${CONSUMER}/prod.yaml`));
    expect(parseRegistration(stageFile!).quiesced).toBe(true);
    expect(parseRegistration(stageFile!).cluster).toBe(TARGET.cluster);
  });

  it("writes the manifest's build names when no build.yaml stands, and quiesces the stage", async () => {
    seedClusters(db);
    seedConsumerRow(db, "offboarded");
    const f = makeFakes();
    const ports = consumerPorts(f);
    ports.github = { readFile: async () => MANIFEST_WITH_BUILDS } as unknown as GitHubConsumer;

    const world = await consumerWorld(ports, "app_1")(stepCtx(db, "write-reg", {}, []));
    await world.writeRegistrationFromDump(stepCtx(db, "write-reg", {}, []), DUMPED, { clusterId: TARGET.clusterId, cluster: TARGET.cluster, domain: TARGET.domain });

    const buildYaml = await f.platformRepo.withBranch(ports.registrations.branch, (b) => b.readFile(`registrations/${CONSUMER}/build.yaml`));
    expect(parseRegistration(buildYaml!).builds).toEqual(["acme-frontend", "acme-worker"]);
    // The unit file carries no pause of its own: the stage is closed, and nothing lifts a unit-wide flag.
    expect(parseRegistration(buildYaml!).quiesced).toBe(false);

    const stageYaml = await f.platformRepo.withBranch(ports.registrations.branch, (b) => b.readFile(`registrations/${CONSUMER}/prod.yaml`));
    expect(parseRegistration(stageYaml!).quiesced).toBe(true);
  });

  it("refuses when no build.yaml stands and another unit attests one of the manifest's build names", async () => {
    seedClusters(db);
    seedConsumerRow(db, "offboarded");
    const f = makeFakes();
    const ports = consumerPorts(f);
    ports.github = { readFile: async () => MANIFEST_WITH_BUILDS } as unknown as GitHubConsumer;

    // Another unit attests acme-worker.
    await ports.registrations.commitRegistration({
      unit: { name: "other", repoURL: "https://github.com/x/other.git", suspended: false, quiesced: false },
      builds: ["acme-worker"],
      runId: "run_other",
    });

    const world = await consumerWorld(ports, "app_1")(stepCtx(db, "write-reg", {}, []));
    await expect(
      world.writeRegistrationFromDump(stepCtx(db, "write-reg", {}, []), DUMPED, { clusterId: TARGET.clusterId, cluster: TARGET.cluster, domain: TARGET.domain }),
    ).rejects.toThrow(/acme-worker.*other/);
  });

  it("abort cleanup leaves standing build.yaml intact, and removes build.yaml when it was the only stage", async () => {
    // Subcase A: standing build.yaml with dev stage.
    seedClusters(db);
    seedConsumerRow(db, "offboarded");
    const f = makeFakes();
    const ports = consumerPorts(f);

    await ports.registrations.commitRegistration({
      unit: { name: CONSUMER, repoURL: "https://github.com/x/acme.git", suspended: false, quiesced: false },
      builds: ["acme-api"],
      deploy: {
        stage: "dev", chartPath: "deploy/chart", cluster: SOURCE.cluster, host: "acme-dev",
        databases: ["acme_dev"], keyPatterns: [], channelPatterns: [], services: ["mongodb"],
        size: "small", mongodb: "shared", quota: seedQuota("small"),
      },
      runId: "run_seed",
    });

    const beforeBuild = await f.platformRepo.withBranch(ports.registrations.branch, (b) => b.readFile(`registrations/${CONSUMER}/build.yaml`));

    const world = await consumerWorld(ports, "app_1")(stepCtx(db, "write-reg", {}, []));
    await world.writeRegistrationFromDump(stepCtx(db, "write-reg", {}, []), DUMPED, { clusterId: TARGET.clusterId, cluster: TARGET.cluster, domain: TARGET.domain });

    // Abort with restore-remove-target.
    const cleanupsA = restoreCleanups(ports, { appId: "app_1", targetClusterId: TARGET.clusterId });
    const removeTargetA = cleanupsA.find((c) => c.name === "restore-remove-target")!;
    f.target.argo.setStatus(missing);
    await removeTargetA.run(stepCtx(db, "restore-remove-target", { appId: "app_1" }, []));

    const buildAfterAbortA = await f.platformRepo.withBranch(ports.registrations.branch, (b) => b.readFile(`registrations/${CONSUMER}/build.yaml`));
    expect(buildAfterAbortA).toBe(beforeBuild);
    expect(await ports.registrations.readRegistration("prod", CONSUMER)).toBeNull();
    expect(await ports.registrations.readRegistration("dev", CONSUMER)).not.toBeNull();

    // Subcase B: no other stage stood (case 2's write).
    const f2 = makeFakes();
    const ports2 = consumerPorts(f2);
    ports2.github = { readFile: async () => MANIFEST_WITH_BUILDS } as unknown as GitHubConsumer;

    const world2 = await consumerWorld(ports2, "app_1")(stepCtx(db, "write-reg", {}, []));
    await world2.writeRegistrationFromDump(stepCtx(db, "write-reg", {}, []), DUMPED, { clusterId: TARGET.clusterId, cluster: TARGET.cluster, domain: TARGET.domain });

    const cleanupsB = restoreCleanups(ports2, { appId: "app_1", targetClusterId: TARGET.clusterId });
    const removeTargetB = cleanupsB.find((c) => c.name === "restore-remove-target")!;
    f2.target.argo.setStatus(missing);
    await removeTargetB.run(stepCtx(db, "restore-remove-target", { appId: "app_1" }, []));

    const buildAfterAbortB = await f2.platformRepo.withBranch(ports2.registrations.branch, (b) => b.readFile(`registrations/${CONSUMER}/build.yaml`));
    expect(buildAfterAbortB).toBeNull();
    expect(await ports2.registrations.readRegistration("prod", CONSUMER)).toBeNull();
  });
});
