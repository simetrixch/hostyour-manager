import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { tenants } from "../../db/schema/inventory.ts";
import type { ArgoAppStatus } from "../../adapters/kube/port.ts";
import { FakeMasterArgoReader } from "../../adapters/kube/testing/fake.ts";
import { testMembers } from "./tenant-members.fixture.ts";
import { makeTenantSetDemoDef } from "./tenant-demo.run.ts";
import { ctx, db, GUID, params, planCtx, ports, seedClusters, useMemoryDb } from "./add-app.fixture.ts";
import type { TenantOnboardPorts } from "./create-tenant.run.ts";
import type { StepCtx } from "../../executor/types.ts";

useMemoryDb();

function rendering(demo: boolean | undefined): Map<string, ArgoAppStatus> {
  return new Map(["auth", "jobs", "report", "erp"].map((m) => [`${GUID}-${m}-prod`, {
    sync: "Synced", health: "Healthy", syncRevision: null, targetRevision: null,
    syncSources: [{ repoURL: "https://github.com/acme/acme-deploy.git", revision: "abc", path: `charts/example-${m}`, valuesObject: { tenant: demo === undefined ? {} : { demo } } }],
  } as ArgoAppStatus]));
}

/** The Vault side of the demo switch, recorded. Any other seeder call fails the test, the tenant's
 *  crypto entry among them. */
function recordingSeeder() {
  const writes: { stage: string; guid: string; password: string }[] = [];
  const deletes: { stage: string; guid: string }[] = [];
  const seeder = {
    replaceTenantE2ePassword: async (i: { stage: string; guid: string; password: string }) => void writes.push(i),
    deleteTenantE2ePassword: async (i: { stage: string; guid: string }) => void deletes.push(i),
    seedTenantCrypto: async () => { throw new Error("the demo switch never writes the tenant's crypto entry"); },
  } as unknown as NonNullable<TenantOnboardPorts["seeder"]>;
  return { seeder, writes, deletes };
}

async function planned(prt: ReturnType<typeof ports>, demo: boolean) {
  const def = makeTenantSetDemoDef(prt);
  const result = await def.planStream!({ tenantId: "tnt_1", demo }, planCtx());
  if (result.outcome !== "planned") throw new Error("expected a demo plan");
  return { def, p: result.params };
}

