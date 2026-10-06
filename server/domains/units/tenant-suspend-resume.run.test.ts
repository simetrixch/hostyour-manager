import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { openDb, type DbHandle } from "../../db/client.ts";
import { tenants } from "../../db/schema/inventory.ts";
import { makeSuspendTenantDef, makeResumeTenantDef, tenantWatchMembers } from "./tenant-lifecycle.run.ts";
import { TenantRegistrations } from "./tenant-registrations.ts";
import { memberNamespace } from "./tenant-fanout.ts";
import { FakePlatformRepo, FAKE_BOOKS_BRANCH } from "../../adapters/git/testing/fake.ts";
import { FakeMasterArgoReader, FakeClusterReader } from "../../adapters/kube/testing/fake.ts";
import type { ArgoAppStatus } from "../../adapters/kube/port.ts";
import { SHA, GUID, FULL_SET, entry, ports, renderingMap, readerRunning, lifecycleHarness } from "./tenant-lifecycle.fixture.ts";

let db: DbHandle;
beforeEach(() => { db = openDb(":memory:"); });
afterEach(() => { db.sqlite.close(); });
const { ctx, seedTenant, runAll } = lifecycleHarness(() => db);

describe("tenant-suspend run", () => {
  it("flips the registration to suspended, waits for every member to converge OFF, and marks the row suspended", async () => {
    seedTenant();
    const reg = new TenantRegistrations(new FakePlatformRepo());
    await reg.commitTenant({ stage: "prod", guid: GUID, registration: entry(), runId: "run_onb" });
    const argo = new FakeMasterArgoReader();
    // Every member Application STAYS Synced/Healthy through a suspend — what changes is what it renders.
    argo.setStatuses(renderingMap(FULL_SET, true));

    const logs: string[] = [];
    await runAll(makeSuspendTenantDef(ports(reg, { argo, cluster: readerRunning(0) })).steps({ tenantId: "tnt_1" }), "run_susp", { tenantId: "tnt_1" }, logs);

    expect((await reg.readTenant("prod", GUID))?.entry.suspended).toBe(true);
    const row = db.db.select().from(tenants).where(eq(tenants.id, "tnt_1")).get();
    expect(row?.status).toBe("suspended");
    expect(row?.suspended).toBe(true);
    expect(logs.some((l) => l.includes("zero replicas"))).toBe(true);
  });

  it("NEVER waits for a prune: a fan-out that went Missing is a suspend that destroyed something", async () => {
    // A prune deletes the member charts' ServiceClaims, whose deprovision finalizer drops the user AND
    // the databases on ANY claim deletion. So a suspend that observed Missing must FAIL, not succeed —
    // the exact inverse of what a prune-watch would assert.
    seedTenant();
    const reg = new TenantRegistrations(new FakePlatformRepo());
    await reg.commitTenant({ stage: "prod", guid: GUID, registration: entry(), runId: "run_onb" });
    const argo = new FakeMasterArgoReader(); // no scripted statuses ⇒ every member reads Missing
    const steps = makeSuspendTenantDef(ports(reg, { argo })).steps({ tenantId: "tnt_1" });
    await steps[0]!.run(ctx("run_susp", "attest-target", {}, []));
    await steps[1]!.run(ctx("run_susp", "suspend-tenant", {}, []));
    await expect(steps[2]!.run(ctx("run_susp", "watch-off", {}, []))).rejects.toThrow(/did not converge on its off state/);
  });

  it("verify-off refuses a tenant that is FLAGGED suspended but still runs replicas", async () => {
    // Synced/Healthy proves ArgoCD applied the manifests, not that the manifests carry the off state.
    seedTenant();
    const reg = new TenantRegistrations(new FakePlatformRepo());
    await reg.commitTenant({ stage: "prod", guid: GUID, registration: entry(), runId: "run_onb" });
    const argo = new FakeMasterArgoReader();
    argo.setStatuses(renderingMap(FULL_SET, true));
    const steps = makeSuspendTenantDef(ports(reg, { argo, cluster: readerRunning(2) })).steps({ tenantId: "tnt_1" });
    for (const name of ["attest-target", "suspend-tenant", "watch-off"]) {
      await steps.find((s) => s.name === name)!.run(ctx("run_susp", name, {}, []));
    }
    const verify = steps.find((s) => s.name === "verify-off")!;
    await expect(verify.run(ctx("run_susp", "verify-off", {}, []))).rejects.toThrow(/still runs Deployment\/example-auth-backend \(2\/2\)/);
    // The row is untouched: the run failed at its measurement, so nothing claims the tenant is off.
    expect(db.db.select().from(tenants).where(eq(tenants.id, "tnt_1")).get()?.status).toBe("active");
  });

  it("verify-off refuses a MISSING member namespace — a suspend switches off, it never removes one", async () => {
    seedTenant();
    const reg = new TenantRegistrations(new FakePlatformRepo());
    await reg.commitTenant({ stage: "prod", guid: GUID, registration: entry(), runId: "run_onb" });
    const cluster = new FakeClusterReader({
      deployState: { domain: "s1.example", stage: "prod", writtenAt: "x", generation: 1 },
      smoke: { namespaceExists: false, workloads: [], externalSecretsReady: true },
    });
    const verify = makeSuspendTenantDef(ports(reg, { cluster })).steps({ tenantId: "tnt_1" }).find((s) => s.name === "verify-off")!;
    await expect(verify.run(ctx("run_susp", "verify-off", {}, []))).rejects.toThrow(/does not exist/);
  });

  it("measures EVERY member namespace, one per member — never just one", async () => {
    seedTenant({ apps: ["erp", "web"] });
    expect(tenantWatchMembers(db.db, "tnt_1").map((m) => memberNamespace(GUID, m, "prod"))).toEqual([
      "zsjs023ctne0-auth-prod",
      "zsjs023ctne0-jobs-prod",
      "zsjs023ctne0-report-prod",
      "zsjs023ctne0-erp-prod",
      "zsjs023ctne0-web-prod",
    ]);
  });

  it("plans with tenant targetKind, the five steps, and the repo-qualified git-branch + master-kube locks", async () => {
    seedTenant();
    const plan = await makeSuspendTenantDef(ports(new TenantRegistrations(new FakePlatformRepo()))).plan({ tenantId: "tnt_1" }, { db: db.db });
    expect(plan.targetKind).toBe("tenant");
    expect(plan.targetId).toBe("tnt_1");
    expect(plan.steps.map((s) => s.name)).toEqual(["attest-target", "suspend-tenant", "watch-off", "verify-off", "record-suspended"]);
    expect(plan.locks).toEqual([{ resource: "git-branch", key: `deploy@${FAKE_BOOKS_BRANCH}` }, { resource: "master-kube", key: "m" }]);
    expect(plan.requiredSecrets).toEqual([]);
    // The summary says plainly what survives, because a suspend that read as a prune is what makes an
    // operator expect their data gone.
    expect(plan.summary).toContain("prunes nothing");
  });
});

