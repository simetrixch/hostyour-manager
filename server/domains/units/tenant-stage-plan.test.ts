import { describe, expect, it, vi } from "vitest";
import type { Cleanup, StepCtx } from "../../executor/types.ts";
import { tenants } from "../../db/schema/inventory.ts";
import { makeCreateTenantDef, CreateTenantParams, CreateTenantRequest } from "./create-tenant.run.ts";
import { db, GUID, ports, planCtx, seedTenant, useMemoryDb } from "./tenant-refresh-members.fixture.ts";
import { testMembers } from "./tenant-members.fixture.ts";
import { FakePlatformRepo } from "../../adapters/git/testing/fake.ts";
import { TenantRegistrations, tenantRegistrationWrite } from "./tenant-registrations.ts";
import { FakeClusterKubeResolver, FakeClusterReader, FakeMasterArgoReader, FakeMasterProjectWriter } from "../../adapters/kube/testing/fake.ts";
import { FakeObjectStore } from "../../adapters/object-store/testing/fake.ts";
import { fakeTenantSeeder } from "./tenant-seeder.fixture.ts";
import { tenantBucketName, provisionTenantStorage } from "./tenant-storage.ts";
import { renderTenantArgoSync } from "#unit/server/build-rbac.ts";
import { tenantClearSourceJobs } from "./relocation-jobs-tenant.ts";
import { TenantRegistrationSchema } from "../../../shared/tenant.ts";
import { seedQuota } from "#unit/shared/unit-size.ts";
import { Registrations } from "#unit/server/registrations.ts";
import { removeTenantAppsRegistration } from "./tenant-apps-repo-remove.ts";
import { createTenantCleanups } from "./create-tenant-abort.ts";
import { recordDnsWrite } from "../../db/dns-writes.ts";
import { FakeDnsProvider } from "../../adapters/dns/testing/fake.ts";

useMemoryDb();

function context(params: CreateTenantParams, cleanups: Cleanup[] = []): StepCtx {
  return { runId: "run_stages", stepName: "test", db: db.db, params,
    signal: new AbortController().signal, log: () => {}, checkpoint: () => {}, readCheckpoint: () => undefined,
    registerCleanup: (cleanup: Cleanup) => cleanups.push(cleanup),
  } as unknown as StepCtx;
}

function stagePorts() {
  seedTenant();
  const p = ports(testMembers(["erp"]));
  p.resolver = new FakeClusterKubeResolver({ clusterReader: new FakeClusterReader({
    deployState: { domain: "s1.example", stage: "prod", writtenAt: "2026-10-01T00:00:00Z", generation: 1 },
  }), argoReader: new FakeMasterArgoReader(), projectWriter: new FakeMasterProjectWriter(), argoNamespace: "argocd" });
  p.seeder = fakeTenantSeeder();
  p.objectStore = new FakeObjectStore();
  return p;
}

const request = { clusterId: "cls_1", stage: "prod", subdomain: "newtenant", owner: "team-acme", apps: [] };

