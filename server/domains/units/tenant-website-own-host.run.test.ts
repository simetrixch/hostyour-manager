import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { FakeDnsProvider } from "../../adapters/dns/testing/fake.ts";
import { FakePlatformRepo, FakeRepoReader } from "../../adapters/git/testing/fake.ts";
import { TENANT_MANIFEST_PATH } from "./gates/tenant-gates.ts";
import { APP_OVERLAYS } from "./tenant-members.fixture.ts";
import { clusters, tenants } from "../../db/schema/inventory.ts";
import { TenantRegistrationSchema } from "../../../shared/tenant.ts";
import { seedQuota } from "#unit/shared/unit-size.ts";
import { makeTenantSetWebsiteDomainDef } from "./tenant-website-domain.run.ts";
import { makeTenantSetOwnDomainDef } from "./tenant-own-domain.run.ts";
import { TenantRegistrations, tenantRegistrationWrite } from "./tenant-registrations.ts";
import { testMembers, TEST_BUNDLE } from "./tenant-members.fixture.ts";
import { GUID, MANIFEST_YAML, SHA, ctx, db, params, planCtx, ports, useMemoryDb } from "./add-app.fixture.ts";
import { WEBSITE_APPS, seedWebsiteTenant } from "./tenant-website.fixture.ts";

// A website on the tenant's own domain has no alias of its own: the website chart refuses one there,
// and the old names of the own host are the tenant's own-domain aliases. So a move onto the own domain
// keeps the name it leaves as an own-domain alias, in the same commit, and never as the website's.

useMemoryDb();

const OWN = "show.test.simetrix.ch";
const OLD = "test.show.simetrix.ch";

function at(apps: { name: string; site: string; domain: string; aliases?: string[] }[], ownDomainAliases: string[] = []): TenantRegistrations {
  const repo = new FakePlatformRepo();
  const all = [{ name: "erp" }, ...apps.map((a) => ({ folder: "web", ...a }))];
  const registration = TenantRegistrationSchema.parse({
    cluster: "s1", subdomain: "acme", members: testMembers(all), identityProvider: "auth", apps: all, quota: seedQuota("small"), ...TEST_BUNDLE,
    routing: "path", ownDomain: OWN, ownDomainRedirects: [`www.${OWN}`], ...(ownDomainAliases.length ? { ownDomainAliases } : {}),
  });
  const w = tenantRegistrationWrite("test", GUID, registration);
  repo.seed(repo.booksBranch, w.path, w.content);
  return new TenantRegistrations(repo);
}

function atTest(): FakeDnsProvider {
  seedWebsiteTenant();
  db.db.update(clusters).set({ stage: "test" }).where(eq(clusters.id, "cls_1")).run();
  db.db.update(tenants).set({ stage: "test", ownDomain: OWN, ownDomainRedirects: [`www.${OWN}`], ownDomainAliases: [] }).where(eq(tenants.id, "tnt_1")).run();
  const dns = new FakeDnsProvider();
  dns.zones = ["simetrix.ch"];
  return dns;
}

const SHOW = { name: "show", site: "main" };

/** The product's manifest with the website front handing its chart the domain and the aliases, as
 *  digita-web takes them (site.domain, site.aliases), so the member resolved shows what the chart reads. */
const withDomain = () => new FakeRepoReader({
  resolvedSha: SHA,
  files: { [TENANT_MANIFEST_PATH]: MANIFEST_YAML.replace("override: { web: { chart: charts/example-web } }", 'override: { web: { chart: charts/example-web, values: { site: { domain: "{domain}", aliases: "{aliases}" } } } }'), ...APP_OVERLAYS },
});
const row = () => db.db.select({ a: tenants.ownDomainAliases }).from(tenants).where(eq(tenants.id, "tnt_1")).get()?.a;

