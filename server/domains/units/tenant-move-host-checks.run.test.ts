import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { FakeDnsProvider } from "../../adapters/dns/testing/fake.ts";
import { FakePlatformRepo } from "../../adapters/git/testing/fake.ts";
import { clusters, servers, tenants } from "../../db/schema/inventory.ts";
import { TenantRegistrationSchema } from "../../../shared/tenant.ts";
import { seedQuota } from "#unit/shared/unit-size.ts";
import { makeTenantSetOwnDomainDef } from "./tenant-own-domain.run.ts";
import { makeTenantSetWebsiteDomainDef } from "./tenant-website-domain.run.ts";
import { TenantRegistrations, tenantRegistrationWrite } from "./tenant-registrations.ts";
import { testMembers, TEST_BUNDLE } from "./tenant-members.fixture.ts";
import { GUID, db, planCtx, ports, useMemoryDb } from "./add-app.fixture.ts";
import { WEBSITE_APPS, seedWebsiteTenant } from "./tenant-website.fixture.ts";

// The host checks of a move judge only what it claims now: the domain it moves to and an alias it
// adds. The name it leaves, kept as an alias until a later run drops it, the tenant already holds,
// and the same tenant at another stage is no reason to refuse it.

useMemoryDb();

function at(own: string, apps: { name: string; site: string; domain: string; aliases?: string[] }[], ownDomainAliases: string[] = []): TenantRegistrations {
  const repo = new FakePlatformRepo();
  const all = [{ name: "erp" }, ...apps.map((a) => ({ folder: "web", ...a }))];
  const registration = TenantRegistrationSchema.parse({
    cluster: "s1", subdomain: "acme", members: testMembers(all), identityProvider: "auth", apps: all, quota: seedQuota("small"), ...TEST_BUNDLE,
    routing: "path", ownDomain: own, ownDomainRedirects: [`www.${own}`], ...(ownDomainAliases.length ? { ownDomainAliases } : {}),
  });
  const w = tenantRegistrationWrite("test", GUID, registration);
  repo.seed(repo.booksBranch, w.path, w.content);
  return new TenantRegistrations(repo);
}

/** tnt_1 is the tenant at test; tnt_prod the same guid at prod, on `prodOwn`. */
function twoStages(testOwn: string, prodOwn: string): FakeDnsProvider {
  seedWebsiteTenant();
  db.db.update(clusters).set({ stage: "test" }).where(eq(clusters.id, "cls_1")).run();
  db.db.update(tenants).set({ stage: "test", ownDomain: testOwn, ownDomainRedirects: [`www.${testOwn}`], ownDomainAliases: [] }).where(eq(tenants.id, "tnt_1")).run();
  db.db.insert(servers).values({ id: "srv_prod", name: "s2", host: "10.1.1.12", sshUser: "root", role: "slave", status: "healthy" }).run();
  db.db.insert(clusters).values({ id: "cls_prod", serverId: "srv_prod", stage: "prod", domain: "s2.example", name: "s2", status: "active" }).run();
  db.db.insert(tenants).values({ id: "tnt_prod", clusterId: "cls_prod", guid: GUID, subdomain: "acme", stage: "prod", members: ["auth", "jobs", "report"], identityProvider: "auth", routing: "path", ownDomain: prodOwn, ownDomainRedirects: [`www.${prodOwn}`], status: "active" }).run();
  const dns = new FakeDnsProvider();
  dns.zones = ["simetrix.ch"];
  return dns;
}

const SHOW = { name: "show", site: "main" };
const VELO = { name: "veloluck", site: "shop" };

