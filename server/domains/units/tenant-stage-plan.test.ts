import { describe, expect, it, vi } from "vitest";
import type { Cleanup, StepCtx } from "../../executor/types.ts";
import { tenants, tenantApps } from "../../db/schema/inventory.ts";
import { makeCreateTenantDef, CreateTenantParams, CreateTenantRequest } from "./create-tenant.run.ts";
import { db, GUID, planCtx, useMemoryDb } from "./tenant-refresh-members.fixture.ts";
import { stagePorts, request, addRequest } from "./tenant-stage-plan.fixture.ts";
import { testMembers } from "./tenant-members.fixture.ts";
import { FakePlatformRepo } from "../../adapters/git/testing/fake.ts";
import { TenantRegistrations, tenantRegistrationWrite } from "./tenant-registrations.ts";
import { FakeObjectStore } from "../../adapters/object-store/testing/fake.ts";
import { tenantBucketName, provisionTenantStorage } from "./tenant-storage.ts";
import { renderTenantArgoSync } from "#unit/server/build-rbac.ts";
import { tenantClearSourceJobs } from "./relocation-jobs-tenant.ts";
import { TenantRegistrationSchema, type TenantRegistration } from "../../../shared/tenant.ts";
import { seedQuota } from "#unit/shared/unit-size.ts";
import { Registrations } from "#unit/server/registrations.ts";
import { removeTenantAppsRegistration } from "./tenant-apps-repo-remove.ts";
import { createTenantCleanups } from "./create-tenant-abort.ts";
import { recordDnsWrite } from "../../db/dns-writes.ts";
import { FakeDnsProvider } from "../../adapters/dns/testing/fake.ts";
import { and, eq } from "drizzle-orm";
import { FakeHelmRenderer } from "../../adapters/helm/testing/fake.ts";

useMemoryDb();

function context(params: CreateTenantParams, cleanups: Cleanup[] = []): StepCtx {
  return { runId: "run_stages", stepName: "test", db: db.db, params,
    signal: new AbortController().signal, log: () => {}, checkpoint: () => {}, readCheckpoint: () => undefined,
    registerCleanup: (cleanup: Cleanup) => cleanups.push(cleanup),
  } as unknown as StepCtx;
}

async function changeSource(p: ReturnType<typeof stagePorts>, change: Partial<TenantRegistration>): Promise<TenantRegistration> {
  const source = (await p.registrations.readTenant("prod", GUID))!.entry;
  const entry = TenantRegistrationSchema.parse({ ...source, ...change });
  const books = new FakePlatformRepo();
  const write = tenantRegistrationWrite("prod", GUID, entry);
  books.seed(books.booksBranch, write.path, write.content);
  p.registrations = new TenantRegistrations(books);
  return entry;
}