describe("a website moving onto the tenant's own domain", () => {
  it("PLANTED DEFECT: keeps the name it leaves as an own-domain alias, never as its own, and retires none of its records", async () => {
    const dns = atTest();
    const def = makeTenantSetWebsiteDomainDef(ports({ registrations: at([{ ...SHOW, domain: OLD }]), dns, repo: withDomain() }, WEBSITE_APPS));
    const planned = await def.planStream!({ tenantId: "tnt_1", app: "show", domain: OWN, aliases: [] }, planCtx());
    if (planned.outcome !== "planned") throw new Error(planned.summary);
    expect([planned.params.aliases, planned.params.ownDomainAliases, planned.params.previousOwnDomainAliases, planned.params.retiredHosts]).toEqual([[], [OLD], [], []]);
    // What digita-web reads: the own host as site.domain and no site.aliases, the one shape its
    // redirect template renders for a website on the tenant's own host.
    expect(planned.params.member.sources.map((s) => s.values).find((v) => v && "site" in v)).toEqual({ site: { domain: OWN } });
  });

  it("writes the website at the own domain with no alias and the old name into the own-domain aliases, in one commit, and an abort takes both back", async () => {
    const dns = atTest();
    const registrations = at([{ ...SHOW, domain: OLD }]);
    const def = makeTenantSetWebsiteDomainDef(ports({ registrations, dns }, WEBSITE_APPS));
    const planned = await def.planStream!({ tenantId: "tnt_1", app: "show", domain: OWN, aliases: [] }, planCtx());
    if (planned.outcome !== "planned") throw new Error(planned.summary);
    const write = def.steps(planned.params).find((s) => s.name === "write-website-domain")!;
    await write.run(ctx(params(), write.name, []));
    const after = (await registrations.readTenant("test", GUID))?.entry;
    const show = after?.apps.find((a) => a.name === "show");
    expect([show?.domain, show?.aliases, after?.ownDomainAliases, row()]).toEqual([OWN, undefined, [OLD], [OLD]]);

    const restore = def.cleanups!(planned.params).find((c) => c.name === "restore-website-domain")!;
    await restore.run(ctx(params(), restore.name, []));
    const back = (await registrations.readTenant("test", GUID))?.entry;
    const shown = back?.apps.find((a) => a.name === "show");
    expect([shown?.domain, shown?.aliases, back?.ownDomainAliases, row()]).toEqual([OLD, undefined, undefined, []]);
  });

  it("refuses an alias typed for a website on the own domain, naming where those aliases are set", async () => {
    const dns = atTest();
    const def = makeTenantSetWebsiteDomainDef(ports({ registrations: at([{ ...SHOW, domain: OLD }]), dns }, WEBSITE_APPS));
    await expect(def.planStream!({ tenantId: "tnt_1", app: "show", domain: OWN, aliases: ["extra.test.simetrix.ch"] }, planCtx()))
      .rejects.toThrow(/extra\.test\.simetrix\.ch.*Own domain/);
  });

  it("PLANTED INNOCENT: a website moving to a domain of its own keeps the name it leaves as its own alias", async () => {
    const dns = atTest();
    const def = makeTenantSetWebsiteDomainDef(ports({ registrations: at([{ ...SHOW, domain: OWN }, { name: "veloluck", site: "shop", domain: "test.veloluck.show.simetrix.ch" }]), dns }, WEBSITE_APPS));
    const planned = await def.planStream!({ tenantId: "tnt_1", app: "veloluck", domain: "veloluck.show.test.simetrix.ch", aliases: [] }, planCtx());
    if (planned.outcome !== "planned") throw new Error(planned.summary);
    expect([planned.params.aliases, planned.params.ownDomainAliases]).toEqual([["test.veloluck.show.simetrix.ch"], undefined]);
  });
});