describe("the host checks of a move at test, the same tenant standing at prod", () => {
  it("PLANTED DEFECT: moves a website off its old-shape name, which lies under the tenant's prod host, keeping the name it leaves", async () => {
    const dns = twoStages("show.test.simetrix.ch", "show.simetrix.ch");
    const registrations = at("show.test.simetrix.ch", [{ ...SHOW, domain: "test.show.simetrix.ch" }, { ...VELO, domain: "test.veloluck.show.simetrix.ch" }]);
    const def = makeTenantSetWebsiteDomainDef(ports({ registrations, dns }, WEBSITE_APPS));
    const show = await def.planStream!({ tenantId: "tnt_1", app: "show", domain: "show.test.simetrix.ch", aliases: [] }, planCtx());
    // Onto the own domain, the name it leaves is the own domain's alias, never the website's.
    expect(show.outcome === "planned" ? [show.params.aliases, show.params.ownDomainAliases] : show.summary).toEqual([[], ["test.show.simetrix.ch"]]);
    const velo = await def.planStream!({ tenantId: "tnt_1", app: "veloluck", domain: "veloluck.show.test.simetrix.ch", aliases: [] }, planCtx());
    expect(velo.outcome === "planned" ? velo.params.aliases : velo.summary).toEqual(["test.veloluck.show.simetrix.ch"]);
  });

  it("PLANTED DEFECT: moves the own domain off its old-shape name under the prod host", async () => {
    const dns = twoStages("test.x.simetrix.ch", "x.simetrix.ch");
    const registrations = at("test.x.simetrix.ch", []);
    const def = makeTenantSetOwnDomainDef(ports({ registrations, dns }));
    const moved = await def.planStream!({ tenantId: "tnt_1", ownDomain: "x.test.simetrix.ch", ownDomainRedirects: ["www.x.test.simetrix.ch"], previous: "test.x.simetrix.ch", previousRedirects: ["www.test.x.simetrix.ch"] }, planCtx());
    expect(moved.outcome === "planned" ? moved.params.ownDomainAliases : moved.summary).toEqual(["test.x.simetrix.ch"]);
  });

  it("plans the owner's whole TEST sequence after the own domain moved: each website, then each alias drop, the own host's through Own domain…", async () => {
    const dns = twoStages("show.test.simetrix.ch", "show.simetrix.ch");
    const plan = async (apps: Parameters<typeof at>[1], request: Record<string, unknown>) => {
      const def = makeTenantSetWebsiteDomainDef(ports({ registrations: at("show.test.simetrix.ch", apps), dns }, WEBSITE_APPS));
      const r = await def.planStream!({ tenantId: "tnt_1", aliases: [], ...request }, planCtx());
      if (r.outcome !== "planned") throw new Error(r.summary);
      return r.params;
    };
    const velo = { ...VELO, domain: "test.veloluck.show.simetrix.ch" };
    const step2 = await plan([{ ...SHOW, domain: "test.show.simetrix.ch" }, velo], { app: "show", domain: "show.test.simetrix.ch" });
    expect([step2.aliases, step2.ownDomainAliases, step2.retiredHosts]).toEqual([[], ["test.show.simetrix.ch"], []]);
    // Step 3 is Own domain…: the drop retires the old name and its www, and nothing the prod row holds.
    const shown = { ...SHOW, domain: "show.test.simetrix.ch" };
    db.db.update(tenants).set({ ownDomainAliases: ["test.show.simetrix.ch"] }).where(eq(tenants.id, "tnt_1")).run();
    const own = makeTenantSetOwnDomainDef(ports({ registrations: at("show.test.simetrix.ch", [shown, velo], ["test.show.simetrix.ch"]), dns }));
    const step3 = await own.planStream!({ tenantId: "tnt_1", ownDomain: "show.test.simetrix.ch", ownDomainRedirects: ["www.show.test.simetrix.ch"], previous: "show.test.simetrix.ch",
      previousRedirects: ["www.show.test.simetrix.ch"], ownDomainAliases: [], previousAliases: ["test.show.simetrix.ch"] }, planCtx());
    expect(step3.outcome === "planned" ? step3.plan.summary : step3.summary).toMatch(/then remove the records of test\.show\.simetrix\.ch, www\.test\.show\.simetrix\.ch\./);
    db.db.update(tenants).set({ ownDomainAliases: [] }).where(eq(tenants.id, "tnt_1")).run();
    const step4 = await plan([shown, velo], { app: "veloluck", domain: "veloluck.show.test.simetrix.ch" });
    expect(step4.aliases).toEqual(["test.veloluck.show.simetrix.ch"]);
    const step5 = await plan([shown, { ...VELO, domain: "veloluck.show.test.simetrix.ch", aliases: ["test.veloluck.show.simetrix.ch"] }], { app: "veloluck", domain: "veloluck.show.test.simetrix.ch" });
    expect(step5.retiredHosts).toEqual(["test.veloluck.show.simetrix.ch", "www.test.veloluck.show.simetrix.ch"]);
  });

  it("PLANTED INNOCENT: still refuses a NEW test host under the tenant's own prod host", async () => {
    const dns = twoStages("show.test.simetrix.ch", "show.simetrix.ch");
    const registrations = at("show.test.simetrix.ch", [{ ...SHOW, domain: "show.test.simetrix.ch" }, { ...VELO, domain: "veloluck.show.test.simetrix.ch" }]);
    const def = makeTenantSetWebsiteDomainDef(ports({ registrations, dns }, WEBSITE_APPS));
    await expect(def.planStream!({ tenantId: "tnt_1", app: "veloluck", domain: "x.show.simetrix.ch", aliases: [] }, planCtx())).rejects.toThrow(/^x\.show\.simetrix\.ch overlaps a host of tenant acme at prod \(show\.simetrix\.ch\)$/);
  });

  it("PLANTED INNOCENT: still refuses a host typed now that overlaps another tenant's, as a domain and as an alias", async () => {
    const dns = twoStages("show.test.simetrix.ch", "show.simetrix.ch");
    db.db.insert(tenants).values({ id: "tnt_other", clusterId: "cls_1", guid: "zzzzzzzzzzzz", subdomain: "other", stage: "test", members: ["auth"], identityProvider: "auth", routing: "path", ownDomain: "shop.test.simetrix.ch", ownDomainRedirects: [], status: "active" }).run();
    const registrations = at("show.test.simetrix.ch", [{ ...SHOW, domain: "test.show.simetrix.ch" }, { ...VELO, domain: "test.veloluck.show.simetrix.ch" }]);
    const def = makeTenantSetWebsiteDomainDef(ports({ registrations, dns }, WEBSITE_APPS));
    await expect(def.planStream!({ tenantId: "tnt_1", app: "show", domain: "a.shop.test.simetrix.ch", aliases: [] }, planCtx())).rejects.toThrow(/overlaps a host of tenant other \(shop\.test\.simetrix\.ch\)/);
    await expect(def.planStream!({ tenantId: "tnt_1", app: "veloluck", domain: "veloluck.show.test.simetrix.ch", aliases: ["test.veloluck.show.simetrix.ch", "b.shop.test.simetrix.ch"] }, planCtx())).rejects.toThrow(/b\.shop\.test\.simetrix\.ch overlaps a host of tenant other/);
  });
});
