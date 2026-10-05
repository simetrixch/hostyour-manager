import { describe, it, expect } from "vitest";
import { seedQuota } from "#unit/shared/unit-size.ts";
import { tenantZone } from "#unit/shared/unit-host.ts";
import { FakePublicProbe } from "#unit/server/adapters/http-probe/testing/fake.ts";
import { makeAddAppDef } from "./add-app.run.ts";
import { makeRemoveAppDef } from "./tenant-lifecycle.run.ts";
import { makeTenantSetOwnDomainDef, TenantSetOwnDomainParams } from "./tenant-own-domain.run.ts";
import { CreateTenantRequest } from "./create-tenant.run.ts";
import { tenants, tenantApps } from "../../db/schema/inventory.ts";
import { and, eq } from "drizzle-orm";
import { makeTenantSetWebsiteDomainDef } from "./tenant-website-domain.run.ts";
import { TENANT_MANIFEST_PATH } from "./gates/tenant-gates.ts";
import { recordDnsWrite } from "../../db/dns-writes.ts";
import { tenantRegistrationWrite } from "./tenant-registrations.ts";
import { FakePlatformRepo, FakeRepoReader, FakeRepoWriter } from "../../adapters/git/testing/fake.ts";
import { tenantAppsRepoURL } from "./tenant-apps-tree.ts";
import { parseAppsManifest } from "../../../shared/apps-manifest.ts";
import type { CredentialStore } from "../../security/store.ts";
import { FakeDnsProvider } from "../../adapters/dns/testing/fake.ts";
import { TenantRegistrationSchema } from "../../../shared/tenant.ts";
import { testMembers, APP_OVERLAYS, TEST_BUNDLE } from "./tenant-members.fixture.ts";
import { GUID, MANIFEST_YAML, SHA, ctx, db, params, planCtx, ports, seedClusters, useMemoryDb } from "./add-app.fixture.ts";
import { WEBSITE_APPS, seedWebsiteTenant, tenantWith } from "./tenant-website.fixture.ts";

// A website of a live tenant, added, moved and removed: named after its site, running the bundle's
// folder `web`, served at <domain> with www.<domain> redirecting there, its hosts pointed at the
// tenant's zone while it stands.

useMemoryDb();

const WEBSITE = { tenantId: "tnt_1", app: "main", folder: "web", site: "main", domain: "example.ch" };
const OK = { reachable: true, status: 200, detail: "HTTP 200" };
const REDIRECTS = { reachable: true, status: 307, detail: "HTTP 307" };

/** A second live tenant's registration on the same books branch, serving a website at `domain`. */
function seedOtherTenantWebsite(repo: FakePlatformRepo, domain: string): void {
  const apps = [{ name: "shop-site", folder: "web", site: "shop", domain }];
  const registration = TenantRegistrationSchema.parse({ cluster: "s1", subdomain: "other", members: testMembers(apps), identityProvider: "auth", apps, quota: seedQuota("small"), ...TEST_BUNDLE });
  const w = tenantRegistrationWrite("prod", "b2b2b2b2b2b2", registration);
  repo.seed(repo.booksBranch, w.path, w.content);
}