describe("tenant stages share identity while provisioning independently", () => {
  it("plans all selected stages with one guid on the same machine", async () => {
    const p = stagePorts();
    const result = await makeCreateTenantDef(p).planStream!({ ...request, stages: ["dev", "test", "prod"].map((stage) => ({ stage, clusterId: "cls_1" })) }, planCtx());
    expect(result.outcome).toBe("planned");
    if (result.outcome !== "planned") throw new Error(result.summary);
    const stages = [result.params, ...result.params.additionalStages!];
    expect(stages.map((s) => s.stage)).toEqual(["prod", "test", "dev"]);
    expect(new Set(stages.map((s) => s.guid)).size).toBe(1);
    expect(stages.every((s) => s.clusterId === "cls_1")).toBe(true);
    const steps = makeCreateTenantDef(p).steps(result.params);
    expect(steps[0]!.name).toBe("attest-target");
    expect(new Set(steps.map((s) => s.name)).size).toBe(steps.length);
    const cleanups: Cleanup[] = [];
    for (const stage of stages) await steps.find((step) => step.name === `${stage.stage}-record-provisional`)!.run(context(result.params, cleanups));
    expect(new Set(cleanups.map((cleanup) => cleanup.name)).size).toBe(cleanups.length);
    expect(cleanups.some((cleanup) => cleanup.name.startsWith("test-"))).toBe(true);
    const created: string[] = [];
    const seeder = p.seeder!;
    p.seeder = { ...seeder, seedTenantCrypto: async (input) => { created.push(`${input.stage}/${input.guid}`); return { created: true }; } };
    for (const stage of stages) await makeCreateTenantDef(p).steps(result.params).find((step) => step.name === `${stage.stage}-seed-tenant-crypto`)!.run(context(result.params));
    expect(created).toEqual(stages.map((s) => `${s.stage}/${s.guid}`));
  });

  it("refuses an empty or repeated selection at the request boundary", () => {
    expect(CreateTenantRequest.safeParse({ ...request, stages: [] }).success).toBe(false);
    expect(CreateTenantRequest.safeParse({ ...request, stages: [{ stage: "test", clusterId: "cls_1" }, { stage: "test", clusterId: "cls_1" }] }).success).toBe(false);
  });

  it("adds a stage to the standing guid without replacing the source", async () => {
    const p = stagePorts();
    const source = await p.registrations.readTenant("prod", GUID);
    const result = await makeCreateTenantDef(p).planStream!({ ...request, sourceTenantId: "tnt_1", stage: "test" }, planCtx());
    expect(result.outcome).toBe("planned");
    if (result.outcome !== "planned") throw new Error(result.summary);
    expect(result.params).toMatchObject({ guid: GUID, stage: "test", sourceStage: "prod", seedUsers: false, replaces: [] });
    expect(result.params.members).toEqual(source!.entry.members);
    expect(result.params.appsRepo).toBe(source!.entry.appsRepo);
    expect(result.params.appsImageTag).toBe(source!.entry.appsImageTag);
    expect(makeCreateTenantDef(p).steps(result.params).map((s) => s.name)).not.toContain("test-create-repo");
    expect(await p.registrations.readTenant("prod", GUID)).toEqual(source);
  });

  it("refuses a duplicate stage and source drift before any new-stage row", async () => {
    const p = stagePorts();
    const def = makeCreateTenantDef(p);
    await expect(def.planStream!({ ...request, sourceTenantId: "tnt_1" }, planCtx())).rejects.toThrow(/already has prod/);
    const result = await def.planStream!({ ...request, sourceTenantId: "tnt_1", stage: "test" }, planCtx());
    if (result.outcome !== "planned") throw new Error(result.summary);
    await p.registrations.setDemo("prod", GUID, true, "run_changed");
    await expect(def.steps(result.params)[0]!.run(context(result.params))).rejects.toThrow(/changed after this Add stage plan/);
    expect(db.db.select().from(tenants).all()).toHaveLength(1);
  });

  it("preserves custom website composition while stage-scoping every public host", async () => {
    const p = stagePorts();
    const current = (await p.registrations.readTenant("prod", GUID))!.entry;
    const apps = [{ name: "company", folder: "web", site: "main", domain: "company.example", databases: ["core"] }, { name: "erp", databases: ["core"] }];
    const members = testMembers(apps).map((m) => m.name === "company" ? { ...m, sources: m.sources.map((s) => ({ ...s, values: { ...s.values, site: { domain: "company.example" } } })) } : m);
    const entry = TenantRegistrationSchema.parse({ ...current, apps, members, routing: "path", ownDomain: "show.example", ownDomainRedirects: ["www.show.example"], quota: seedQuota("small") });
    const books = new FakePlatformRepo();
    const write = tenantRegistrationWrite("prod", GUID, entry); books.seed(books.booksBranch, write.path, write.content);
    p.registrations = new TenantRegistrations(books);
    const result = await makeCreateTenantDef(p).planStream!({ ...request, sourceTenantId: "tnt_1", stage: "test" }, planCtx());
    if (result.outcome !== "planned") throw new Error(result.summary);
    expect(result.params.ownDomain).toBe("test.show.example");
    expect(result.params.ownDomainRedirects).toEqual(["www.test.show.example"]);
    expect(result.params.apps[0]!.domain).toBe("test.company.example");
    expect(result.params.members.find((m) => m.name === "company")!.sources[0]!.values["site"]).toEqual({ domain: "test.company.example" });
    expect(result.params.members.map((m) => m.name)).toEqual(members.map((m) => m.name));
  });
});

