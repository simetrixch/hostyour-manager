import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { tenants } from "../../db/schema/inventory.ts";
import type { ArgoAppStatus } from "../../adapters/kube/port.ts";
import { FakeMasterArgoReader } from "../../adapters/kube/testing/fake.ts";
import { FakePlatformRepo } from "../../adapters/git/testing/fake.ts";
import { FakeDnsProvider } from "../../adapters/dns/testing/fake.ts";
import { testMembers } from "./tenant-members.fixture.ts";
import { makeAddAppDef } from "./add-app.run.ts";
import { revertAppendCleanup } from "./add-app-abort.ts";
import { makeTenantSetWebsiteMainDef } from "./tenant-website-main.run.ts";
import { ctx, db, GUID, params, planCtx, ports, seedClusters, useMemoryDb } from "./add-app.fixture.ts";
import { WEBSITE_APPS, seedWebsiteTenant, tenantWith, websitePorts } from "./tenant-website.fixture.ts";

// The tenant's main website: the one website of a tenant marked `main`, served at / of its domain. The
// mark moves with a deploy, an abort of that deploy, a remove and the run that marks a deployed website,
// and each of them leaves at most one holder.

useMemoryDb();

const site = (name: string, siteId: string, over: Record<string, string | boolean> = {}) => ({ name, folder: "web", site: siteId, domain: `${name}.example.ch`, ...over });
const SHOP = site("shop-site", "shop", { main: true });
const BLOG = site("blog-site", "blog");
const DOCS = site("docs-site", "docs");
/** The apps of the registration that carry the mark. */
const holders = async (registrations: ReturnType<typeof tenantWith>): Promise<string[]> =>
  (await registrations.readTenant("prod", GUID))!.entry.apps.filter((a) => a.main).map((a) => a.name);
const appended = (registrations: ReturnType<typeof tenantWith>, app: string, main: boolean) =>
  registrations.updateTenantApps("prod", GUID, { op: "append", app, website: { folder: "web", site: "extra", domain: "extra.example.ch", ...(main ? { main: true as const } : {}) }, member: testMembers([app])[3]!, runId: "run_add" });

describe("the main website in the registration", () => {
  it("an append marked main takes the mark from the other holder, in the same commit", async () => {
    const repo = new FakePlatformRepo();
    const registrations = tenantWith([SHOP, BLOG], undefined, repo);
    await appended(registrations, "extra-site", true);
    expect(await holders(registrations)).toEqual(["extra-site"]);
    expect(repo.commits).toHaveLength(1);
  });

  it("an append not marked main leaves the holder where it is and writes no `main: false`", async () => {
    const registrations = tenantWith([SHOP, BLOG]);
    await appended(registrations, "extra-site", false);
    expect(await holders(registrations)).toEqual(["shop-site"]);
    expect((await registrations.readTenant("prod", GUID))!.entry.apps.find((a) => a.name === "extra-site")).not.toHaveProperty("main");
  });

  it("a drop of the main website hands the mark to the first website left, and to none where none is left", async () => {
    const registrations = tenantWith([BLOG, SHOP, DOCS]);
    await registrations.updateTenantApps("prod", GUID, { op: "drop", app: "shop-site", runId: "run_rm" });
    expect(await holders(registrations)).toEqual(["blog-site"]);
    await registrations.updateTenantApps("prod", GUID, { op: "drop", app: "blog-site", runId: "run_rm" });
    await registrations.updateTenantApps("prod", GUID, { op: "drop", app: "docs-site", runId: "run_rm" });
    expect(await holders(registrations)).toEqual([]);
  });

  it("a drop of a website that is not the main one leaves the mark alone", async () => {
    const registrations = tenantWith([BLOG, SHOP]);
    await registrations.updateTenantApps("prod", GUID, { op: "drop", app: "blog-site", runId: "run_rm" });
    expect(await holders(registrations)).toEqual(["shop-site"]);
  });

  it("setWebsiteMain moves the mark in one commit, writes the same entry for the mark that stands, and refuses an app that is no website", async () => {
    const repo = new FakePlatformRepo();
    const registrations = tenantWith([SHOP, BLOG], undefined, repo);
    await registrations.setWebsiteMain("prod", GUID, "blog-site", "run_set");
    expect(await holders(registrations)).toEqual(["blog-site"]);
    expect(repo.commits).toHaveLength(1);
    const standing = (await registrations.readTenant("prod", GUID))!.entry;
    await registrations.setWebsiteMain("prod", GUID, "blog-site", "run_set");
    expect((await registrations.readTenant("prod", GUID))!.entry).toEqual(standing);
    await expect(registrations.setWebsiteMain("prod", GUID, "erp", "run_set")).rejects.toThrow(/is no website/);
    await registrations.setWebsiteMain("prod", GUID, null, "run_set");
    expect(await holders(registrations)).toEqual([]);
  });
});

