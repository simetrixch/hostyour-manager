import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { seedQuota } from "../../../shared/unit-size.ts";
import { openDb, type DbHandle } from "../../db/client.ts";
import { servers, clusters, apps } from "../../db/schema/inventory.ts";
import { makeOffboardDef, type OffboardPorts } from "./offboard.run.ts";
import { Registry, type ClusterStageResolver } from "./registry.ts";
import { FakePlatformRepo } from "../../adapters/git/testing/fake.ts";
import { FakeMasterArgoReader, FakeClusterReader, FakeMasterProjectWriter, FakeClusterKubeResolver } from "../../adapters/kube/testing/fake.ts";
import { FakeDnsProvider } from "../../adapters/dns/testing/fake.ts";
import type { StepCtx } from "../../executor/types.ts";
import type { CredentialStore } from "../../security/store.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { VaultSeeder } from "./vault-seeder.ts";

// remove-registration's RESUME-IDEMPOTENCY, split out of offboard.run.test.ts (that file is at its
// line budget). The crash case: the step's git commit landed but its `ok` write was lost, and the
// executor re-runs the WHOLE step on resume (a running step is reset to pending). The step must
// converge — the read-first skip is the same one purge's remove-registration and the tenant twin
// carry. Without it, the registry's absence refusal ('consumer "acme" is not registered at prod')
// failed the resumed run identically on every retry.

const prodClusterStage: ClusterStageResolver = async (cluster) => ({ name: cluster, stage: "prod" });

let db: DbHandle;
beforeEach(() => { db = openDb(":memory:"); });
afterEach(() => { db.sqlite.close(); });

function ports(reg: Registry): OffboardPorts {
  return {
    registry: reg,
    resolver: new FakeClusterKubeResolver({
      clusterReader: new FakeClusterReader({ deployState: { domain: "s1.example", stage: "prod", writtenAt: "2026-01-01T00:00:00Z", generation: 3 } }),
      argoReader: new FakeMasterArgoReader({ status: { syncRevision: null, targetRevision: null, sync: "Unknown", health: "Missing" } }),
      projectWriter: new FakeMasterProjectWriter(),
      argoNamespace: "argocd",
    }),
    argoWatchTimeoutMs: 1000,
    seeder: {} as VaultSeeder, // remove-registration never touches Vault
    dns: new FakeDnsProvider(),
  };
}

function ctx(logs: string[]): StepCtx {
  return {
    runId: "run_off", stepName: "remove-registration", db: db.db, creds: {} as unknown as CredentialStore, params: { appId: "app_1" },
    secrets: { get: () => undefined, wipe: () => undefined }, signal: new AbortController().signal, logger: {} as unknown as Logger,
    ssh: () => Promise.reject(new Error("no ssh")), openPasswordSession: () => Promise.reject(new Error("no ssh")),
    closePasswordSession: () => undefined, attest: () => Promise.reject(new Error("no attest")),
    log: (_s, t) => logs.push(t), checkpoint: () => undefined, readCheckpoint: () => undefined, registerCleanup: () => undefined,
  };
}

describe("offboard remove-registration on resume", () => {
  it("a second run after its git commit skips instead of wedging", async () => {
    db.db.insert(servers).values({ id: "srv_1", name: "m1", host: "1.2.3.4", sshUser: "root", role: "master", status: "healthy" }).run();
    db.db.insert(clusters).values({ id: "cls_1", serverId: "srv_1", stage: "prod", domain: "s1.example", status: "active" }).run();
    db.db.insert(apps).values({ id: "app_1", clusterId: "cls_1", name: "acme", stage: "prod", repoUrl: "https://github.com/x/acme.git", chartPath: "deploy/chart", provenance: "controller", status: "active", repoCredentialId: null }).run();
    const reg = new Registry(new FakePlatformRepo(), prodClusterStage);
    await reg.commitRegistration({
      unit: { name: "acme", repoURL: "https://github.com/x/acme.git", suspended: false, quiesced: false },
      builds: [],
      deploy: { stage: "prod", chartPath: "deploy/chart", cluster: "s1", databases: [], services: [], size: "small", mongodb: "shared", quota: seedQuota("small") },
      runId: "run_onb",
    });

    const logs: string[] = [];
    const remove = makeOffboardDef(ports(reg)).steps({ appId: "app_1" }).find((s) => s.name === "remove-registration")!;
    await remove.run(ctx(logs));
    expect(await reg.readRegistration("prod", "acme")).toBeNull(); // the commit landed

    await remove.run(ctx(logs)); // the resumed step — must converge, not throw
    expect(logs.some((l) => l.includes("already removed — skipping (resume)"))).toBe(true);
  });
});