describe("tenant stages share identity while provisioning independently", () => {
  it("plans all selected stages with one guid, TEST on a machine of its own", async () => {
    const p = stagePorts();
    const result = await makeCreateTenantDef(p).planStream!({ ...request, stages: [{ stage: "dev", clusterId: "cls_1" }, { stage: "test", clusterId: "cls_2" }, { stage: "prod", clusterId: "cls_1" }] }, planCtx());
    expect(result.outcome).toBe("planned");
    if (result.outcome !== "planned") throw new Error(result.summary);
    const stages = [result.params, ...result.params.additionalStages!];
    expect(stages.map((s) => s.stage)).toEqual(["prod", "test", "dev"]);
    expect(new Set(stages.map((s) => s.guid)).size).toBe(1);
    expect(stages.map((s) => s.clusterId)).toEqual(["cls_1", "cls_2", "cls_1"]);
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

  it("invites only after every selected stage has been provisioned", async () => {
    const p = stagePorts();
    const def = makeCreateTenantDef(p);
    const result = await def.planStream!({ ...request, stages: [{ stage: "prod", clusterId: "cls_1" }, { stage: "test", clusterId: "cls_2" }] }, planCtx());
    if (result.outcome !== "planned") throw new Error(result.summary);
    const names = def.steps(result.params).map((step) => step.name);
    expect(names.slice(-2)).toEqual(["prod-activate", "test-activate"]);
    expect(names.indexOf("test-record-inventory")).toBeLessThan(names.indexOf("prod-activate"));
  });

  it("aborts a failed stage while preserving a completed sibling", async () => {
    const p = stagePorts();
    const def = makeCreateTenantDef(p);
    const result = await def.planStream!({ ...request, stages: [{ stage: "prod", clusterId: "cls_1" }, { stage: "test", clusterId: "cls_2" }] }, planCtx());
    if (result.outcome !== "planned") throw new Error(result.summary);
    for (const stage of ["prod", "test"]) await def.steps(result.params).find((step) => step.name === `${stage}-record-provisional`)!.run(context(result.params));
    db.db.update(tenants).set({ status: "active" }).where(and(eq(tenants.guid, result.params.guid), eq(tenants.stage, "prod"))).run();
    await expect(def.assertAbortable!(result.params, { db: db.db })).resolves.toBeUndefined();
    const cleanups = def.cleanups!(result.params);
    for (const stage of ["prod", "test"]) await cleanups.find((cleanup) => cleanup.name.startsWith(`${stage}-`) && cleanup.name.endsWith("-record"))!.run(context(result.params));
    expect(db.db.select({ stage: tenants.stage, status: tenants.status }).from(tenants).where(eq(tenants.guid, result.params.guid)).all()).toEqual(expect.arrayContaining([{ stage: "prod", status: "active" }, { stage: "test", status: "offboarded" }]));
  });

  it("adds a stage to the standing guid without replacing the source", async () => {
    const p = stagePorts();
    const source = await p.registrations.readTenant("prod", GUID);
    const result = await makeCreateTenantDef(p).planStream!({ ...addRequest, stage: "test" }, planCtx());
    expect(result.outcome).toBe("planned");
    if (result.outcome !== "planned") throw new Error(result.summary);
    expect(result.params).toMatchObject({ guid: GUID, stage: "test", sourceStage: "prod", seedUsers: false, replaces: [] });
    expect(result.params.members).toEqual(source!.entry.members);
    expect(result.params.appsRepo).toBe(source!.entry.appsRepo);
    expect(result.params.appsImageTag).toBe(source!.entry.appsImageTag);
    const rendered = (p.helm as FakeHelmRenderer).requests[0]!.valuesObject!;
    expect(rendered["tenant"]).toMatchObject({ approvedTags: result.params.approvedTags });
    expect(makeCreateTenantDef(p).steps(result.params).map((s) => s.name)).not.toContain("test-create-repo");
    expect(await p.registrations.readTenant("prod", GUID)).toEqual(source);
  });

  it("plans the added stage at the size the operator chose, not the default", async () => {
    const p = stagePorts();
    const chosen = await makeCreateTenantDef(p).planStream!(CreateTenantRequest.parse({ ...addRequest, stage: "test", size: "medium" }), planCtx());
    if (chosen.outcome !== "planned") throw new Error(chosen.summary);
    expect(chosen.params.size).toBe("medium");
    const unnamed = await makeCreateTenantDef(p).planStream!(CreateTenantRequest.parse({ ...addRequest, stage: "test" }), planCtx());
    if (unnamed.outcome !== "planned") throw new Error(unnamed.summary);
    expect(unnamed.params.size).toBe("small");
  });

  it("refuses a duplicate stage and source drift before any new-stage row", async () => {
    const p = stagePorts();
    const def = makeCreateTenantDef(p);
    await expect(def.planStream!({ ...request, sourceTenantId: "tnt_1" }, planCtx())).rejects.toThrow(/already has prod/);
    const result = await def.planStream!({ ...addRequest, stage: "test" }, planCtx());
    if (result.outcome !== "planned") throw new Error(result.summary);
    await p.registrations.setDemo("prod", GUID, true, "run_changed");
    await expect(def.steps(result.params)[0]!.run(context(result.params))).rejects.toThrow(/changed after this Add stage plan/);
    expect(db.db.select().from(tenants).all()).toHaveLength(1);
  });

  it.each(["approvedTags", "appsImageTag"] as const)("allows source %s release drift while keeping the validated target versions", async (field) => {
    const p = stagePorts();
    const def = makeCreateTenantDef(p);
    const result = await def.planStream!({ ...addRequest, stage: "test" }, planCtx());
    if (result.outcome !== "planned") throw new Error(result.summary);
    const frozen = JSON.stringify(result.params);
    const tag = "0.1.13-stable-20261004101328-befad87";
    const changed = await changeSource(p, field === "approvedTags" ? { approvedTags: { erp: { "example-engine": tag } } } : { appsImageTag: tag });
    // Plant the former whole-registration guard inside a green run, rather than publishing red CI.
    expect(() => { if (JSON.stringify(changed) !== result.params.sourceRegistration) throw new Error("source changed"); }).toThrow("source changed");
    const cleanups: Cleanup[] = [];
    await expect(def.steps(result.params)[0]!.run(context(result.params, cleanups))).resolves.toBeUndefined();
    expect(JSON.stringify(result.params)).toBe(frozen);
    expect((await p.registrations.readTenant("prod", GUID))!.entry).toEqual(changed);
    expect(cleanups).toEqual([]);
    expect(db.db.select().from(tenants).all()).toHaveLength(1);
  });

  it.each([
    { cluster: "s2" }, { subdomain: "different" }, { identityProvider: "jobs" },
    { routing: "path" }, { ownDomain: "different.example" }, { suspended: true }, { quiesced: true },
    { resetNonce: "2" }, { appsRepo: "https://github.com/acme/different.git" },
    { appsImage: "different-bundle" },
  ] satisfies Partial<TenantRegistration>[])("refuses source definition drift %j before creating a stage", async (change) => {
    const p = stagePorts();
    const def = makeCreateTenantDef(p);
    const result = await def.planStream!({ ...addRequest, stage: "test" }, planCtx());
    if (result.outcome !== "planned") throw new Error(result.summary);
    await changeSource(p, change);
    await expect(def.steps(result.params)[0]!.run(context(result.params))).rejects.toThrow(/changed after this Add stage plan/);
    expect(db.db.select().from(tenants).all()).toHaveLength(1);
  });

  it("refuses missing source and changed member or app composition", async () => {
    const p = stagePorts();
    const def = makeCreateTenantDef(p);
    const result = await def.planStream!({ ...addRequest, stage: "test" }, planCtx());
    if (result.outcome !== "planned") throw new Error(result.summary);
    const source = (await p.registrations.readTenant("prod", GUID))!.entry;
    await changeSource(p, { members: source.members.map((m) => ({ ...m, namespaceLabels: { ...m.namespaceLabels, "example/changed": "true" } })) });
    await expect(def.steps(result.params)[0]!.run(context(result.params))).rejects.toThrow(/changed after this Add stage plan/);
    await changeSource(p, { members: source.members, apps: source.apps.map((a) => ({ ...a, seedDemo: true })) });
    await expect(def.steps(result.params)[0]!.run(context(result.params))).rejects.toThrow(/changed after this Add stage plan/);
    vi.spyOn(p.registrations, "readTenant").mockResolvedValue(null);
    await expect(def.steps(result.params)[0]!.run(context(result.params))).rejects.toThrow(/changed after this Add stage plan/);
    expect(db.db.select().from(tenants).all()).toHaveLength(1);
  });

  it("PLANTED INNOCENT: a website without aliases keeps every value, its domain stage-scoped", async () => {
    const p = stagePorts();
    const current = (await p.registrations.readTenant("prod", GUID))!.entry;
    const apps = [{ name: "company", folder: "web", site: "main", domain: "company.example", databases: ["core"] }];
    const values = { site: { domain: "company.example" }, hosts: ["other.example"], none: [], blank: {}, nested: { inner: {} } };
    const members = testMembers(apps).map((m) => m.name === "company" ? { ...m, sources: m.sources.map((s) => ({ ...s, values: { ...s.values, ...values } })) } : m);
    const books = new FakePlatformRepo();
    const write = tenantRegistrationWrite("prod", GUID, TenantRegistrationSchema.parse({ ...current, apps, members, quota: seedQuota("small") })); books.seed(books.booksBranch, write.path, write.content);
    p.registrations = new TenantRegistrations(books);
    const result = await makeCreateTenantDef(p).planStream!({ ...addRequest, stage: "test" }, planCtx());
    if (result.outcome !== "planned") throw new Error(result.summary);
    const source = members.find((m) => m.name === "company")!.sources[0]!.values;
    expect(result.params.members.find((m) => m.name === "company")!.sources[0]!.values).toEqual({ ...source, site: { domain: "test.company.example" } });
  });

  it("PLANTED DEFECT: puts the stage directly before the zone that holds each host, not in front of the whole name", async () => {
    const p = stagePorts();
    (p.dns as FakeDnsProvider).zones = ["example.org"];
    const current = (await p.registrations.readTenant("prod", GUID))!.entry;
    const apps = [{ name: "cycleshop", folder: "web", site: "cycleshop", domain: "cycleshop.show.example.org", databases: ["core"] }];
    const entry = TenantRegistrationSchema.parse({ ...current, apps, members: testMembers(apps), routing: "path", ownDomain: "show.example.org", ownDomainRedirects: ["www.show.example.org"], quota: seedQuota("small") });
    const books = new FakePlatformRepo();
    const write = tenantRegistrationWrite("prod", GUID, entry); books.seed(books.booksBranch, write.path, write.content);
    p.registrations = new TenantRegistrations(books);
    const result = await makeCreateTenantDef(p).planStream!({ ...addRequest, stage: "test" }, planCtx());
    if (result.outcome !== "planned") throw new Error(result.summary);
    expect([result.params.ownDomain, result.params.ownDomainRedirects, result.params.apps[0]!.domain]).toEqual(["show.test.example.org", ["www.show.test.example.org"], "cycleshop.show.test.example.org"]);
  });

  it("PLANTED DEFECT: refuses a stage for a domain whose zone cannot be read, and never takes its last two labels for one", async () => {
    const p = stagePorts();
    const current = (await p.registrations.readTenant("prod", GUID))!.entry;
    const entry = TenantRegistrationSchema.parse({ ...current, routing: "path", ownDomain: "show.example.org", ownDomainRedirects: [], quota: seedQuota("small") });
    const books = new FakePlatformRepo();
    const write = tenantRegistrationWrite("prod", GUID, entry); books.seed(books.booksBranch, write.path, write.content);
    p.registrations = new TenantRegistrations(books);
    const plan = () => makeCreateTenantDef(p).planStream!({ ...addRequest, stage: "test" }, planCtx());
    const unheld = new FakeDnsProvider();
    unheld.unmanaged = ["example.org"];
    p.dns = unheld;
    await expect(plan()).rejects.toThrow(/no zone of this installation's DNS provider holds show\.example\.org, so the zone of show\.example\.org, and with it its host at test, cannot be read/);
    delete p.dns;
    await expect(plan()).rejects.toThrow(/no DNS provider is configured on this manager, so the zone of show\.example\.org, and with it its host at test, cannot be read/);
  });

  it("preserves custom website composition while stage-scoping every public host, and takes no alias domain", async () => {
    const p = stagePorts();
    const current = (await p.registrations.readTenant("prod", GUID))!.entry;
    const apps = [{ name: "company", folder: "web", site: "main", domain: "company.example", aliases: ["company.example.it"], databases: ["core"] }, { name: "erp", databases: ["core"] }];
    // Beside the alias lists, values no alias drop may touch: a list holding an alias among others,
    // a list without one, an empty list, an empty map and a map holding one.
    const INNOCENT = { mixed: ["company.example.it", "other.example"], plain: ["other.example"], none: [], blank: {}, nested: { inner: {} } };
    const members = testMembers(apps).map((m) => m.name === "company" ? { ...m, sources: m.sources.map((s) => ({ ...s, values: { ...s.values, ...INNOCENT, site: { domain: "company.example", aliases: ["company.example.it"] }, redirect: { hosts: ["company.example.it"] } } })) } : m);
    const entry = TenantRegistrationSchema.parse({ ...current, apps, members, routing: "path", ownDomain: "show.example", ownDomainRedirects: ["www.show.example"], ownDomainAliases: ["show.example.it"], quota: seedQuota("small") });
    const books = new FakePlatformRepo();
    const write = tenantRegistrationWrite("prod", GUID, entry); books.seed(books.booksBranch, write.path, write.content);
    p.registrations = new TenantRegistrations(books);
    const result = await makeCreateTenantDef(p).planStream!({ ...addRequest, stage: "test" }, planCtx());
    if (result.outcome !== "planned") throw new Error(result.summary);
    expect(result.params.ownDomain).toBe("test.show.example");
    expect(result.params.ownDomainRedirects).toEqual(["www.test.show.example"]);
    expect(result.params.apps[0]!.domain).toBe("test.company.example");
    // An alias is another domain of the same site, held by the stage it was given on: the new stage
    // answers at none, of the websites or the own domain, until it is given its own.
    expect(result.params.apps[0]).not.toHaveProperty("aliases");
    expect(result.params).not.toHaveProperty("ownDomainAliases");
    expect(result.params.members.find((m) => m.name === "company")!.sources[0]!.values).not.toHaveProperty("redirect");
    expect(result.params.members.find((m) => m.name === "company")!.sources[0]!.values["site"]).toEqual({ domain: "test.company.example" });
    expect(result.params.members.find((m) => m.name === "company")!.sources[0]!.values).toMatchObject(INNOCENT);
    expect(result.params.members.map((m) => m.name)).toEqual(members.map((m) => m.name));
    // Every host a website answers at gets its record, www. included, as Add website writes them; the
    // abort takes them all back.
    const cleanups: Cleanup[] = [];
    const steps = makeCreateTenantDef(p).steps(result.params);
    await steps.find((step) => step.name.endsWith("record-provisional"))!.run(context(result.params, cleanups));
    await steps.find((step) => step.name.endsWith("provision-stage-hosts"))!.run(context(result.params, cleanups));
    const hosts = ["test.show.example", "www.test.show.example", "test.company.example", "www.test.company.example"];
    const dns = p.dns as FakeDnsProvider;
    expect(hosts.map((h) => dns.record(h, "CNAME") !== undefined)).toEqual([true, true, true, true]);
    for (const cleanup of [...createTenantCleanups(p, result.params)].reverse()) await cleanup.run(context(result.params));
    expect(hosts.map((h) => dns.record(h, "CNAME"))).toEqual([undefined, undefined, undefined, undefined]);
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
    const result = await makeCreateTenantDef(p).planStream!({ ...addRequest, stage: "test" }, planCtx());
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

describe("native purged-stage recovery", () => {
  function target(status: "purged" | "active" | "suspended" | "provisioning" | "offboarded" = "purged") {
    const source = db.db.select().from(tenants).where(eq(tenants.id, "tnt_1")).get()!;
    db.db.insert(tenants).values({ ...source, id: "tnt_purged", stage: "test", status, lastRunId: "run_purged" }).run();
    db.db.insert(tenantApps).values({ id: "tna_purged", tenantId: "tnt_purged", name: "erp", status: "purged", lastRunId: "run_purged" }).run();
  }
  const add = { ...addRequest, stage: "test" };

  it("plans a fresh stage after native purge while preserving its inventory identity", async () => {
    const p = stagePorts(); target();
    const def = makeCreateTenantDef(p);
    const result = await def.planStream!(add, planCtx());
    expect(result.outcome).toBe("planned");
    if (result.outcome !== "planned") throw new Error(result.summary);
    await def.steps(result.params)[0]!.run(context(result.params));
    await def.steps(result.params).find((step) => step.name === "test-record-provisional")!.run(context(result.params));
    expect(db.db.select().from(tenants).where(eq(tenants.id, "tnt_purged")).get()).toMatchObject({ status: "provisioning", lastRunId: "run_stages" });
    expect(db.db.select().from(tenantApps).where(eq(tenantApps.id, "tna_purged")).get()).toMatchObject({ status: "provisioning", lastRunId: "run_stages" });
    expect(db.db.select().from(tenants).where(eq(tenants.id, "tnt_1")).get()).toMatchObject({ status: "active", stage: "prod" });
  });

  it("attests a purged history row that appears after the fresh plan", async () => {
    const p = stagePorts(); const def = makeCreateTenantDef(p);
    const result = await def.planStream!(add, planCtx());
    if (result.outcome !== "planned") throw new Error(result.summary);
    target();
    await expect(def.steps(result.params)[0]!.run(context(result.params))).resolves.toBeUndefined();
  });

  it("restores only its own purged lifecycle at provisional recording", async () => {
    const p = stagePorts(); const def = makeCreateTenantDef(p);
    const result = await def.planStream!(add, planCtx());
    if (result.outcome !== "planned") throw new Error(result.summary);
    target();
    await def.steps(result.params).find((step) => step.name === "test-record-provisional")!.run(context(result.params));
    expect(db.db.select().from(tenants).where(eq(tenants.id, "tnt_purged")).get()).toMatchObject({ status: "provisioning", suspended: false });
    expect(db.db.select().from(tenantApps).where(eq(tenantApps.id, "tna_purged")).get()).toMatchObject({ status: "provisioning" });
  });

  it.each(["active", "suspended", "provisioning", "offboarded"] as const)("refuses %s history both at planning and at attestation", async (status) => {
    const p = stagePorts(); const def = makeCreateTenantDef(p);
    const result = await def.planStream!(add, planCtx());
    if (result.outcome !== "planned") throw new Error(result.summary);
    target(status);
    await expect(def.planStream!(add, planCtx())).rejects.toThrow("already has a test stage");
    await expect(def.steps(result.params)[0]!.run(context(result.params))).rejects.toThrow("no standing stage is replaced");
  });

  it.each(["present", "unreadable"] as const)("refuses a purged stage with a %s GitOps pointer", async (pointer) => {
    const p = stagePorts(); const def = makeCreateTenantDef(p);
    const result = await def.planStream!(add, planCtx());
    if (result.outcome !== "planned") throw new Error(result.summary);
    target();
    const source = (await p.registrations.readTenant("prod", GUID))!.entry;
    const books = new FakePlatformRepo();
    for (const stage of ["prod", "test"] as const) {
      const write = tenantRegistrationWrite(stage, GUID, source);
      books.seed(books.booksBranch, write.path, stage === "test" && pointer === "unreadable" ? "invalid: [" : write.content);
    }
    p.registrations = new TenantRegistrations(books);
    await expect(def.planStream!(add, planCtx())).rejects.toThrow("already has a test stage");
    await expect(def.steps(result.params)[0]!.run(context(result.params))).rejects.toThrow("no standing stage is replaced");
  });
});