// The TEST move of 2026-10-05 from the simetrix.ch zone into simplidigita.ai, both zones on the
// installation's provider: the own domain first, then each website, every old name a redirect.
describe("a TEST move from the simetrix.ch zone into the simplidigita.ai zone", () => {
  const NEW_OWN = "show.test.simplidigita.ai";
  const registration = (own: string, ownDomainAliases: string[], apps: Parameters<typeof at>[0]): TenantRegistrations => {
    const repo = new FakePlatformRepo();
    const all = [{ name: "erp" }, ...apps.map((a) => ({ folder: "web", ...a }))];
    const parsed = TenantRegistrationSchema.parse({
      cluster: "s1", subdomain: "acme", members: testMembers(all), identityProvider: "auth", apps: all, quota: seedQuota("small"), ...TEST_BUNDLE,
      routing: "path", ownDomain: own, ownDomainRedirects: [`www.${own}`], ...(ownDomainAliases.length ? { ownDomainAliases } : {}),
    });
    const w = tenantRegistrationWrite("test", GUID, parsed);
    repo.seed(repo.booksBranch, w.path, w.content);
    return new TenantRegistrations(repo);
  };
  const crossZone = (): FakeDnsProvider => {
    const dns = atTest();
    dns.zones = ["simetrix.ch", "simplidigita.ai"];
    return dns;
  };
  const VELO = { name: "veloluck", site: "shop", domain: "test.veloluck.show.simetrix.ch" };

  it("moves the own domain across the zones and keeps the old one as its alias", async () => {
    const dns = crossZone();
    const def = makeTenantSetOwnDomainDef(ports({ registrations: registration(OWN, [], [{ ...SHOW, domain: OLD }, VELO]), dns }));
    const planned = await def.planStream!({ tenantId: "tnt_1", ownDomain: NEW_OWN, ownDomainRedirects: [`www.${NEW_OWN}`], previous: OWN, previousRedirects: [`www.${OWN}`] }, planCtx());
    if (planned.outcome !== "planned") throw new Error(planned.summary);
    expect(planned.params.ownDomainAliases).toEqual([OWN]);
    expect(planned.plan.summary).toContain(`https://${OWN}/, https://www.${OWN}/ with a redirect`);
  });

  it("moves website show onto the new own domain, its old name joining the own domain's aliases beside the old own domain", async () => {
    const dns = crossZone();
    db.db.update(tenants).set({ ownDomain: NEW_OWN, ownDomainRedirects: [`www.${NEW_OWN}`], ownDomainAliases: [OWN] }).where(eq(tenants.id, "tnt_1")).run();
    const def = makeTenantSetWebsiteDomainDef(ports({ registrations: registration(NEW_OWN, [OWN], [{ ...SHOW, domain: OLD }, VELO]), dns }, WEBSITE_APPS));
    const planned = await def.planStream!({ tenantId: "tnt_1", app: "show", domain: NEW_OWN, aliases: [] }, planCtx());
    if (planned.outcome !== "planned") throw new Error(planned.summary);
    expect([planned.params.aliases, planned.params.ownDomainAliases, planned.params.retiredHosts]).toEqual([[], [OWN, OLD], []]);
    // The wait asks each old name for its redirect.
    expect(planned.plan.summary).toMatch(new RegExp(`https://${OLD.replaceAll(".", "\\.")}/, https://www\\.${OLD.replaceAll(".", "\\.")}/ redirects`));
  });

  it("moves website veloluck across the zones to a domain of its own, keeping its old name as its own alias", async () => {
    const dns = crossZone();
    db.db.update(tenants).set({ ownDomain: NEW_OWN, ownDomainRedirects: [`www.${NEW_OWN}`], ownDomainAliases: [OWN, OLD] }).where(eq(tenants.id, "tnt_1")).run();
    const def = makeTenantSetWebsiteDomainDef(ports({ registrations: registration(NEW_OWN, [OWN, OLD], [{ ...SHOW, domain: NEW_OWN }, VELO]), dns }, WEBSITE_APPS));
    const planned = await def.planStream!({ tenantId: "tnt_1", app: "veloluck", domain: "veloluck.show.test.simplidigita.ai", aliases: [] }, planCtx());
    if (planned.outcome !== "planned") throw new Error(planned.summary);
    expect([planned.params.aliases, planned.params.ownDomainAliases, planned.params.recordHosts]).toEqual([
      ["test.veloluck.show.simetrix.ch"], undefined,
      ["veloluck.show.test.simplidigita.ai", "www.veloluck.show.test.simplidigita.ai", "test.veloluck.show.simetrix.ch", "www.test.veloluck.show.simetrix.ch"],
    ]);
  });
});