describe("add-app for a website", () => {
  it("plans a website named after its site, running the web folder, with the records of both its hosts", async () => {
    seedWebsiteTenant();
    const def = makeAddAppDef(ports({ dns: new FakeDnsProvider() }, WEBSITE_APPS));
    const result = await def.planStream!(WEBSITE, planCtx());
    expect(result.outcome).toBe("planned");
    if (result.outcome !== "planned") return;
    expect(result.params.app).toBe("main");
    expect(result.params.website).toEqual({ folder: "web", site: "main", domain: "example.ch" });
    expect(result.params.websiteRecordHosts).toEqual(["example.ch", "www.example.ch"]);
    const names = result.plan.steps.map((s) => s.name);
    // Its revalidate secret and its form signing key stand before the append generates the engine and
    // the renderer that read them.
    expect(names.slice(names.indexOf("seed-password-field-key"), names.indexOf("append-app") + 1))
      .toEqual(["seed-password-field-key", "seed-revalidate-secret", "seed-form-signing-key", "append-app"]);
    expect(names.slice(names.indexOf("watch-sync-set"))).toEqual(["watch-sync-set", "provision-website-records", "wait-website", "smoke", "record-inventory"]);
    expect(result.plan.summary).toContain("website of site main, served at example.ch, and www.example.ch redirects there");
  });

  it("carries only the site it serves into the tenant's bundle, and lists only that site", async () => {
    seedWebsiteTenant();
    const sites = { "webs/main/website.json": "{}\n", "webs/shop/website.json": "{}\n" };
    const prt = ports({ dns: new FakeDnsProvider() }, { ...WEBSITE_APPS, ...sites });
    const result = await makeAddAppDef(prt).planStream!(WEBSITE, planCtx());
    if (result.outcome !== "planned") throw new Error(`rejected: ${result.summary}`);
    const p = result.params;
    const writer = new FakeRepoWriter();
    prt.onboard = () => ({ ports: { consumerRepo: writer } }) as unknown as ReturnType<NonNullable<typeof prt.onboard>>;
    const creds = { list: async () => [{ id: "cred_app", subject: { kind: "owner" } }] } as unknown as CredentialStore;
    await makeAddAppDef(prt).steps(p).find((s) => s.name === "write-tree")!.run({ ...ctx(p, "write-tree", []), creds });
    const files = writer.filesFor(tenantAppsRepoURL(p.appsUnit!.org, p.appsUnit!.templateBuild, p.subdomain));
    expect(Object.keys(files).filter((f) => f.startsWith("webs/"))).toEqual(["webs/main/website.json"]);
    expect(parseAppsManifest(files["apps.yaml"]!).apps.find((a) => a.name === "web")?.sites).toEqual(["main"]);
  });

  it("refuses a website not named after its site, a domain typed with www, and a domain another website serves", async () => {
    seedWebsiteTenant();
    const def = makeAddAppDef(ports({}, WEBSITE_APPS));
    // The name a website got from its domain before is no name for a new one.
    await expect(def.planStream!({ ...WEBSITE, app: "example-ch" }, planCtx())).rejects.toThrow(/a website of site main is named main, or that name with -2, -3 and on where it is taken, never example-ch/);
    await expect(def.planStream!({ ...WEBSITE, domain: "www.example.ch" }, planCtx())).rejects.toThrow(/type the domain without \\"www\.\\"/);
    // A moved website keeps its name, so the domain is held on its own.
    const moved = tenantWith([{ name: "old-site", folder: "web", site: "shop", domain: "example.ch" }]);
    await expect(makeAddAppDef(ports({ registrations: moved }, WEBSITE_APPS)).planStream!(WEBSITE, planCtx())).rejects.toThrow(/example\.ch is already the domain of website "old-site"/);
  });

  it("takes the numbered name of a site whose id the tenant already carries, and refuses the id itself", async () => {
    seedWebsiteTenant();
    const registrations = tenantWith([{ name: "main" }]);
    const def = makeAddAppDef(ports({ registrations, dns: new FakeDnsProvider() }, WEBSITE_APPS));
    await expect(def.planStream!(WEBSITE, planCtx())).rejects.toThrow(/app "main" already exists/);
    const result = await def.planStream!({ ...WEBSITE, app: "main-2" }, planCtx());
    expect(result.outcome === "planned" && result.params.app).toBe("main-2");
  });

  it("refuses a website whose site the catalog carries no folder for under webs/, naming the folder", async () => {
    seedWebsiteTenant();
    const withoutSite = { "apps.yaml": WEBSITE_APPS["apps.yaml"], "webs/shop/website.json": "{}\n" };
    await expect(makeAddAppDef(ports({}, withoutSite)).planStream!(WEBSITE, planCtx())).rejects.toThrow(/carries no webs\/main\/ although its apps\.yaml names it/);
  });

  it("lists an address record at a website host in the plan, replaces it with the CNAME, and writes it back on abort", async () => {
    seedWebsiteTenant();
    const dns = new FakeDnsProvider();
    dns.seed("www.example.ch", "A", "192.0.2.10");
    const result = await makeAddAppDef(ports({ dns }, WEBSITE_APPS)).planStream!(WEBSITE, planCtx());
    if (result.outcome !== "planned") throw new Error("the website was not planned");
    expect(result.params.websiteReplacing).toEqual([{ name: "www.example.ch", type: "A", content: "192.0.2.10" }]);
    expect(result.plan.summary).toContain("It deletes A www.example.ch → 192.0.2.10, which this installation did not write, and an abort writes it back.");
    const p = params({ app: "main", website: { folder: "web", site: "main", domain: "example.ch" }, websiteRecordHosts: ["www.example.ch", "example.ch"], websiteReplacing: result.params.websiteReplacing });
    // The abort's remove-website-records runs before revert-app-append, so the registration still carries the website.
    const def = makeAddAppDef(ports({ dns, registrations: tenantWith([{ name: "main", folder: "web", site: "main", domain: "example.ch" }]) }));
    await def.steps(p).find((s) => s.name === "provision-website-records")!.run(ctx(p, "provision-website-records", []));
    expect([dns.record("www.example.ch", "A"), dns.record("www.example.ch", "CNAME")]).toEqual([undefined, tenantZone("acme", "prod", "example.com")]);
    await def.cleanups!(p).find((c) => c.name === "remove-website-records")!.run(ctx(p, "remove-website-records", []));
    expect([dns.record("www.example.ch", "A"), dns.record("www.example.ch", "CNAME"), dns.record("example.ch", "CNAME")]).toEqual(["192.0.2.10", undefined, undefined]);
  });

  it("writes no record for a website on the tenant's own domain, whose records tenant-set-own-domain holds", async () => {
    seedWebsiteTenant();
    const own = tenantWith([], { ownDomain: "www.example.ch", ownDomainRedirects: ["example.ch"] });
    const result = await makeAddAppDef(ports({ registrations: own }, WEBSITE_APPS)).planStream!(WEBSITE, planCtx());
    expect(result.outcome === "planned" && result.params.websiteRecordHosts).toEqual([]);
  });

  it("records the site of a website in the inventory, which keeps it out of the Apps list once it is removed", async () => {
    seedWebsiteTenant();
    const p = params({ app: "main", website: { folder: "web", site: "main", domain: "example.ch" } });
    await makeAddAppDef(ports({})).steps(p).find((s) => s.name === "record-inventory")!.run(ctx(p, "record-inventory", []));
    const site = (name: string) => db.db.select({ site: tenantApps.site }).from(tenantApps).where(and(eq(tenantApps.tenantId, "tnt_1"), eq(tenantApps.name, name))).get()?.site;
    expect(site("main")).toBe("main");
    expect(site("erp")).toBeNull(); // an app's row names no site
    // A website added again under a name its earlier row still holds writes the site on that row too.
    db.db.update(tenantApps).set({ status: "offboarded", site: null }).where(and(eq(tenantApps.tenantId, "tnt_1"), eq(tenantApps.name, "main"))).run();
    await makeAddAppDef(ports({})).steps(p).find((s) => s.name === "record-inventory")!.run(ctx(p, "record-inventory", []));
    expect(site("main")).toBe("main");
  });

  it("points both hosts at the tenant's zone, then waits until the site answers at its domain and its www host redirects", async () => {
    seedWebsiteTenant();
    const dns = new FakeDnsProvider();
    const probe = new FakePublicProbe({ "https://example.ch/": OK, "https://www.example.ch/": REDIRECTS });
    const p = params({ app: "main", website: { folder: "web", site: "main", domain: "example.ch" }, websiteRecordHosts: ["example.ch", "www.example.ch"] });
    const steps = makeAddAppDef(ports({ dns, probe })).steps(p);
    const logs: string[] = [];
    for (const name of ["provision-website-records", "wait-website"]) await steps.find((s) => s.name === name)!.run(ctx(p, name, logs));
    const zone = tenantZone("acme", "prod", "example.com");
    expect([dns.record("www.example.ch", "CNAME"), dns.record("example.ch", "CNAME")]).toEqual([zone, zone]);
    expect(probe.probed).toEqual(["https://example.ch/", "https://www.example.ch/"]);
    expect(logs.some((l) => l.includes("https://www.example.ch/ redirects"))).toBe(true);
  });

  it("removes a website's records with its drop, and again off the checkpoint on a resume after the drop", async () => {
    seedWebsiteTenant();
    const dns = new FakeDnsProvider();
    for (const name of ["www.example.ch", "example.ch"]) {
      dns.seed(name, "CNAME", "acme.example.com");
      recordDnsWrite(db.db, { name, type: "CNAME", content: "acme.example.com", act: "inserted", owner: { kind: "tenant", name: GUID, stage: "prod" }, runId: "run_add" });
    }
    const registrations = tenantWith([{ name: "example-ch", folder: "web", site: "main", domain: "example.ch" }]);
    const pointer = () => makeRemoveAppDef(ports({ dns, registrations })).steps({ tenantId: "tnt_1", app: "example-ch" }).find((s) => s.name === "remove-app-pointer")!;
    await pointer().run(ctx(params(), "remove-app-pointer", []));
    expect((await registrations.readTenant("prod", GUID))!.entry.apps.map((a) => a.name)).toEqual(["erp"]);
    expect([dns.record("www.example.ch", "CNAME"), dns.record("example.ch", "CNAME")]).toEqual([undefined, undefined]);
    // A resume after the drop finds no domain in the registration, and removes the checkpointed hosts.
    dns.seed("www.example.ch", "CNAME", "acme.example.com");
    recordDnsWrite(db.db, { name: "www.example.ch", type: "CNAME", content: "acme.example.com", act: "inserted", owner: { kind: "tenant", name: GUID, stage: "prod" }, runId: "run_add" });
    await pointer().run({ ...ctx(params(), "remove-app-pointer", []), readCheckpoint: <T,>() => ({ websiteHosts: ["www.example.ch"] }) as T });
    expect(dns.record("www.example.ch", "CNAME")).toBeUndefined();
  });

  it("names every cleanup a website's steps register, so an abort can run them", async () => {
    const p = params({ app: "main", website: { folder: "web", site: "main", domain: "example.ch" }, websiteRecordHosts: ["www.example.ch", "example.ch"] });
    const def = makeAddAppDef(ports({ dns: new FakeDnsProvider() }));
    expect(def.cleanups!(p).map((c) => c.name)).toEqual(expect.arrayContaining(["revert-app-append", "remove-website-records"]));
  });

  it("refuses a website on a host-routed tenant and at a domain another tenant's website serves", async () => {
    seedClusters();
    await expect(makeAddAppDef(ports({}, WEBSITE_APPS)).planStream!(WEBSITE, planCtx())).rejects.toThrow(/is on host routing/);
    db.db.update(tenants).set({ routing: "path" }).where(eq(tenants.id, "tnt_1")).run();
    const repo = new FakePlatformRepo();
    seedOtherTenantWebsite(repo, "example.ch");
    const registrations = tenantWith([], undefined, repo);
    await expect(makeAddAppDef(ports({ registrations }, WEBSITE_APPS)).planStream!(WEBSITE, planCtx())).rejects.toThrow("example.ch is already a website host of tenant other");
  });

  it("leaves a website's hosts standing when the tenant's own domain moves away from them", async () => {
    seedWebsiteTenant();
    db.db.update(tenants).set({ ownDomain: "www.example.ch", ownDomainRedirects: ["example.ch"] }).where(eq(tenants.id, "tnt_1")).run();
    const dns = new FakeDnsProvider();
    for (const name of ["www.example.ch", "example.ch"]) {
      dns.seed(name, "CNAME", "acme.example.com");
      recordDnsWrite(db.db, { name, type: "CNAME", content: "acme.example.com", act: "inserted", owner: { kind: "tenant", name: GUID, stage: "prod" }, runId: "run_own" });
    }
    const registrations = tenantWith([{ name: "example-ch", folder: "web", site: "main", domain: "example.ch" }], { ownDomain: "www.example.ch", ownDomainRedirects: ["example.ch"] });
    const probe = new FakePublicProbe({ "https://www.example.org/auth/": OK, "https://example.org/": REDIRECTS });
    const p = TenantSetOwnDomainParams.parse({ tenantId: "tnt_1", ownDomain: "www.example.org", ownDomainRedirects: ["example.org"], previous: "www.example.ch", previousRedirects: ["example.ch"] });
    const retire = makeTenantSetOwnDomainDef(ports({ dns, probe, registrations })).steps(p).find((s) => s.name === "retire-previous-own-domain")!;
    await retire.run(ctx(params(), retire.name, []));
    expect([dns.record("www.example.ch", "CNAME"), dns.record("example.ch", "CNAME")]).toEqual(["acme.example.com", "acme.example.com"]);
  });

  it("refuses an own-domain alias a website of the tenant serves, and keeps a previous host a website answers at off the aliases", async () => {
    seedWebsiteTenant();
    const own = { ownDomain: "www.example.ch", ownDomainRedirects: ["example.ch"] };
    db.db.update(tenants).set(own).where(eq(tenants.id, "tnt_1")).run();
    const registrations = tenantWith([{ name: "example-ch", folder: "web", site: "main", domain: "example.ch" }, { name: "shop", folder: "web", site: "shop", domain: "example.net" }], own);
    const def = makeTenantSetOwnDomainDef(ports({ registrations }));
    const from = { tenantId: "tnt_1", previous: own.ownDomain, previousRedirects: own.ownDomainRedirects };
    await expect(def.planStream!({ ...from, ...own, ownDomainAliases: ["example.net"] }, planCtx())).rejects.toThrow(/example\.net is a host a website of tenant \w+ serves/);
    const moved = await def.planStream!({ ...from, ownDomain: "www.example.org", ownDomainRedirects: ["example.org"] }, planCtx());
    expect(moved.outcome === "planned" && moved.params.ownDomainAliases).toEqual([]);
  });
});

