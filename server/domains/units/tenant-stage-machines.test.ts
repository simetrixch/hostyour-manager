import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { tenants } from "../../db/schema/inventory.ts";
import { makeCreateTenantDef, CreateTenantRequest } from "./create-tenant.run.ts";
import { db, GUID, planCtx, useMemoryDb } from "./tenant-refresh-members.fixture.ts";
import { stagePorts, request } from "./tenant-stage-plan.fixture.ts";
import { FakePlatformRepo } from "../../adapters/git/testing/fake.ts";
import { TenantRegistrations, tenantRegistrationWrite } from "./tenant-registrations.ts";
import { FakeHelmRenderer } from "../../adapters/helm/testing/fake.ts";
import type { Stage } from "../../../shared/enums.ts";

useMemoryDb();

// The machines of the fixture: s1 (cls_1) serves prod, s2 (cls_2) test, s3 (cls_3) dev. The tenant
// tnt_1 stands at prod on s1.
describe("a tenant stage stands only on a machine that serves its stage", () => {
  const planAdd = (p: ReturnType<typeof stagePorts>, over: Record<string, unknown>) =>
    makeCreateTenantDef(p).planStream!(CreateTenantRequest.parse({ ...request, sourceTenantId: "tnt_1", ...over }), planCtx());
  const planCreate = (p: ReturnType<typeof stagePorts>, stages: { stage: string; clusterId: string }[]) =>
    makeCreateTenantDef(p).planStream!(CreateTenantRequest.parse({ ...request, stages }), planCtx());
  /** The tenant stands at `stage` on `clusterId` alone, registered there, as the source of an Add stage. */
  const sourceAt = async (p: ReturnType<typeof stagePorts>, stage: Stage, clusterId: string) => {
    const entry = (await p.registrations.readTenant("prod", GUID))!.entry;
    const books = new FakePlatformRepo();
    const write = tenantRegistrationWrite(stage, GUID, entry);
    books.seed(books.booksBranch, write.path, write.content);
    p.registrations = new TenantRegistrations(books);
    db.db.update(tenants).set({ stage, clusterId }).where(eq(tenants.id, "tnt_1")).run();
  };

  it("PLANTED DEFECT: refuses Add stage of TEST on a PROD machine at plan, naming the machine and both stages", async () => {
    const p = stagePorts();
    await expect(planAdd(p, { stage: "test", clusterId: "cls_1" })).rejects.toThrow("machine s1 (s1.example) serves prod environments only and cannot take a test environment");
    expect((p.helm as FakeHelmRenderer).requests).toHaveLength(0);
    expect(db.db.select().from(tenants).all()).toHaveLength(1);
  });

  it("PLANTED DEFECT: refuses Add stage of PROD on a TEST machine at plan", async () => {
    const p = stagePorts();
    await sourceAt(p, "test", "cls_2");
    await expect(planAdd(p, { stage: "prod", clusterId: "cls_2" })).rejects.toThrow("machine s2 (s2.example) serves test environments only and cannot take a prod environment");
    expect((p.helm as FakeHelmRenderer).requests).toHaveLength(0);
  });

  it.each([["test", "cls_2"], ["dev", "cls_3"]])("PLANTED INNOCENT: Add stage of %s on %s, a machine of its own stage, is planned", async (stage, clusterId) => {
    expect((await planAdd(stagePorts(), { stage, clusterId })).outcome).toBe("planned");
  });

  it("PLANTED INNOCENT: Add stage of PROD from a TEST tenant is planned on a PROD machine", async () => {
    const p = stagePorts();
    await sourceAt(p, "test", "cls_2");
    expect((await planAdd(p, { stage: "prod", clusterId: "cls_1" })).outcome).toBe("planned");
  });

  it("PLANTED DEFECT: refuses Create of PROD on a TEST machine, and of TEST on a PROD machine, before any stage is planned", async () => {
    const p = stagePorts();
    await expect(planCreate(p, [{ stage: "test", clusterId: "cls_2" }, { stage: "prod", clusterId: "cls_2" }])).rejects.toThrow("machine s2 (s2.example) serves test environments only and cannot take a prod environment");
    await expect(planCreate(p, [{ stage: "test", clusterId: "cls_1" }, { stage: "prod", clusterId: "cls_1" }])).rejects.toThrow("machine s1 (s1.example) serves prod environments only and cannot take a test environment");
    expect((p.helm as FakeHelmRenderer).requests).toHaveLength(0);
  });

  it("PLANTED INNOCENT: Create with every stage on a machine of its own stage is planned", async () => {
    expect((await planCreate(stagePorts(), [{ stage: "dev", clusterId: "cls_3" }, { stage: "test", clusterId: "cls_2" }, { stage: "prod", clusterId: "cls_1" }])).outcome).toBe("planned");
  });
});
