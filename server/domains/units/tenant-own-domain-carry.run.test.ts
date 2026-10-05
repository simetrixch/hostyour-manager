import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { FakeDnsProvider } from "../../adapters/dns/testing/fake.ts";
import { FakePlatformRepo, FakeRepoReader } from "../../adapters/git/testing/fake.ts";
import { FakePublicProbe } from "#unit/server/adapters/http-probe/testing/fake.ts";
import { tenants } from "../../db/schema/inventory.ts";
import { TenantRegistrationSchema } from "../../../shared/tenant.ts";
import { seedQuota } from "#unit/shared/unit-size.ts";
import { makeTenantSetOwnDomainDef } from "./tenant-own-domain.run.ts";
import { TenantRegistrations, tenantRegistrationWrite } from "./tenant-registrations.ts";
import { TENANT_MANIFEST_PATH } from "./gates/tenant-gates.ts";
import { APP_OVERLAYS, testMembers, TEST_BUNDLE } from "./tenant-members.fixture.ts";
import { GUID, MANIFEST_YAML, SHA, ctx, db, params, planCtx, ports, useMemoryDb } from "./add-app.fixture.ts";
import { WEBSITE_APPS, seedWebsiteTenant } from "./tenant-website.fixture.ts";

// A website on the tenant's own host has no domain of its own: the website chart serves it at the root
// of the tenant's host, beside the apps under their paths. So when the own domain moves, such a website
// moves with it, in the same commit, and its old name becomes an own-domain alias like every previous
// own host; a website with a domain of its own stays where it is.

useMemoryDb();

const OLD = "show.simetrix.ch";
const NEW = "show.simplidigita.ai";
const VELO = { name: "veloluck", site: "shop", domain: "veloluck.show.simetrix.ch" };

function at(repo: FakePlatformRepo): TenantRegistrations {
  const apps = [{ name: "erp" }, ...[{ name: "show", site: "main", domain: OLD }, VELO].map((a) => ({ folder: "web", ...a }))];
  const registration = TenantRegistrationSchema.parse({
    cluster: "s1", subdomain: "acme", members: testMembers(apps), identityProvider: "auth", apps, quota: seedQuota("small"), ...TEST_BUNDLE,
    routing: "path", ownDomain: OLD, ownDomainRedirects: [`www.${OLD}`],
  });
  const w = tenantRegistrationWrite("prod", GUID, registration);
  repo.seed(repo.booksBranch, w.path, w.content);
  return new TenantRegistrations(repo);
}

/** The product's manifest with the website front handing its chart the domain, as digita-web takes it. */
const withDomain = () => new FakeRepoReader({
  resolvedSha: SHA,
  files: { [TENANT_MANIFEST_PATH]: MANIFEST_YAML.replace("override: { web: { chart: charts/example-web } }", 'override: { web: { chart: charts/example-web, values: { site: { domain: "{domain}", aliases: "{aliases}" } } } }'), ...APP_OVERLAYS },
});

function world() {
  seedWebsiteTenant();
  db.db.update(tenants).set({ ownDomain: OLD, ownDomainRedirects: [`www.${OLD}`], ownDomainAliases: [] }).where(eq(tenants.id, "tnt_1")).run();
  const dns = new FakeDnsProvider();
  dns.zones = ["simetrix.ch", "simplidigita.ai"];
  const repo = new FakePlatformRepo();
  const registrations = at(repo);
  const urls = ["https://show.simplidigita.ai/auth/", `https://${NEW}/`, `https://www.${NEW}/`, `https://${OLD}/`, `https://www.${OLD}/`];
  const probe = new FakePublicProbe(Object.fromEntries(urls.map((u) => [u, u.startsWith(`https://${NEW}/`) ? { reachable: true, status: 200, detail: "HTTP 200" } : { reachable: true, status: 301, detail: "HTTP 301" }])));
  const def = makeTenantSetOwnDomainDef(ports({ registrations, dns, probe, repo: withDomain() }, WEBSITE_APPS));
  return { repo, registrations, probe, def };
}

const MOVE = { tenantId: "tnt_1", ownDomain: NEW, ownDomainRedirects: [`www.${NEW}`], previous: OLD, previousRedirects: [`www.${OLD}`] };
const row = () => db.db.select({ ownDomain: tenants.ownDomain, aliases: tenants.ownDomainAliases }).from(tenants).where(eq(tenants.id, "tnt_1")).get();

describe("an own-domain move with a website on the own host", () => {
  it("PLANTED DEFECT: carries the website to the new own domain and keeps its old name as an own-domain alias", async () => {
    const { def } = world();
    const planned = await def.planStream!(MOVE, planCtx());
    if (planned.outcome !== "planned") throw new Error(planned.summary);
    expect(planned.params.ownDomainAliases).toEqual([OLD]);
    expect(planned.params.carriedWebsites.map((w) => [w.app, w.member.sources.map((s) => s.values).find((v) => v && "site" in v)])).toEqual([["show", { site: { domain: NEW } }]]);
    expect(planned.plan.summary).toContain(`carry website show from ${OLD} to ${NEW}`);
  });

  it("writes the own domain and the website in one commit, leaves the website with a domain of its own, and an abort takes both back", async () => {
    const { repo, registrations, def } = world();
    const planned = await def.planStream!(MOVE, planCtx());
    if (planned.outcome !== "planned") throw new Error(planned.summary);
    const write = def.steps(planned.params).find((s) => s.name === "write-own-domain")!;
    const before = repo.commits.length;
    await write.run(ctx(params(), write.name, []));
    expect(repo.commits.length - before).toBe(1);
    const after = (await registrations.readTenant("prod", GUID))?.entry;
    const site = (name: string) => after?.apps.find((a) => a.name === name);
    expect([after?.ownDomain, after?.ownDomainAliases, site("show")?.domain, site("show")?.aliases, site("veloluck")?.domain, row()]).toEqual([
      NEW, [OLD], NEW, undefined, VELO.domain, { ownDomain: NEW, aliases: [OLD] },
    ]);
    expect(after?.members.find((m) => m.name === "show")).toEqual(planned.params.carriedWebsites[0]!.member);

    const restore = def.cleanups!(planned.params).find((c) => c.name === "restore-own-domain")!;
    await restore.run(ctx(params(), restore.name, []));
    const back = (await registrations.readTenant("prod", GUID))?.entry;
    expect([back?.ownDomain, back?.ownDomainAliases, back?.apps.find((a) => a.name === "show")?.domain, row()]).toEqual([OLD, undefined, OLD, { ownDomain: OLD, aliases: [] }]);
    expect(back?.members.find((m) => m.name === "show")).toEqual(planned.params.carriedWebsites[0]!.previousMember);
  });

  it("waits for the website at the new own domain and the redirect of its old name, and keeps the old name's records", async () => {
    const { probe, def } = world();
    const planned = await def.planStream!(MOVE, planCtx());
    if (planned.outcome !== "planned") throw new Error(planned.summary);
    const retire = def.steps(planned.params).find((s) => s.name === "retire-previous-own-domain")!;
    await retire.run(ctx(params(), retire.name, []));
    expect(probe.probed).toEqual(expect.arrayContaining([`https://${NEW}/`, `https://${OLD}/`, `https://www.${OLD}/`]));
    expect(probe.probed.indexOf(`https://${NEW}/`)).toBeGreaterThan(-1);
  });
});