describe("standing tenant demo switch", () => {
  it("switches on and off, preserves the whole registration, refreshes Argo and names every live member", async () => {
    seedClusters();
    const argo = new FakeMasterArgoReader({ statuses: rendering(true) });
    const vault = recordingSeeder();
    const prt = ports({ argo, seeder: vault.seeder });
    const before = (await prt.registrations.readTenant("prod", GUID))!.entry;
    const { def, p } = await planned(prt, true);
    // Inventory's members list deliberately lacks erp; the live registration supplies all four.
    expect(p.members).toEqual(["auth", "jobs", "report", "erp"]);
    expect(def.steps(p).map((s) => s.name)).toEqual(["attest-target", "mint-e2e-password", "write-demo", "watch-members"]);
    const logs: string[] = [];
    for (const step of def.steps(p)) await step.run(ctx(params(), step.name, logs));
    expect((await prt.registrations.readTenant("prod", GUID))?.entry).toEqual({ ...before, demo: true });
    expect(argo.operations).toContain("refresh-set:argocd/tenants");
    expect(logs.some((l) => l.includes("auth, jobs, report, erp") && l.includes("rendered"))).toBe(true);
    expect(vault.writes.map(({ stage, guid }) => ({ stage, guid }))).toEqual([{ stage: "prod", guid: GUID }]);
    expect(vault.writes[0]?.password).toMatch(/^[0-9a-f]{64}$/);
    expect(vault.deletes).toEqual([]);
    const off = ports({ registrations: prt.registrations, argo: new FakeMasterArgoReader({ statuses: rendering(undefined) }), seeder: vault.seeder });
    const next = await planned(off, false);
    // The value is taken back only once no member renders demo any more.
    expect(next.def.steps(next.p).map((s) => s.name)).toEqual(["attest-target", "write-demo", "watch-members", "drop-e2e-password"]);
    for (const step of next.def.steps(next.p)) await step.run(ctx(params(), step.name, []));
    expect((await prt.registrations.readTenant("prod", GUID))?.entry).toEqual(before);
    expect(vault.deletes).toEqual([{ stage: "prod", guid: GUID }]);
    expect(vault.writes).toHaveLength(1);
  });

  it("PLANTED DEFECT: every switch on writes a fresh value, and it reaches no log, checkpoint or table", async () => {
    seedClusters();
    const vault = recordingSeeder();
    const prt = ports({ argo: new FakeMasterArgoReader({ statuses: rendering(true) }), seeder: vault.seeder });
    const logs: string[] = [];
    const checkpoints: unknown[] = [];
    const recording = (step: string): StepCtx => ({ ...ctx(params(), step, logs), checkpoint: (c: unknown) => void checkpoints.push(c) });
    for (let i = 0; i < 2; i++) {
      const { def, p } = await planned(prt, true);
      for (const step of def.steps(p)) await step.run(recording(step.name));
    }
    const [first, second] = vault.writes.map((w) => w.password);
    expect(first).not.toBe(second);
    const tables = db.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
    const stored = JSON.stringify(tables.map(({ name }) => db.sqlite.prepare(`SELECT * FROM "${name}"`).all()));
    for (const value of [first!, second!]) {
      expect(logs.filter((line) => line.includes(value))).toEqual([]);
      expect(JSON.stringify(checkpoints)).not.toContain(value);
      expect(stored).not.toContain(value);
    }
  });

  it("PLANTED DEFECT: an undone switch on takes the value back, and leaves it while the tenant stays a demo", async () => {
    seedClusters();
    const vault = recordingSeeder();
    const prt = ports({ argo: new FakeMasterArgoReader({ statuses: rendering(true) }), seeder: vault.seeder });
    const { def, p } = await planned(prt, true);
    for (const name of ["mint-e2e-password", "write-demo"]) await def.steps(p).find((s) => s.name === name)!.run(ctx(params(), name, []));
    const [restore, undo] = def.cleanups!(p);
    expect([restore?.name, undo?.name]).toEqual(["restore-demo", "undo-e2e-password"]);
    await undo!.run(ctx(params(), "undo-e2e-password", []));
    expect(vault.deletes).toEqual([]);
    await restore!.run(ctx(params(), "restore-demo", []));
    await undo!.run(ctx(params(), "undo-e2e-password", []));
    expect(vault.deletes).toEqual([{ stage: "prod", guid: GUID }]);
  });

  it("PLANTED DEFECT: one old-valued member cannot pass with Synced and Healthy status", async () => {
    seedClusters();
    const rows = rendering(true);
    rows.set(`${GUID}-erp-prod`, rendering(false).get(`${GUID}-erp-prod`)!);
    const { def, p } = await planned(ports({ argo: new FakeMasterArgoReader({ statuses: rows }) }), true);
    await def.steps(p).find((s) => s.name === "write-demo")!.run(ctx(params(), "write-demo", []));
    await expect(def.steps(p).find((s) => s.name === "watch-members")!.run(ctx(params(), "watch-members", []))).rejects.toThrow(/not every member renders tenant.demo=true/);
  });

  it("PLANTED DEFECT: demo off cannot pass while one member still renders true", async () => {
    seedClusters();
    const prt = ports({ argo: new FakeMasterArgoReader({ statuses: rendering(true) }) });
    await prt.registrations.setDemo("prod", GUID, true, "run_before");
    const { def, p } = await planned(prt, false);
    await def.steps(p).find((s) => s.name === "write-demo")!.run(ctx(params(), "write-demo", []));
    await expect(def.steps(p).find((s) => s.name === "watch-members")!.run(ctx(params(), "watch-members", []))).rejects.toThrow(/not every member renders tenant.demo=false/);
    await def.cleanups!(p)[0]!.run(ctx(params(), "restore-demo", []));
    expect((await prt.registrations.readTenant("prod", GUID))?.entry.demo).toBe(true);
  });

  it("refuses stale member composition before the demo write, and never overwrites another run on cleanup", async () => {
    seedClusters();
    const prt = ports();
    const { def, p } = await planned(prt, true);
    await prt.registrations.updateTenantApps("prod", GUID, { op: "append", app: "crm", member: testMembers(["crm"])[3]!, runId: "run_added" });
    await expect(def.steps(p).find((s) => s.name === "write-demo")!.run(ctx(params(), "write-demo", []))).rejects.toThrow(/members changed/);
    expect((await prt.registrations.readTenant("prod", GUID))?.entry.demo ?? false).toBe(false);
    const next = await planned(prt, true);
    await next.def.steps(next.p).find((s) => s.name === "write-demo")!.run(ctx(params(), "write-demo", []));
    db.db.update(tenants).set({ lastRunId: "run_other" }).where(eq(tenants.id, "tnt_1")).run();
    await next.def.cleanups!(next.p)[0]!.run(ctx(params(), "restore-demo", []));
    expect((await prt.registrations.readTenant("prod", GUID))?.entry.demo).toBe(true);
  });

  it("refuses a queued stale demo plan but permits its own write retry", async () => {
    seedClusters();
    const prt = ports();
    const { def, p } = await planned(prt, true);
    const write = def.steps(p).find((s) => s.name === "write-demo")!;
    await write.run(ctx(params(), "write-demo", []));
    await write.run(ctx(params(), "write-demo", []));
    db.db.update(tenants).set({ lastRunId: "run_other" }).where(eq(tenants.id, "tnt_1")).run();
    await expect(write.run(ctx(params(), "write-demo", []))).rejects.toThrow(/demo mode changed/);
    await def.cleanups!(p)[0]!.run(ctx(params(), "restore-demo", []));
    expect((await prt.registrations.readTenant("prod", GUID))?.entry.demo).toBe(true);
  });

  it("switches demo when another run changed the tenant but not its demo mode", async () => {
    seedClusters();
    const prt = ports();
    const { def, p } = await planned(prt, true);
    db.db.update(tenants).set({ lastRunId: "run_versions" }).where(eq(tenants.id, "tnt_1")).run();
    await def.steps(p).find((s) => s.name === "write-demo")!.run(ctx(params(), "write-demo", []));
    expect((await prt.registrations.readTenant("prod", GUID))?.entry.demo).toBe(true);
  });

  it("switches demo after another run turned it on and back off, since the flag is as planned", async () => {
    seedClusters();
    const prt = ports();
    const { def, p } = await planned(prt, true);
    await prt.registrations.setDemo("prod", GUID, true, "run_on");
    await prt.registrations.setDemo("prod", GUID, false, "run_off");
    db.db.update(tenants).set({ lastRunId: "run_off" }).where(eq(tenants.id, "tnt_1")).run();
    await def.steps(p).find((s) => s.name === "write-demo")!.run(ctx(params(), "write-demo", []));
    expect((await prt.registrations.readTenant("prod", GUID))?.entry.demo).toBe(true);
  });

  it("retries and undoes a switch after the git commit succeeds but its caller fails", async () => {
    seedClusters();
    const prt = ports();
    const { def, p } = await planned(prt, true);
    const setDemo = prt.registrations.setDemo.bind(prt.registrations);
    let failOnce = true;
    prt.registrations.setDemo = async (...args) => {
      const result = await setDemo(...args);
      if (failOnce) { failOnce = false; throw new Error("process stopped after git commit"); }
      return result;
    };
    const write = def.steps(p).find((s) => s.name === "write-demo")!;
    await expect(write.run(ctx(params(), "write-demo", []))).rejects.toThrow(/process stopped/);
    await write.run(ctx(params(), "write-demo", []));
    await def.cleanups!(p)[0]!.run(ctx(params(), "restore-demo", []));
    expect((await prt.registrations.readTenant("prod", GUID))?.entry.demo).toBeUndefined();
  });

  it("refuses a moved registration while inventory still names the old cluster", async () => {
    seedClusters();
    const prt = ports();
    const { def, p } = await planned(prt, true);
    await prt.registrations.setTenantCluster("prod", GUID, "s2", "run_move");
    await expect(def.steps(p).find((s) => s.name === "write-demo")!.run(ctx(params(), "write-demo", []))).rejects.toThrow(/target or members changed/);
    expect((await prt.registrations.readTenant("prod", GUID))?.entry.demo).toBeUndefined();
  });

  it.each(["provisioning", "offboarded", "purged"] as const)("refuses a %s tenant", async (status) => {
    seedClusters();
    db.db.update(tenants).set({ status }).where(eq(tenants.id, "tnt_1")).run();
    await expect(planned(ports(), true)).rejects.toThrow(/provisioning|removed/);
  });
});