describe("tenant-set-website-domain", () => {
  /** The deploy repository's manifest with the website front handing its chart the domain, as the
   *  product's own does, so a member resolved again shows which domain it was resolved with. */
  const withDomain = () => new FakeRepoReader({
    resolvedSha: SHA,
    files: { [TENANT_MANIFEST_PATH]: MANIFEST_YAML.replace("override: { web: { chart: charts/example-web } }", 'override: { web: { chart: charts/example-web, values: { site: { domain: "{domain}", aliases: "{aliases}" } } } }'), ...APP_OVERLAYS },
  });
  const MOVE = { tenantId: "tnt_1", app: "example-ch", domain: "example.org" };

  it("plans the move with the member resolved again at the new domain, keeping the previous domain as an alias", async () => {
    seedWebsiteTenant();
    const registrations = tenantWith([{ name: "example-ch", folder: "web", site: "main", domain: "example.ch" }]);
    const result = await makeTenantSetWebsiteDomainDef(ports({ registrations, repo: withDomain() }, WEBSITE_APPS)).planStream!(MOVE, planCtx());
    expect(result.outcome).toBe("planned");
    if (result.outcome !== "planned") return;
    expect(result.params).toMatchObject({ previous: "example.ch", domain: "example.org", aliases: ["example.ch"], recordHosts: ["example.org", "www.example.org", "example.ch", "www.example.ch"], retiredHosts: [] });
    expect(result.params.member.sources[1]!.values).toEqual({ site: { domain: "example.org", aliases: ["example.ch"] } });
    expect(result.plan.steps.map((s) => s.name)).toEqual(["attest-target", "check-mail-records", "provision-website-records", "write-website-domain", "retire-previous-website-domain"]);
  });

  it("moves a website whose site the template catalog no longer lists: the catalog does not judge a standing website", async () => {
    seedWebsiteTenant();
    const registrations = tenantWith([{ name: "example-ch", folder: "web", site: "main", domain: "example.ch" }]);
    const noSites = { "apps.yaml": "apps:\n  - name: erp\n    title: ERP\n  - name: web\n    title: Website\n" };
    const logs: string[] = [];
    const result = await makeTenantSetWebsiteDomainDef(ports({ registrations, repo: withDomain() }, noSites)).planStream!(MOVE, { ...planCtx(), log: (l) => logs.push(l) });
    expect(result.outcome === "planned" ? "planned" : result.summary).toBe("planned");
    // Its database list is read off the tenant's own bundle, which this fixture's release does not carry.
    expect(logs.some((l) => l.endsWith("the apps' database lists stay as the registration holds them"))).toBe(true);
  });

  it("refuses an app that is no website, the domain it already has, a domain another website serves, and a domain typed with www", async () => {
    seedWebsiteTenant();
    const registrations = tenantWith([{ name: "example-ch", folder: "web", site: "main", domain: "example.ch" }, { name: "shop", folder: "web", site: "shop", domain: "example.net" }]);
    const def = makeTenantSetWebsiteDomainDef(ports({ registrations }, WEBSITE_APPS));
    await expect(def.planStream!({ ...MOVE, app: "erp" }, planCtx())).rejects.toThrow(/is no website/);
    await expect(def.planStream!({ ...MOVE, domain: "example.ch" }, planCtx())).rejects.toThrow(/already served at example\.ch/);
    await expect(def.planStream!({ ...MOVE, domain: "example.net" }, planCtx())).rejects.toThrow(/already the domain of website "shop"/);
    await expect(def.planStream!({ ...MOVE, domain: "www.example.org" }, planCtx())).rejects.toThrow(/type the domain without "www\."/);
  });

  it("records the new domain and member in one commit, and keeps the previous hosts' records for the alias; an abort puts the previous ones back", async () => {
    seedWebsiteTenant();
    const registrations = tenantWith([{ name: "example-ch", folder: "web", site: "main", domain: "example.ch" }]);
    const dns = new FakeDnsProvider();
    for (const name of ["www.example.ch", "example.ch"]) {
      dns.seed(name, "CNAME", "acme.example.com");
      recordDnsWrite(db.db, { name, type: "CNAME", content: "acme.example.com", act: "inserted", owner: { kind: "tenant", name: GUID, stage: "prod" }, runId: "run_add" });
    }
    const probe = new FakePublicProbe({ "https://example.org/": OK, "https://www.example.org/": REDIRECTS, "https://example.ch/": REDIRECTS, "https://www.example.ch/": REDIRECTS });
    const prt = ports({ registrations, dns, probe, repo: withDomain() }, WEBSITE_APPS);
    const planned = await makeTenantSetWebsiteDomainDef(prt).planStream!(MOVE, planCtx());
    if (planned.outcome !== "planned") throw new Error("not planned");
    const def = makeTenantSetWebsiteDomainDef(prt);
    for (const step of def.steps(planned.params).slice(1)) await step.run(ctx(params(), step.name, []));
    const moved = (await registrations.readTenant("prod", GUID))!.entry;
    expect(moved.apps.find((a) => a.name === "example-ch")).toMatchObject({ domain: "example.org", aliases: ["example.ch"] });
    expect(moved.members.find((m) => m.name === "example-ch")).toEqual(planned.params.member);
    expect([dns.record("www.example.org", "CNAME"), dns.record("www.example.ch", "CNAME"), dns.record("example.ch", "CNAME")]).toEqual(["acme.example.com", "acme.example.com", "acme.example.com"]);
    // The abort writes the previous domain and member back, without the alias.
    for (const cleanup of def.cleanups!(planned.params).reverse()) await cleanup.run(ctx(params(), cleanup.name, []));
    const back = (await registrations.readTenant("prod", GUID))!.entry.apps.find((a) => a.name === "example-ch")!;
    expect(back.domain).toBe("example.ch");
    expect("aliases" in back).toBe(false);
    // The restored website answers at its previous hosts again, so their records stay; the new ones go.
    expect(["example.ch", "www.example.ch", "example.org", "www.example.org"].map((h) => dns.record(h, "CNAME"))).toEqual(["acme.example.com", "acme.example.com", undefined, undefined]);
  });

  it("puts nothing back on abort once another run moved the website on", async () => {
    seedWebsiteTenant();
    const registrations = tenantWith([{ name: "example-ch", folder: "web", site: "main", domain: "example.ch" }]);
    const prt = ports({ registrations, repo: withDomain() }, WEBSITE_APPS);
    const planned = await makeTenantSetWebsiteDomainDef(prt).planStream!(MOVE, planCtx());
    if (planned.outcome !== "planned") throw new Error("not planned");
    await registrations.setWebsiteDomain("prod", GUID, "example-ch", "example.net", [], planned.params.member, "run_other");
    const restore = makeTenantSetWebsiteDomainDef(prt).cleanups!(planned.params).find((c) => c.name === "restore-website-domain")!;
    const logs: string[] = [];
    await restore.run(ctx(params(), restore.name, logs));
    expect((await registrations.readTenant("prod", GUID))!.entry.apps.find((a) => a.name === "example-ch")?.domain).toBe("example.net");
    expect(logs.some((l) => l.includes("stands at example.net now"))).toBe(true);
  });
  it("gives a website alias domains at the same domain, and drops one again, its records with it", async () => {
    seedWebsiteTenant();
    const registrations = tenantWith([{ name: "example-ch", folder: "web", site: "main", domain: "example.ch" }]);
    const dns = new FakeDnsProvider();
    const probe = new FakePublicProbe({ "https://example.ch/": OK, "https://www.example.ch/": REDIRECTS, "https://example.de/": REDIRECTS, "https://www.example.de/": REDIRECTS });
    const prt = ports({ registrations, dns, probe, repo: withDomain() }, WEBSITE_APPS);
    const run = async (req: typeof MOVE & { aliases?: string[] }) => {
      const planned = await makeTenantSetWebsiteDomainDef(prt).planStream!(req, planCtx());
      if (planned.outcome !== "planned") throw new Error("not planned");
      for (const step of makeTenantSetWebsiteDomainDef(prt).steps(planned.params).slice(1)) await step.run(ctx(params(), step.name, []));
      return planned.params;
    };
    const added = await run({ ...MOVE, domain: "example.ch", aliases: ["example.de"] });
    expect(added).toMatchObject({ recordHosts: ["example.ch", "www.example.ch", "example.de", "www.example.de"], retiredHosts: [] });
    expect((await registrations.readTenant("prod", GUID))!.entry.apps.find((a) => a.name === "example-ch")).toMatchObject({ domain: "example.ch", aliases: ["example.de"] });
    expect(dns.record("www.example.de", "CNAME")).toBe("acme.example.com");
    const dropped = await makeTenantSetWebsiteDomainDef(prt).planStream!({ ...MOVE, domain: "example.ch", aliases: [] }, planCtx());
    if (dropped.outcome !== "planned") throw new Error("not planned");
    expect(dropped.params.retiredHosts).toEqual(["example.de", "www.example.de"]);
    const steps = makeTenantSetWebsiteDomainDef(prt).steps(dropped.params).slice(1);
    for (const step of steps.slice(0, -1)) await step.run(ctx(params(), step.name, []));
    // The dropped alias's records go only once the site answers at its hosts.
    probe.set("https://example.ch/", { reachable: false, status: 404, detail: "HTTP 404" });
    await expect(steps.at(-1)!.run(ctx(params(), "retire-previous-website-domain", []))).rejects.toThrow(/did not answer/);
    expect(dns.record("www.example.de", "CNAME")).toBe("acme.example.com");
    probe.set("https://example.ch/", OK);
    await steps.at(-1)!.run(ctx(params(), "retire-previous-website-domain", []));
    expect("aliases" in (await registrations.readTenant("prod", GUID))!.entry.apps.find((a) => a.name === "example-ch")!).toBe(false);
    expect([dns.record("example.de", "CNAME"), dns.record("www.example.de", "CNAME")]).toEqual([undefined, undefined]);
  });

  it("refuses an alias that is the domain, named twice, or a host the tenant serves, a domain another website has as alias, nothing changed, and a move to a current alias", async () => {
    seedWebsiteTenant();
    const registrations = tenantWith([{ name: "example-ch", folder: "web", site: "main", domain: "example.ch", aliases: ["example.de"] }, { name: "shop", folder: "web", site: "shop", domain: "example.net", aliases: ["example.it"] }]);
    const def = makeTenantSetWebsiteDomainDef(ports({ registrations }, WEBSITE_APPS));
    await expect(def.planStream!({ ...MOVE, domain: "example.it" }, planCtx())).rejects.toThrow(/example\.it is a host another website/);
    const same = { ...MOVE, domain: "example.ch" };
    await expect(def.planStream!({ ...same, aliases: ["example.ch"] }, planCtx())).rejects.toThrow(/is the domain itself/);
    await expect(def.planStream!({ ...same, aliases: ["example.at", "example.at"] }, planCtx())).rejects.toThrow(/named twice/);
    await expect(def.planStream!({ ...same, aliases: ["example.net"] }, planCtx())).rejects.toThrow(/already serves/);
    await expect(def.planStream!(same, planCtx())).rejects.toThrow(/already served at example\.ch with the aliases example\.de/);
    await expect(def.planStream!({ ...MOVE, domain: "example.de" }, planCtx())).rejects.toThrow(/drop the alias in one run/);
  });

  it("repairs a website that stands at its domain but misses a host record: writes that record alone, and records nothing", async () => {
    seedWebsiteTenant();
    const registrations = tenantWith([{ name: "example-ch", folder: "web", site: "main", domain: "example.ch" }]);
    const dns = new FakeDnsProvider();
    // The apex stands, written for the tenant; www.example.ch was never written.
    dns.seed("example.ch", "CNAME", "acme.example.com");
    recordDnsWrite(db.db, { name: "example.ch", type: "CNAME", content: "acme.example.com", act: "inserted", owner: { kind: "tenant", name: GUID, stage: "prod" }, runId: "run_add" });
    const prt = ports({ registrations, dns, repo: withDomain() }, WEBSITE_APPS);
    const def = makeTenantSetWebsiteDomainDef(prt);
    const planned = await def.planStream!({ ...MOVE, domain: "example.ch" }, planCtx());
    if (planned.outcome !== "planned") throw new Error("not planned");
    expect(planned.params).toMatchObject({ domain: "example.ch", previous: "example.ch", recordHosts: ["www.example.ch"], retiredHosts: [], replacing: [] });
    expect(planned.plan.steps.map((s) => s.name)).toEqual(["attest-target", "check-mail-records", "provision-website-records"]);
    expect(planned.plan.summary).toMatch(/^Write the missing host record www\.example\.ch of website example-ch/);
    const before = (await registrations.readTenant("prod", GUID))!.entry;
    for (const step of def.steps(planned.params).slice(1)) await step.run(ctx(params(), step.name, []));
    expect([dns.record("example.ch", "CNAME"), dns.record("www.example.ch", "CNAME")]).toEqual(["acme.example.com", "acme.example.com"]);
    expect((await registrations.readTenant("prod", GUID))!.entry).toEqual(before);
    // The abort takes back the record it wrote, and only that one; the registration was never touched.
    for (const cleanup of def.cleanups!(planned.params).reverse()) await cleanup.run(ctx(params(), cleanup.name, []));
    expect([dns.record("example.ch", "CNAME"), dns.record("www.example.ch", "CNAME")]).toEqual(["acme.example.com", undefined]);
    expect((await registrations.readTenant("prod", GUID))!.entry).toEqual(before);
  });

  it("refuses a website that stands at its domain with every host record standing, or pointing elsewhere", async () => {
    seedWebsiteTenant();
    const registrations = tenantWith([{ name: "example-ch", folder: "web", site: "main", domain: "example.ch" }]);
    const dns = new FakeDnsProvider();
    dns.seed("example.ch", "CNAME", "acme.example.com");
    dns.seed("www.example.ch", "A", "198.51.100.7"); // a record somebody else wrote: not missing, not this run's
    const def = makeTenantSetWebsiteDomainDef(ports({ registrations, dns, repo: withDomain() }, WEBSITE_APPS));
    await expect(def.planStream!({ ...MOVE, domain: "example.ch" }, planCtx())).rejects.toThrow(/already served at example\.ch, and every host record of it stands/);
  });

  it("names in the repair plan the hosts it leaves alone, where a record somebody else wrote stands", async () => {
    seedWebsiteTenant();
    const registrations = tenantWith([{ name: "example-ch", folder: "web", site: "main", domain: "example.ch", aliases: ["example.de"] }]);
    const dns = new FakeDnsProvider();
    dns.seed("example.ch", "CNAME", "acme.example.com");
    dns.seed("www.example.ch", "CNAME", "acme.example.com");
    dns.seed("example.de", "A", "198.51.100.7"); // not this installation's: left alone
    const def = makeTenantSetWebsiteDomainDef(ports({ registrations, dns, repo: withDomain() }, WEBSITE_APPS));
    const planned = await def.planStream!({ ...MOVE, domain: "example.ch", aliases: ["example.de"] }, planCtx());
    if (planned.outcome !== "planned") throw new Error("not planned");
    expect(planned.params.recordHosts).toEqual(["www.example.de"]);
    expect(planned.plan.summary).toContain("It leaves example.de alone: a record this installation did not write stands there.");
  });

  it("says why it cannot repair where no DNS provider is configured, or the website's zone is managed elsewhere", async () => {
    seedWebsiteTenant();
    const registrations = tenantWith([{ name: "example-ch", folder: "web", site: "main", domain: "example.ch" }]);
    const without = makeTenantSetWebsiteDomainDef(ports({ registrations, repo: withDomain() }, WEBSITE_APPS));
    await expect(without.planStream!({ ...MOVE, domain: "example.ch" }, planCtx())).rejects.toThrow(/already served at example\.ch; no DNS provider is configured on this manager, so its host records are set at the provider of each host/);
    const dns = new FakeDnsProvider();
    dns.unmanaged.push("example.ch");
    const elsewhere = makeTenantSetWebsiteDomainDef(ports({ registrations, dns, repo: withDomain() }, WEBSITE_APPS));
    await expect(elsewhere.planStream!({ ...MOVE, domain: "example.ch" }, planCtx())).rejects.toThrow(/already served at example\.ch; the DNS zone of example\.ch, www\.example\.ch is not managed here, so its records are set at its provider/);
  });

  it("refuses to start where a mail record beside its hosts changed since the plan", async () => {
    seedWebsiteTenant();
    const registrations = tenantWith([{ name: "example-ch", folder: "web", site: "main", domain: "example.ch" }]);
    const dns = new FakeDnsProvider();
    dns.seed("example.org", "MX", "10 mx.example.net");
    dns.seed("_dmarc.example.org", "TXT", "v=DMARC1; p=reject");
    dns.seed("autodiscover.example.org", "CNAME", "autodiscover.mail.example.net");
    const prt = ports({ registrations, dns, repo: withDomain() }, WEBSITE_APPS);
    const planned = await makeTenantSetWebsiteDomainDef(prt).planStream!(MOVE, planCtx());
    if (planned.outcome !== "planned") throw new Error("not planned");
    expect(planned.plan.summary).toMatch(/MX example\.org \(SHA-256 [0-9a-f]{12}\).*TXT _dmarc\.example\.org \(SHA-256 [0-9a-f]{12}\), CNAME autodiscover\.example\.org/);
    dns.seed("_dmarc.example.org", "TXT", "v=DMARC1; p=none");
    const check = makeTenantSetWebsiteDomainDef(prt).steps(planned.params).find((s) => s.name === "check-mail-records")!;
    await expect(check.run(ctx(params(), check.name, []))).rejects.toThrow(/TXT records at _dmarc\.example\.org changed/);
  });
});

describe("create-tenant", () => {
  it("takes no website: a website is added to a standing tenant", () => {
    expect(CreateTenantRequest.shape.apps.safeParse([{ name: "erp" }]).success).toBe(true);
    expect(CreateTenantRequest.shape.apps.safeParse([{ name: "example-ch", folder: "web", site: "main", domain: "example.ch" }]).success).toBe(false);
  });
});
