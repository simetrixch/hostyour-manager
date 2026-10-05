import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { seedUnitSizes } from "#unit/server/unit-size.ts";
import { seedQuota } from "#unit/shared/unit-size.ts";
import type { ConsumerManifest } from "../../../shared/consumer.ts";
import { openDb, type DbHandle } from "../../db/client.ts";
import { servers, clusters } from "../../db/schema/inventory.ts";
import { makeOnboardDef, type OnboardParams } from "./onboard.run.ts";
import { FakeRepoReader } from "../../adapters/git/testing/fake.ts";
import { FakeGateRunner } from "../../adapters/gate-runner/testing/fake.ts";
import type { StepCtx } from "../../executor/types.ts";
import type { CredentialStore } from "../../security/store.ts";
import type { Logger } from "../../kernel/logger.ts";
import { SHA, MANIFEST, CHART_PINS, passReport, ports } from "./onboard.fixture.ts";

let db: DbHandle;
beforeEach(() => { db = openDb(":memory:"); seedUnitSizes(db.db); });
afterEach(() => { db.sqlite.close(); });

function seedClusters(): void {
  db.db.insert(servers).values({ id: "srv_1", name: "m1", host: "1.2.3.4", sshUser: "root", role: "master", status: "healthy" }).run();
  db.db.insert(servers).values({ id: "srv_2", name: "m2", host: "1.2.3.5", sshUser: "root", role: "slave", status: "healthy" }).run();
  db.db.insert(clusters).values({ id: "cls_1", serverId: "srv_1", stage: "prod", domain: "s1.example", name: "s1", status: "active" }).run();
  db.db.insert(clusters).values({ id: "cls_2", serverId: "srv_2", stage: "test", domain: "s2.example", name: "s2", status: "active" }).run();
}
const request = (over: Record<string, unknown>): Record<string, unknown> => ({
  consumerName: "acme", repoURL: "https://github.com/x/acme.git", version: "1.0.0", channel: "stable",
  owner: "team-acme", chartPath: "deploy/chart", repoCredentialId: "cred_pat", ...over,
});
const planCtx = () => ({ db: db.db, log: () => undefined, signal: new AbortController().signal });
function ctx(p: OnboardParams, stepName: string): StepCtx {
  return {
    runId: "run_onb", stepName, db: db.db, params: p,
    creds: { open: () => Promise.resolve(Buffer.from("github_pat_test", "utf8")) } as unknown as CredentialStore,
    secrets: { get: () => undefined, wipe: () => undefined }, signal: new AbortController().signal,
    logger: {} as unknown as Logger,
    ssh: () => Promise.reject(new Error("no ssh")), openPasswordSession: () => Promise.reject(new Error("no ssh")),
    closePasswordSession: () => undefined, attest: () => Promise.reject(new Error("no attest")),
    log: () => undefined, checkpoint: () => undefined, readCheckpoint: () => undefined, registerCleanup: () => undefined,
  };
}