describe("stage resources cannot reach a sibling", () => {
  it("keeps the shared bundle registered until its last stage is removed", async () => {
    const p = stagePorts();
    const source = (await p.registrations.readTenant("prod", GUID))!.entry;
    const books = new FakePlatformRepo();
    for (const stage of ["prod", "test"] as const) {
      const write = tenantRegistrationWrite(stage, GUID, source); books.seed(books.booksBranch, write.path, write.content);
    }
    p.registrations = new TenantRegistrations(books);
    const buildRegistrations = new Registrations(new FakePlatformRepo());
    const remove = vi.spyOn(buildRegistrations, "removeBuildRegistration").mockResolvedValue({ removed: true });
    const lifecycle = { ...p, buildRegistrations };
    await removeTenantAppsRegistration(context({} as CreateTenantParams), lifecycle, { stage: "test", guid: GUID }, { clear: false });
    expect(remove).not.toHaveBeenCalled();
    await p.registrations.removeTenant("test", GUID, "run_removed");
    await removeTenantAppsRegistration(context({} as CreateTenantParams), lifecycle, { stage: "prod", guid: GUID }, { clear: false });
    expect(remove).toHaveBeenCalledWith(source.appsImage, "run_stages");
  });

  it("an Add stage abort removes only that stage's recorded hosts", async () => {
    const p = stagePorts();
    const dns = new FakeDnsProvider(); p.dns = dns;
    const result = await makeCreateTenantDef(p).planStream!({ ...request, sourceTenantId: "tnt_1", stage: "test" }, planCtx());
    if (result.outcome !== "planned") throw new Error(result.summary);
    for (const stage of ["prod", "test"] as const) {
      const name = `${stage}.company.example`, content = `${stage}.tenant.example`;
      dns.seed(name, "CNAME", content);
      recordDnsWrite(db.db, { name, type: "CNAME", content, act: "inserted", owner: { kind: "tenant", name: GUID, stage }, runId: "run_stages" });
    }
    await createTenantCleanups(p, result.params).find((cleanup) => cleanup.name.endsWith("-remove-stage-hosts"))!.run(context(result.params));
    expect(dns.record("prod.company.example", "CNAME")).toBe("prod.tenant.example");
    expect(dns.record("test.company.example", "CNAME")).toBeUndefined();
  });

  it("keeps the established prod bucket and grants separate non-prod identities", async () => {
    const store = new FakeObjectStore();
    for (const stage of ["dev", "test", "prod"] as const) {
      const result = await provisionTenantStorage(store, { guid: GUID, stage });
      expect(result.bucket.bucket).toBe(tenantBucketName(GUID, stage));
      const grant = renderTenantArgoSync({ guid: GUID, stage, applications: [`${GUID}-auth-${stage}`], argoNamespace: "argocd", units: [] });
      expect(grant.role["metadata"]["name"]).toBe(stage === "prod" ? `${GUID}-argo-sync` : `${GUID}-${stage}-argo-sync`);
    }
  });

  it("every source DB deletion is bounded by guid AND stage", () => {
    const job = tenantClearSourceJobs({ guid: GUID, stage: "test", image: "dbtools" })[0]!;
    expect(job.spec.script).toContain(`grep "^${GUID}_.*_test$"`);
    expect(job.spec.script).not.toContain(`grep "^${GUID}"`);
  });
});
