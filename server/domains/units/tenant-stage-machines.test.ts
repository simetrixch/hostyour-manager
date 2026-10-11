import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { tenants } from "../../db/schema/inventory.ts";
import { makeCreateTenantDef, CreateTenantRequest } from "./create-tenant.run.ts";
import { db, GUID, planCtx, useMemoryDb } from "./tenant-refresh-members.fixture.ts";
import { stagePorts, request } from "./tenant-stage-plan.fixture.ts";
import { FakePlatformRepo } from "../../adapters/git/testing/fake.ts";
import { TenantRegistrations, tenantRegistrationWrite } from "./tenant-registrations.ts";
import { FakeHelmRenderer } from "../../adapters/helm/testing/fake.ts";

useMemoryDb();

describe("TEST stays off the machine of its tenant's PROD", () => {
  const planAdd = (p: ReturnType<typeof stagePorts>, over: Record<string, unknown>) =>
    makeCreateTenantDef(p).planStream!(CreateTenantRequest.parse({ ...request, sourceTenantId: "tnt_1", ...over }), planCtx());
  const planCreate = (p: ReturnType<typeof stagePorts>, stages: { stage: string; clusterId: string }[]) =>
    makeCreateTenantDef(p).planStream!(CreateTenantRequest.parse({ ...request, stages }), planCtx());

  it("PLANTED DEFECT: refuses Add stage of TEST on PROD's machine at plan, naming the tenant, both stages and the machine", async () => {
    const p = stagePorts();
    await expect(planAdd(p, { stage: "test", clusterId: "cls_1" })).rejects.toThrow(`tenant ${GUID} test cannot stand on s1.example: its prod stage stands there, and TEST and PROD cannot share a machine`);
    expect((p.helm as FakeHelmRenderer).requests).toHaveLength(0);
    expect(db.db.select().from(tenants).all()).toHaveLength(1);
  });

  it.each([["dev", "cls_1"], ["test", "cls_2"]])("PLANTED INNOCENT: Add stage of %s on %s is planned beside PROD on cls_1", async (stage, clusterId) => {
    const result = await planAdd(stagePorts(), { stage, clusterId });
    expect(result.outcome).toBe("planned");
  });

  it("PLANTED INNOCENT: a purged PROD on the machine does not block TEST there, an active one does", async () => {
    const p = stagePorts();
    const entry = (await p.registrations.readTenant("prod", GUID))!.entry;
    const books = new FakePlatformRepo();
    const write = tenantRegistrationWrite("dev", GUID, entry); books.seed(books.booksBranch, write.path, write.content);
    p.registrations = new TenantRegistrations(books);
    const prod = db.db.select().from(tenants).where(eq(tenants.id, "tnt_1")).get()!;
    db.db.insert(tenants).values({ ...prod, id: "tnt_dev", stage: "dev" }).run();
    db.db.update(tenants).set({ clusterId: "cls_2" }).where(eq(tenants.id, "tnt_1")).run();
    const addTest = () => makeCreateTenantDef(p).planStream!(CreateTenantRequest.parse({ ...request, sourceTenantId: "tnt_dev", stage: "test", clusterId: "cls_2" }), planCtx());
    await expect(addTest()).rejects.toThrow("its prod stage stands there");
    db.db.update(tenants).set({ status: "purged" }).where(eq(tenants.id, "tnt_1")).run();
    expect((await addTest()).outcome).toBe("planned");
  });

  it("PLANTED DEFECT: refuses Create with TEST and PROD on one machine before any stage is planned", async () => {
    const p = stagePorts();
    await expect(planCreate(p, [{ stage: "test", clusterId: "cls_2" }, { stage: "prod", clusterId: "cls_2" }])).rejects.toThrow("prod and test of one tenant cannot stand on s2.example: TEST and PROD cannot share a machine");
    expect((p.helm as FakeHelmRenderer).requests).toHaveLength(0);
  });

  it("PLANTED INNOCENT: Create with TEST and PROD on two machines, or DEV with either on one, is planned", async () => {
    const p = stagePorts();
    expect((await planCreate(p, [{ stage: "test", clusterId: "cls_2" }, { stage: "prod", clusterId: "cls_1" }])).outcome).toBe("planned");
    expect((await planCreate(p, [{ stage: "dev", clusterId: "cls_1" }, { stage: "prod", clusterId: "cls_1" }])).outcome).toBe("planned");
    expect((await planCreate(p, [{ stage: "dev", clusterId: "cls_2" }, { stage: "test", clusterId: "cls_2" }])).outcome).toBe("planned");
  });
});