// What a consumer standing at PROD meets today when it is onboarded again at TEST with its own size:
// the onboard run plans it as a second, independent onboarding of the same name.
describe("onboard a standing PROD consumer again at TEST", () => {
  it("plans the whole onboarding for TEST at its own size and leaves PROD's registration as it stands", async () => {
    seedClusters();
    const prt = ports({
      runner: new FakeGateRunner({ report: passReport({ ...MANIFEST, envs: ["test", "prod"] }) }),
      repo: new FakeRepoReader({ resolvedSha: SHA, files: { "deploy/chart/values-test.yaml": CHART_PINS, "deploy/chart/values-prod.yaml": CHART_PINS } }),
    });
    const prod = await makeOnboardDef(prt).planStream!(request({ stage: "prod", clusterId: "cls_1", size: "large" }), planCtx());
    if (prod.outcome !== "planned") throw new Error(prod.summary);
    await makeOnboardDef(prt).steps(prod.params).find((s) => s.name === "write-registration")!.run(ctx(prod.params, "write-registration"));
    const before = await prt.registrations.readRegistration("prod", "acme");

    const test = await makeOnboardDef(prt).planStream!(request({ stage: "test", clusterId: "cls_1", size: "small" }), planCtx());
    // Planned, not refused: nothing in the onboard run holds a name that already stands at another stage.
    expect(test.outcome).toBe("planned");
    if (test.outcome !== "planned" || test.params.form !== "deployable") throw new Error("not a deployable plan");
    expect(test.params).toMatchObject({ stage: "test", size: "small", namespace: "acme-test" });
    // The WHOLE onboarding runs again, its release cycle included: the kit is synced, the webhook set and
    // a release dispatched for the new stage (which pins that stage alone, release-kit release.sh).
    const steps = makeOnboardDef(prt).steps(test.params).map((s) => s.name);
    expect(steps).toEqual(expect.arrayContaining(["write-registration", "seed-secrets", "inject-release-kit", "setup-webhook", "trigger-release", "record-inventory"]));
    await makeOnboardDef(prt).steps(test.params).find((s) => s.name === "write-registration")!.run(ctx(test.params, "write-registration"));
    expect((await prt.registrations.readRegistration("test", "acme"))?.entry.size).toBe("small");
    // PROD's registration, size and quota included, is untouched.
    expect(await prt.registrations.readRegistration("prod", "acme")).toEqual(before);
    expect(before?.entry.size).toBe("large");
  });
});

describe("onboard a further stage on the release another stage runs", () => {
  it("PLANTED DEFECT: puts the standing release on the new stage as it stands, and mints, triggers and builds nothing", async () => {
    seedClusters();
    const prt = ports({
      runner: new FakeGateRunner({ report: passReport({ ...MANIFEST, envs: ["test", "prod"] }) }),
      repo: new FakeRepoReader({ resolvedSha: SHA, files: { "deploy/chart/values-test.yaml": CHART_PINS, "deploy/chart/values-prod.yaml": CHART_PINS } }),
    });
    const test = await makeOnboardDef(prt).planStream!(request({ stage: "test", clusterId: "cls_1", existing: true }), planCtx());
    if (test.outcome !== "planned" || test.params.form !== "deployable") throw new Error("not a deployable plan");
    expect(test.params).toMatchObject({ version: "1.0.0", channel: "stable", existing: true });
    const steps = makeOnboardDef(prt).steps(test.params).map((s) => s.name);
    expect(steps).toContain("put-release");
    expect(steps).not.toContain("trigger-release");
    expect(steps).not.toContain("watch-release-build");
    // The release still has to come up on the new stage: its deployment is watched as for any release.
    expect(steps.indexOf("watch-deployment")).toBeGreaterThan(steps.indexOf("put-release"));
  });
});