describe("add-app for a website marked main", () => {
  const MAIN = { tenantId: "tnt_1", app: "main", folder: "web", site: "main", domain: "example.ch", main: true };
  const planAdd = async (registrations: ReturnType<typeof tenantWith>, request: Record<string, unknown>) => {
    const result = await makeAddAppDef(websitePorts({ registrations, dns: new FakeDnsProvider() })).planStream!(request, planCtx());
    if (result.outcome !== "planned") throw new Error("the website was not planned");
    return result;
  };

  it("plans the mark, the website that holds it today and the summary that names the one that loses it", async () => {
    seedWebsiteTenant();
    const result = await planAdd(tenantWith([SHOP, BLOG]), MAIN);
    expect(result.params.website).toEqual({ folder: "web", site: "main", domain: "example.ch", main: true });
    expect(result.params.previousMain).toBe("shop-site");
    expect(result.plan.summary).toContain("It becomes the main website of the tenant, served at / of the tenant's domain, and website shop-site stops being it.");
  });

  it("plans no mark, and no previous holder to give back, for a website not marked", async () => {
    seedWebsiteTenant();
    const result = await planAdd(tenantWith([SHOP]), { ...MAIN, main: false });
    expect(result.params.website).toEqual({ folder: "web", site: "main", domain: "example.ch" });
    expect(result.plan.summary).not.toContain("main website");
  });

  it("refuses the mark on a request that names no website", async () => {
    seedWebsiteTenant();
    await expect(makeAddAppDef(ports({}, WEBSITE_APPS)).planStream!({ tenantId: "tnt_1", app: "crm", main: true }, planCtx())).rejects.toThrow(/only a website can be the main website/);
  });

  it("an abort of the deploy gives the mark back to the website that held it, not to the first website left", async () => {
    seedClusters();
    const registrations = tenantWith([BLOG, SHOP]);
    await appended(registrations, "extra-site", true);
    expect(await holders(registrations)).toEqual(["extra-site"]);
    const p = params({ app: "extra-site", previousMain: "shop-site" });
    await revertAppendCleanup(ports({ registrations }, WEBSITE_APPS), p).run(ctx(p, "revert-app-append", []));
    expect(await holders(registrations)).toEqual(["shop-site"]);
  });

  it("an abort of a deploy that held no mark before leaves the tenant without one", async () => {
    seedClusters();
    const registrations = tenantWith([BLOG]);
    await appended(registrations, "extra-site", true);
    const p = params({ app: "extra-site", previousMain: null });
    await revertAppendCleanup(ports({ registrations }, WEBSITE_APPS), p).run(ctx(p, "revert-app-append", []));
    expect(await holders(registrations)).toEqual([]);
  });
});

