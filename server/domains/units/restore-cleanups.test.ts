// Tests for consumer restore cleanups on abort.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { DbHandle } from "../../db/client.ts";
import type { Cleanup } from "../../executor/types.ts";
import type { RepoCredentialManifest } from "../../adapters/kube/port.ts";
import {
  openFixtureDb, seedClusters, seedConsumerRow, seedConsumerRegistration, makeFakes, consumerPorts,
  stepCtx, CONSUMER, TARGET, missing,
  restoreBuildPorts,
} from "./relocation.fixture.ts";
import type { Logger } from "../../kernel/logger.ts";
import { CredentialStore } from "../../security/store.ts";
import { consumerRepoCredentialName } from "./repo-credential.ts";
import { makeRestoreDef } from "./restore.run.ts";
import { consumerWorld } from "./relocation-world-consumer.ts";

let db: DbHandle;
let store: CredentialStore;
beforeEach(() => {
  db = openFixtureDb();
  store = new CredentialStore({ db: db.db, logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as unknown as Logger });
});
afterEach(() => { db.sqlite.close(); });

const GENERATION = "20260927T030000Z";
const PARAMS = { appId: "app_1", targetClusterId: TARGET.clusterId, generation: GENERATION };

describe("restore-cleanups", () => {
  // Planted defect: removing restoreCeremonySecretsCleanup from def.cleanups in restore.run.ts
  // (line 96) fails this test because "remove-ceremony-secrets" will not resolve.
  it("definition resolves all four cleanups", () => {
    const f = makeFakes();
    const ports = consumerPorts(f);
    const def = makeRestoreDef(ports, restoreBuildPorts());
    expect(def.cleanups).toBeDefined();

    const cleanups = def.cleanups!(PARAMS);
    const names = cleanups.map((c) => c.name);
    expect(names).toEqual([
      "restore-remove-repo-credential",
      "restore-remove-instance-secrets",
      "restore-remove-target",
      "remove-ceremony-secrets",
    ]);
  });

  it("compensations run when the app was offboarded", async () => {
    seedClusters(db);
    seedConsumerRow(db, "offboarded");
    const f = makeFakes();
    const ports = consumerPorts(f);
    await seedConsumerRegistration(ports.registrations, { name: CONSUMER, stage: "prod", cluster: TARGET.cluster });
    f.target.argo.setStatus(missing);

    expect(ports.repoCredential).toBeDefined();
    const repoCredential = ports.repoCredential!;
    const expectedCredName = consumerRepoCredentialName(CONSUMER, "prod");
    await repoCredential.applyRepoCredential({
      metadata: { namespace: TARGET.cluster, name: expectedCredName },
      stringData: { url: "https://github.com/x/acme.git", password: "token" },
    } as RepoCredentialManifest);

    const deleteRepoCredSpy = vi.spyOn(repoCredential, "deleteRepoCredential");
    const deletePostgresSpy = vi.spyOn(ports.seeder, "deletePostgres");
    const deleteMongodbSpy = vi.spyOn(ports.seeder, "deleteMongodb");
    const deleteRedisSpy = vi.spyOn(ports.seeder, "deleteRedis");
    const deleteMariadbSpy = vi.spyOn(ports.seeder, "deleteMariadb");
    const setRemovingSpy = vi.spyOn(ports.registrations, "setRemoving");
    const removeRegSpy = vi.spyOn(ports.registrations, "removeRegistration");
    const deleteAppSpy = vi.spyOn(ports.seeder, "deleteApp");

    const def = makeRestoreDef(ports, restoreBuildPorts());
    const cleanups = def.cleanups!(PARAMS);
    const logs: string[] = [];

    for (const cleanup of cleanups) {
      const ctx = { ...stepCtx(db, cleanup.name, PARAMS, logs), creds: store };
      await cleanup.run(ctx);
    }

    expect(deleteRepoCredSpy).toHaveBeenCalledWith(TARGET.cluster, expectedCredName);
    expect(deletePostgresSpy).toHaveBeenCalledWith({ stage: "prod", consumerName: CONSUMER });
    expect(deleteMongodbSpy).toHaveBeenCalledWith({ stage: "prod", consumerName: CONSUMER });
    expect(deleteRedisSpy).toHaveBeenCalledWith({ stage: "prod", consumerName: CONSUMER });
    expect(deleteMariadbSpy).toHaveBeenCalledWith({ stage: "prod", consumerName: CONSUMER });
    expect(setRemovingSpy).toHaveBeenCalledWith("prod", CONSUMER, expect.any(String));
    expect(removeRegSpy).toHaveBeenCalledWith("prod", CONSUMER, expect.any(String));
    expect(setRemovingSpy.mock.invocationCallOrder[0]!).toBeLessThan(removeRegSpy.mock.invocationCallOrder[0]!);
    expect(deleteAppSpy).toHaveBeenCalledWith({ stage: "prod", consumerName: CONSUMER });

    expect(logs.some((l) => l.includes("ArgoCD repository credential for acme at prod deleted on the target"))).toBe(true);
    expect(logs.some((l) => l.includes("database instance credentials removed"))).toBe(true);
    expect(logs.some((l) => l.includes("marked removing"))).toBe(true);
    expect(logs.some((l) => l.includes("registration for acme (prod) removed"))).toBe(true);
    expect(logs.some((l) => l.includes("Application acme-prod pruned on target"))).toBe(true);
    expect(logs.some((l) => l.includes("namespace acme-prod deleted on the target cluster"))).toBe(true);
    expect(logs.some((l) => l.includes("ceremony secrets removed"))).toBe(true);
  });

  // Planted defect: calling removeRegistration before the wait makes this test red because the
  // registration file would be removed instead of still standing with removing: true when the wait times out.
  it("throws when the Application never reaches pruned, leaves registration standing with removing: true", async () => {
    seedClusters(db);
    seedConsumerRow(db, "offboarded");
    const f = makeFakes();
    const ports = consumerPorts(f);
    await seedConsumerRegistration(ports.registrations, { name: CONSUMER, stage: "prod", cluster: TARGET.cluster });
    f.target.argo.setStatus({ syncRevision: null, targetRevision: null, sync: "Unknown", health: "Healthy" });

    const setRemovingSpy = vi.spyOn(ports.registrations, "setRemoving");
    const removeRegSpy = vi.spyOn(ports.registrations, "removeRegistration");

    const def = makeRestoreDef(ports, restoreBuildPorts());
    const cleanups = def.cleanups!(PARAMS);
    const targetCleanup = cleanups.find((c) => c.name === "restore-remove-target")!;
    expect(targetCleanup).toBeDefined();

    const logs: string[] = [];
    const ctx = { ...stepCtx(db, targetCleanup.name, PARAMS, logs), creds: store };

    await expect(targetCleanup.run(ctx)).rejects.toThrow(/was not pruned/);

    expect(f.target.argo.lastWatchOpts?.timeoutMs).toBe(ports.argoWatchTimeoutMs);
    expect(setRemovingSpy).toHaveBeenCalledWith("prod", CONSUMER, expect.any(String));
    expect(removeRegSpy).not.toHaveBeenCalled();

    const standing = await ports.registrations.readRegistration("prod", CONSUMER);
    expect(standing).not.toBeNull();
    expect(standing?.entry.removing).toBe(true);
  });

  it("compensations do nothing when the app was NOT offboarded", async () => {
    seedClusters(db);
    seedConsumerRow(db, "active");
    const f = makeFakes();
    const ports = consumerPorts(f);
    await seedConsumerRegistration(ports.registrations, { name: CONSUMER, stage: "prod", cluster: TARGET.cluster });

    expect(ports.repoCredential).toBeDefined();
    const deleteRepoCredSpy = vi.spyOn(ports.repoCredential!, "deleteRepoCredential");
    const deletePostgresSpy = vi.spyOn(ports.seeder, "deletePostgres");
    const deleteMongodbSpy = vi.spyOn(ports.seeder, "deleteMongodb");
    const deleteRedisSpy = vi.spyOn(ports.seeder, "deleteRedis");
    const deleteMariadbSpy = vi.spyOn(ports.seeder, "deleteMariadb");
    const removeRegSpy = vi.spyOn(ports.registrations, "removeRegistration");
    const deleteAppSpy = vi.spyOn(ports.seeder, "deleteApp");

    const def = makeRestoreDef(ports, restoreBuildPorts());
    const cleanups = def.cleanups!(PARAMS);
    const logs: string[] = [];

    for (const cleanup of cleanups) {
      const ctx = { ...stepCtx(db, cleanup.name, PARAMS, logs), creds: store };
      await cleanup.run(ctx);
    }

    expect(deleteRepoCredSpy).not.toHaveBeenCalled();
    expect(deletePostgresSpy).not.toHaveBeenCalled();
    expect(deleteMongodbSpy).not.toHaveBeenCalled();
    expect(deleteRedisSpy).not.toHaveBeenCalled();
    expect(deleteMariadbSpy).not.toHaveBeenCalled();
    expect(removeRegSpy).not.toHaveBeenCalled();
    expect(deleteAppSpy).not.toHaveBeenCalled();

    const expectedNotOffboardedLog = `${CONSUMER} (prod) was not offboarded when this restore started — nothing of it is removed`;
    const notOffboardedLogs = logs.filter((l) => l === expectedNotOffboardedLog);
    expect(notOffboardedLogs).toHaveLength(4);
  });

  it("armRestoreCleanups registers all three relocation compensations", async () => {
    seedClusters(db);
    seedConsumerRow(db, "offboarded");
    const f = makeFakes();
    const ports = consumerPorts(f);
    const world = await consumerWorld(ports, "app_1")(stepCtx(db, "provision-target", PARAMS, []));

    const registered: Cleanup[] = [];
    const ctx = {
      ...stepCtx(db, "provision-target", PARAMS, []),
      registerCleanup: (c: Cleanup) => { registered.push(c); },
    };

    world.armRestoreCleanups?.(ctx, { clusterId: TARGET.clusterId, cluster: TARGET.cluster, domain: TARGET.domain });
    expect(registered.map((c) => c.name)).toEqual([
      "restore-remove-repo-credential",
      "restore-remove-instance-secrets",
      "restore-remove-target",
    ]);
  });
});