describe("onboard a consumer with a data part of its own", () => {
  it("sizes every part by the one size chosen and pins each part's volume, the new sizes included", async () => {
    seedClusters();
    const prt = ports({
      runner: new FakeGateRunner({ report: passReport({ ...MANIFEST, services: ["postgresql"] }) }),
      repo: new FakeRepoReader({ resolvedSha: SHA, files: { "deploy/chart/values-prod.yaml": CHART_PINS } }),
    });
    const plan = await makeOnboardDef(prt).planStream!(request({ stage: "prod", clusterId: "cls_1", size: "xlarge" }), planCtx());
    if (plan.outcome !== "planned") throw new Error(plan.summary);
    await makeOnboardDef(prt).steps(plan.params).find((s) => s.name === "write-registration")!.run(ctx(plan.params, "write-registration"));
    const entry = (await prt.registrations.readRegistration("prod", "acme"))?.entry;
    // A new size has no preset volume to fall back to in the appset: the pin is what sizes the claim.
    expect([entry?.size, entry?.sizes, entry?.volumes]).toEqual(["xlarge", { postgresql: "xlarge" }, { postgresql: "100Gi" }]);
  });

  it("registers a Redis of the consumer's own with its maxmemory policy, its size, its volume and its row in the quota", async () => {
    seedClusters();
    const own = { ...MANIFEST, services: ["redis" as const], keyPatterns: ["acme:*"], redis: "standalone" as const, redisMaxmemoryPolicy: "allkeys-lru" as const };
    const prt = ports({
      runner: new FakeGateRunner({ report: passReport(own) }),
      repo: new FakeRepoReader({ resolvedSha: SHA, files: { "deploy/chart/values-prod.yaml": CHART_PINS } }),
    });
    const plan = await makeOnboardDef(prt).planStream!(request({ stage: "prod", clusterId: "cls_1", size: "medium" }), planCtx());
    if (plan.outcome !== "planned") throw new Error(plan.summary);
    await makeOnboardDef(prt).steps(plan.params).find((s) => s.name === "write-registration")!.run(ctx(plan.params, "write-registration"));
    const entry = (await prt.registrations.readRegistration("prod", "acme"))?.entry;
    expect([entry?.redis, entry?.redisMaxmemoryPolicy, entry?.sizes, entry?.volumes]).toEqual(["standalone", "allkeys-lru", { redis: "medium" }, { redis: "4Gi" }]);
    expect(entry?.quota).toEqual(seedQuota("medium", { postgresql: false, mongodb: "shared", redis: "standalone" }));
  });

  it("registers a MariaDB of the consumer's own with its size, its volume and its row in the quota", async () => {
    seedClusters();
    const own = { ...MANIFEST, services: ["mariadb" as const], databases: ["shop"] };
    const prt = ports({
      runner: new FakeGateRunner({ report: passReport(own) }),
      repo: new FakeRepoReader({ resolvedSha: SHA, files: { "deploy/chart/values-prod.yaml": CHART_PINS } }),
    });
    const plan = await makeOnboardDef(prt).planStream!(request({ stage: "prod", clusterId: "cls_1", size: "medium" }), planCtx());
    if (plan.outcome !== "planned") throw new Error(plan.summary);
    await makeOnboardDef(prt).steps(plan.params).find((s) => s.name === "write-registration")!.run(ctx(plan.params, "write-registration"));
    const entry = (await prt.registrations.readRegistration("prod", "acme"))?.entry;
    expect([entry?.services, entry?.sizes, entry?.volumes]).toEqual([["mariadb"], { mariadb: "medium" }, { mariadb: "20Gi" }]);
    expect(entry?.quota).toEqual(seedQuota("medium", { postgresql: false, mongodb: "shared", mariadb: true }));
  });

  it("writes noeviction for a Redis of its own that names no policy, and no redis key for the shared server", async () => {
    seedClusters();
    const own = { ...MANIFEST, services: ["redis" as const], keyPatterns: ["acme:*"], redis: "standalone" as const };
    const cases: [ConsumerManifest, unknown[]][] = [[own, ["standalone", "noeviction"]], [{ ...MANIFEST, services: ["redis"], keyPatterns: ["acme:*"] }, [undefined, undefined]]];
    for (const [manifest, want] of cases) {
      const prt = ports({
        runner: new FakeGateRunner({ report: passReport(manifest) }),
        repo: new FakeRepoReader({ resolvedSha: SHA, files: { "deploy/chart/values-prod.yaml": CHART_PINS } }),
      });
      const plan = await makeOnboardDef(prt).planStream!(request({ stage: "prod", clusterId: "cls_1", size: "medium" }), planCtx());
      if (plan.outcome !== "planned") throw new Error(plan.summary);
      await makeOnboardDef(prt).steps(plan.params).find((s) => s.name === "write-registration")!.run(ctx(plan.params, "write-registration"));
      const entry = (await prt.registrations.readRegistration("prod", "acme"))?.entry;
      expect([entry?.redis, entry?.redisMaxmemoryPolicy]).toEqual(want);
    }
  });
});
