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
  dns.zones = ["example.org"];
  return dns;
}

const SHOW = { name: "show", site: "main" };
const CYCLESHOP = { name: "cycleshop", site: "shop" };

describe("the host checks of a move at test, the same tenant standing at prod", () => {
  it("PLANTED DEFECT: moves a website off its old-shape name, which lies under the tenant's prod host, keeping the name it leaves", async () => {
    const dns = twoStages("show.test.example.org", "show.example.org");
    const registrations = at("show.test.example.org", [{ ...SHOW, domain: "test.show.example.org" }, { ...CYCLESHOP, domain: "test.cycleshop.show.example.org" }]);
    const def = makeTenantSetWebsiteDomainDef(ports({ registrations, dns }, WEBSITE_APPS));
    const show = await def.planStream!({ tenantId: "tnt_1", app: "show", domain: "show.test.example.org", aliases: [] }, planCtx());
    // Onto the own domain, the name it leaves is the own domain's alias, never the website's.
    expect(show.outcome === "planned" ? [show.params.aliases, show.params.ownDomainAliases] : show.summary).toEqual([[], ["test.show.example.org"]]);
    const cycleshop = await def.planStream!({ tenantId: "tnt_1", app: "cycleshop", domain: "cycleshop.show.test.example.org", aliases: [] }, planCtx());
    expect(cycleshop.outcome === "planned" ? cycleshop.params.aliases : cycleshop.summary).toEqual(["test.cycleshop.show.example.org"]);
  });

  it("PLANTED DEFECT: moves the own domain off its old-shape name under the prod host", async () => {
    const dns = twoStages("test.x.example.org", "x.example.org");
    const registrations = at("test.x.example.org", []);
    const def = makeTenantSetOwnDomainDef(ports({ registrations, dns }));
    const moved = await def.planStream!({ tenantId: "tnt_1", ownDomain: "x.test.example.org", ownDomainRedirects: ["www.x.test.example.org"], previous: "test.x.example.org", previousRedirects: ["www.test.x.example.org"] }, planCtx());
    expect(moved.outcome === "planned" ? moved.params.ownDomainAliases : moved.summary).toEqual(["test.x.example.org"]);
  });

  it("plans the owner's whole TEST sequence after the own domain moved: each website, then each alias drop, the own host's through Own domain…", async () => {
    const dns = twoStages("show.test.example.org", "show.example.org");
    const plan = async (apps: Parameters<typeof at>[1], request: Record<string, unknown>) => {
      const def = makeTenantSetWebsiteDomainDef(ports({ registrations: at("show.test.example.org", apps), dns }, WEBSITE_APPS));
      const r = await def.planStream!({ tenantId: "tnt_1", aliases: [], ...request }, planCtx());
      if (r.outcome !== "planned") throw new Error(r.summary);
      return r.params;
    };
    const cycleshop = { ...CYCLESHOP, domain: "test.cycleshop.show.example.org" };
    const step2 = await plan([{ ...SHOW, domain: "test.show.example.org" }, cycleshop], { app: "show", domain: "show.test.example.org" });
    expect([step2.aliases, step2.ownDomainAliases, step2.retiredHosts]).toEqual([[], ["test.show.example.org"], []]);
    // Step 3 is Own domain…: the drop retires the old name and its www, and nothing the prod row holds.
    const shown = { ...SHOW, domain: "show.test.example.org" };
    db.db.update(tenants).set({ ownDomainAliases: ["test.show.example.org"] }).where(eq(tenants.id, "tnt_1")).run();
    const own = makeTenantSetOwnDomainDef(ports({ registrations: at("show.test.example.org", [shown, cycleshop], ["test.show.example.org"]), dns }));
    const step3 = await own.planStream!({ tenantId: "tnt_1", ownDomain: "show.test.example.org", ownDomainRedirects: ["www.show.test.example.org"], previous: "show.test.example.org",
      previousRedirects: ["www.show.test.example.org"], ownDomainAliases: [], previousAliases: ["test.show.example.org"] }, planCtx());
    expect(step3.outcome === "planned" ? step3.plan.summary : step3.summary).toMatch(/then remove the records of test\.show\.example\.org, www\.test\.show\.example\.org\./);
    db.db.update(tenants).set({ ownDomainAliases: [] }).where(eq(tenants.id, "tnt_1")).run();
    const step4 = await plan([shown, cycleshop], { app: "cycleshop", domain: "cycleshop.show.test.example.org" });
    expect(step4.aliases).toEqual(["test.cycleshop.show.example.org"]);
    const step5 = await plan([shown, { ...CYCLESHOP, domain: "cycleshop.show.test.example.org", aliases: ["test.cycleshop.show.example.org"] }], { app: "cycleshop", domain: "cycleshop.show.test.example.org" });
    expect(step5.retiredHosts).toEqual(["test.cycleshop.show.example.org", "www.test.cycleshop.show.example.org"]);
  });

  it("PLANTED INNOCENT: still refuses a NEW test host under the tenant's own prod host", async () => {
    const dns = twoStages("show.test.example.org", "show.example.org");
    const registrations = at("show.test.example.org", [{ ...SHOW, domain: "show.test.example.org" }, { ...CYCLESHOP, domain: "cycleshop.show.test.example.org" }]);
    const def = makeTenantSetWebsiteDomainDef(ports({ registrations, dns }, WEBSITE_APPS));
    await expect(def.planStream!({ tenantId: "tnt_1", app: "cycleshop", domain: "x.show.example.org", aliases: [] }, planCtx())).rejects.toThrow(/^x\.show\.example\.org overlaps a host of tenant acme at prod \(show\.example\.org\)$/);
  });

  it("PLANTED INNOCENT: still refuses a host typed now that overlaps another tenant's, as a domain and as an alias", async () => {
    const dns = twoStages("show.test.example.org", "show.example.org");
    db.db.insert(tenants).values({ id: "tnt_other", clusterId: "cls_1", guid: "zzzzzzzzzzzz", subdomain: "other", stage: "test", members: ["auth"], identityProvider: "auth", routing: "path", ownDomain: "shop.test.example.org", ownDomainRedirects: [], status: "active" }).run();
    const registrations = at("show.test.example.org", [{ ...SHOW, domain: "test.show.example.org" }, { ...CYCLESHOP, domain: "test.cycleshop.show.example.org" }]);
    const def = makeTenantSetWebsiteDomainDef(ports({ registrations, dns }, WEBSITE_APPS));
    await expect(def.planStream!({ tenantId: "tnt_1", app: "show", domain: "a.shop.test.example.org", aliases: [] }, planCtx())).rejects.toThrow(/overlaps a host of tenant other \(shop\.test\.example\.org\)/);
    await expect(def.planStream!({ tenantId: "tnt_1", app: "cycleshop", domain: "cycleshop.show.test.example.org", aliases: ["test.cycleshop.show.example.org", "b.shop.test.example.org"] }, planCtx())).rejects.toThrow(/b\.shop\.test\.example\.org overlaps a host of tenant other/);
  });
});