describe("tenant-set-website-main", () => {
  const MARK = { tenantId: "tnt_1", app: "blog-site" };
  /** Every member renders the apps as the registration carries them, the way the member charts read `tenant.apps`. */
  const rendering = (marked: string | null, members = ["auth", "jobs", "report", "erp", "shop-site", "blog-site"]): Map<string, ArgoAppStatus> =>
    new Map(members.map((m) => [`${GUID}-${m}-prod`, {
      sync: "Synced", health: "Healthy", syncRevision: null, targetRevision: null,
      syncSources: [{ repoURL: "https://github.com/acme/acme-deploy.git", revision: "abc", path: `charts/example-${m}`, valuesObject: { tenant: { apps: ["shop-site", "blog-site"].map((name) => ({ name, ...(name === marked ? { main: true } : {}) })) } } }],
    } as ArgoAppStatus]));
  async function planned(prt: ReturnType<typeof ports>, request: Record<string, unknown> = MARK) {
    const def = makeTenantSetWebsiteMainDef(prt);
    const result = await def.planStream!(request, planCtx());
    if (result.outcome !== "planned") throw new Error("expected a main website plan");
    return { def, p: result.params };
  }
  const step = (def: ReturnType<typeof makeTenantSetWebsiteMainDef>, p: Parameters<typeof def.steps>[0], name: string) => def.steps(p).find((s) => s.name === name)!;

  it("plans the website that holds the mark today and names it in the summary", async () => {
    seedClusters();
    const prt = ports({ registrations: tenantWith([SHOP, BLOG]) });
    const result = await makeTenantSetWebsiteMainDef(prt).planStream!(MARK, planCtx());
    expect(result.outcome === "planned" && result.params).toMatchObject({ app: "blog-site", previous: "shop-site", members: ["auth", "jobs", "report", "erp", "shop-site", "blog-site"] });
    expect(result.outcome === "planned" && result.plan.summary).toContain('Website "shop-site" stops being it');
    expect(result.outcome === "planned" && result.plan.steps.map((s) => s.name)).toEqual(["attest-target", "write-main-website", "watch-members"]);
  });

  it("refuses an app that is no website, the website that is the main one already, and a tenant that cannot render it", async () => {
    seedClusters();
    const prt = ports({ registrations: tenantWith([SHOP, BLOG]) });
    await expect(planned(prt, { ...MARK, app: "erp" })).rejects.toThrow(/is no website/);
    await expect(planned(prt, { ...MARK, app: "shop-site" })).rejects.toThrow(/already the main website/);
    for (const status of ["provisioning", "offboarded"] as const) {
      db.db.update(tenants).set({ status }).where(eq(tenants.id, "tnt_1")).run();
      await expect(planned(prt)).rejects.toThrow(/provisioning|removed/);
    }
  });

  it("writes the mark in one commit, refreshes the members and passes once every member renders it", async () => {
    seedClusters();
    const argo = new FakeMasterArgoReader({ statuses: rendering("blog-site") });
    const prt = ports({ registrations: tenantWith([SHOP, BLOG]), argo });
    const { def, p } = await planned(prt);
    const logs: string[] = [];
    for (const s of def.steps(p)) await s.run(ctx(params(), s.name, logs));
    expect(await holders(prt.registrations)).toEqual(["blog-site"]);
    expect(argo.operations).toContain("refresh-set:argocd/tenants");
    expect(logs.some((l) => l.includes("blog-site rendered as the main website"))).toBe(true);
  });

  it("fails the watch while one member still renders the previous holder, or two holders", async () => {
    seedClusters();
    const statuses = rendering("blog-site");
    statuses.set(`${GUID}-erp-prod`, rendering("shop-site").get(`${GUID}-erp-prod`)!);
    const { def, p } = await planned(ports({ registrations: tenantWith([SHOP, BLOG]), argo: new FakeMasterArgoReader({ statuses }) }));
    await step(def, p, "write-main-website").run(ctx(params(), "write-main-website", []));
    await expect(step(def, p, "watch-members").run(ctx(params(), "watch-members", []))).rejects.toThrow(/not every member renders blog-site as the only main website/);
  });

  it("gives the mark back to the previous holder on a cleanup, while this run's write stands", async () => {
    seedClusters();
    const prt = ports({ registrations: tenantWith([SHOP, BLOG]) });
    const { def, p } = await planned(prt);
    await step(def, p, "write-main-website").run(ctx(params(), "write-main-website", []));
    expect(await holders(prt.registrations)).toEqual(["blog-site"]);
    await def.cleanups!(p)[0]!.run(ctx(params(), "restore-main-website", []));
    expect(await holders(prt.registrations)).toEqual(["shop-site"]);
  });

  it("leaves the registration alone on a cleanup once another run has written the mark", async () => {
    seedClusters();
    const prt = ports({ registrations: tenantWith([SHOP, BLOG]) });
    const { def, p } = await planned(prt);
    await step(def, p, "write-main-website").run(ctx(params(), "write-main-website", []));
    db.db.update(tenants).set({ lastRunId: "run_other" }).where(eq(tenants.id, "tnt_1")).run();
    await def.cleanups!(p)[0]!.run(ctx(params(), "restore-main-website", []));
    expect(await holders(prt.registrations)).toEqual(["blog-site"]);
  });

  it("refuses a cleanup once the previous holder was removed since the plan: the members changed, and the run's mark stays", async () => {
    seedClusters();
    const prt = ports({ registrations: tenantWith([SHOP, BLOG]) });
    const { def, p } = await planned(prt);
    await step(def, p, "write-main-website").run(ctx(params(), "write-main-website", []));
    await prt.registrations.updateTenantApps("prod", GUID, { op: "drop", app: "shop-site", runId: "run_rm" });
    await expect(def.cleanups!(p)[0]!.run(ctx(params(), "restore-main-website", []))).rejects.toThrow(/target or members changed/);
    expect(await holders(prt.registrations)).toEqual(["blog-site"]);
  });

  it("writes the mark when another run changed the tenant but not its main website", async () => {
    seedClusters();
    const prt = ports({ registrations: tenantWith([SHOP, BLOG]) });
    const { def, p } = await planned(prt);
    db.db.update(tenants).set({ lastRunId: "run_versions" }).where(eq(tenants.id, "tnt_1")).run();
    await step(def, p, "write-main-website").run(ctx(params(), "write-main-website", []));
    expect(await holders(prt.registrations)).toEqual(["blog-site"]);
  });

  it("refuses a queued plan after another run moved the mark, but retries its own write", async () => {
    seedClusters();
    const prt = ports({ registrations: tenantWith([SHOP, BLOG]) });
    const { def, p } = await planned(prt);
    const write = step(def, p, "write-main-website");
    await write.run(ctx(params(), "write-main-website", []));
    await write.run(ctx(params(), "write-main-website", []));
    db.db.update(tenants).set({ lastRunId: "run_other" }).where(eq(tenants.id, "tnt_1")).run();
    await expect(write.run(ctx(params(), "write-main-website", []))).rejects.toThrow(/main website changed since this change was planned/);
  });
});