describe("tenant-resume run", () => {
  it("flips the registration back to active, waits for the fan-out to re-sync at the pin, and marks the row active", async () => {
    seedTenant({ status: "suspended", suspended: true });
    const reg = new TenantRegistrations(new FakePlatformRepo());
    await reg.commitTenant({ stage: "prod", guid: GUID, registration: entry({ suspended: true }), runId: "run_onb" });
    const argo = new FakeMasterArgoReader();
    argo.setStatuses(renderingMap(FULL_SET, false));

    const logs: string[] = [];
    await runAll(makeResumeTenantDef(ports(reg, { argo })).steps({ tenantId: "tnt_1" }), "run_res", { tenantId: "tnt_1" }, logs);

    expect((await reg.readTenant("prod", GUID))?.entry.suspended).toBe(false);
    const row = db.db.select().from(tenants).where(eq(tenants.id, "tnt_1")).get();
    expect(row?.status).toBe("active");
    expect(row?.suspended).toBe(false);
    expect(logs.some((l) => l.includes("live again"))).toBe(true);
  });

  it("resume fails when ArgoCD never re-syncs the whole set at the pin", async () => {
    seedTenant({ status: "suspended", suspended: true });
    const reg = new TenantRegistrations(new FakePlatformRepo());
    await reg.commitTenant({ stage: "prod", guid: GUID, registration: entry({ suspended: true }), runId: "run_onb" });
    const argo = new FakeMasterArgoReader();
    // The auth member is Synced but the rest read Missing ⇒ the set never fully converges.
    argo.setStatuses(new Map<string, ArgoAppStatus>([[FULL_SET[0]!, { syncRevision: SHA, targetRevision: null, sync: "Synced", health: "Healthy" }]]));
    const steps = makeResumeTenantDef(ports(reg, { argo })).steps({ tenantId: "tnt_1" });
    await steps[0]!.run(ctx("run_res", "attest-target", {}, []));
    await steps[1]!.run(ctx("run_res", "resume-tenant", {}, []));
    await expect(steps[2]!.run(ctx("run_res", "watch-sync", {}, []))).rejects.toThrow(/did not reach Synced/);
  });
});

describe("the tenant watch waits for the render the flip asked for", () => {
  // The predicate itself is pinned in argo-app-status.test.ts; these prove each run kind asks it.
  for (const kind of ["resume", "suspend"] as const) {
    it(`PLANTED: a ${kind} does not pass while the members still render the state before the flip`, async () => {
      const suspended = kind === "resume";
      seedTenant(suspended ? { status: "suspended", suspended: true } : {});
      const reg = new TenantRegistrations(new FakePlatformRepo());
      await reg.commitTenant({ stage: "prod", guid: GUID, registration: entry({ suspended }), runId: "run_onb" });
      const argo = new FakeMasterArgoReader();
      argo.setStatuses(renderingMap(FULL_SET, suspended));
      const steps = (kind === "resume" ? makeResumeTenantDef : makeSuspendTenantDef)(ports(reg, { argo, cluster: readerRunning(0) })).steps({ tenantId: "tnt_1" });
      for (const step of steps.slice(0, 2)) await step.run(ctx("run_x", step.name, {}, []));
      await expect(steps[2]!.run(ctx("run_x", steps[2]!.name, {}, []))).rejects.toThrow(new RegExp(`do not render suspended=${!suspended}`));
    });
  }
});
