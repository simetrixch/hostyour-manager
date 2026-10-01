import { describe, it, expect } from "vitest";
import { seedQuota } from "#unit/shared/unit-size.ts";
import { tenantZone } from "#unit/shared/unit-host.ts";
import { FakePublicProbe } from "#unit/server/adapters/http-probe/testing/fake.ts";
import { makeAddAppDef } from "./add-app.run.ts";
import { makeRemoveAppDef } from "./tenant-lifecycle.run.ts";
import { makeTenantSetOwnDomainDef, TenantSetOwnDomainParams } from "./tenant-own-domain.run.ts";
import { CreateTenantRequest } from "./create-tenant.run.ts";
import { tenants } from "../../db/schema/inventory.ts";
import { eq } from "drizzle-orm";
import { makeTenantSetWebsiteDomainDef } from "./tenant-website-domain.run.ts";
import { TENANT_MANIFEST_PATH } from "./gates/tenant-gates.ts";
import { recordDnsWrite } from "../../db/dns-writes.ts";
import { TenantRegistrations, tenantRegistrationWrite } from "./tenant-registrations.ts";
import { FakePlatformRepo, FakeRepoReader, FakeRepoWriter } from "../../adapters/git/testing/fake.ts";
import { tenantAppsRepoURL } from "./tenant-apps-tree.ts";
import { parseAppsManifest } from "../../../shared/apps-manifest.ts";
import type { CredentialStore } from "../../security/store.ts";
import { FakeDnsProvider } from "../../adapters/dns/testing/fake.ts";
import { TenantRegistrationSchema } from "../../../shared/tenant.ts";
import { testMembers, APP_OVERLAYS, TEST_BUNDLE } from "./tenant-members.fixture.ts";
import { GUID, MANIFEST_YAML, SHA, ctx, db, params, planCtx, ports, seedClusters, useMemoryDb } from "./add-app.fixture.ts";

// A website of a live tenant, added, moved and removed: named after its site, running the bundle's
// folder `web`, served at <domain> with www.<domain> redirecting there, its hosts pointed at the
// tenant's zone while it stands.

useMemoryDb();

/** The template's catalog with a website folder: `web` carries the sites main and shop. */
const WEBSITE_APPS = {
  "apps.yaml": "apps:\n  - name: erp\n    title: ERP\n  - name: web\n    title: Website\n    sites: [main, shop]\n",
};
const WEBSITE = { tenantId: "tnt_1", app: "main", folder: "web", site: "main", domain: "example.ch" };
const OK = { reachable: true, status: 200, detail: "HTTP 200" };
const REDIRECTS = { reachable: true, status: 307, detail: "HTTP 307" };

/** The live tenant of the fixture, on path routing: a website's hosts point at its zone, which has a
 *  record of its own only there. */
function seedWebsiteTenant(): void {
  seedClusters();
  db.db.update(tenants).set({ routing: "path" }).where(eq(tenants.id, "tnt_1")).run();
}

/** A second live tenant's registration on the same books branch, serving a website at `domain`. */
function seedOtherTenantWebsite(repo: FakePlatformRepo, domain: string): void {
  const apps = [{ name: "shop-site", folder: "web", site: "shop", domain }];
  const registration = TenantRegistrationSchema.parse({ cluster: "s1", subdomain: "other", members: testMembers(apps), identityProvider: "auth", apps, quota: seedQuota("small"), ...TEST_BUNDLE });
  const w = tenantRegistrationWrite("prod", "b2b2b2b2b2b2", registration);
  repo.seed(repo.booksBranch, w.path, w.content);
}

/** A live tenant whose registration carries `apps` beside erp, and optionally an own domain. */
function tenantWith(apps: readonly { name: string; [field: string]: string }[], own: { ownDomain: string; ownDomainRedirects: string[] } = { ownDomain: "", ownDomainRedirects: [] }, repo = new FakePlatformRepo()): TenantRegistrations {
  const all = [{ name: "erp" }, ...apps];
  const registration = TenantRegistrationSchema.parse({
    cluster: "s1", subdomain: "acme", members: testMembers(all), identityProvider: "auth", apps: all, quota: seedQuota("small"), ...TEST_BUNDLE,
    ...(own.ownDomain ? { routing: "path", ...own } : {}),
  });
  const w = tenantRegistrationWrite("prod", GUID, registration);
  repo.seed(repo.booksBranch, w.path, w.content);
  return new TenantRegistrations(repo);
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
    // Its revalidate secret stands before the append generates the engine that reads it.
    expect(names.slice(names.indexOf("seed-password-field-key"), names.indexOf("append-app") + 1)).toEqual(["seed-password-field-key", "seed-revalidate-secret", "append-app"]);
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
    const registrations = tenantWith([{ name: "main", folder: "web", site: "main", domain: "example.net" }]);
    const def = makeAddAppDef(ports({ registrations, dns: new FakeDnsProvider() }, WEBSITE_APPS));
    await expect(def.planStream!(WEBSITE, planCtx())).rejects.toThrow(/app "main" already exists/);
    const result = await def.planStream!({ ...WEBSITE, app: "main-2" }, planCtx());
    expect(result.outcome === "planned" && result.params.app).toBe("main-2");
  });

  it("lists an address record at a website host in the plan, replaces it with the CNAME, and writes it back on abort", async () => {
    seedWebsiteTenant();
    const dns = new FakeDnsProvider();
    dns.seed("www.example.ch", "A", "192.0.2.10");
    const result = await makeAddAppDef(ports({ dns }, WEBSITE_APPS)).planStream!(WEBSITE, planCtx());
    if (result.outcome !== "planned") throw new Error("the website was not planned");
    expect(result.params.websiteReplacing).toEqual([{ name: "www.example.ch", type: "A", content: "192.0.2.10" }]);
    expect(result.plan.summary).toContain("It deletes A www.example.ch → 192.0.2.10, which this installation did not write, and an abort writes it back.");
    const p = params({ website: { folder: "web", site: "main", domain: "example.ch" }, websiteRecordHosts: ["www.example.ch", "example.ch"], websiteReplacing: result.params.websiteReplacing });
    const def = makeAddAppDef(ports({ dns }));
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

  it("points both hosts at the tenant's zone, then waits until the site answers at its domain and its www host redirects", async () => {
    seedWebsiteTenant();
    const dns = new FakeDnsProvider();
    const probe = new FakePublicProbe({ "https://example.ch/": OK, "https://www.example.ch/": REDIRECTS });
    const p = params({ website: { folder: "web", site: "main", domain: "example.ch" }, websiteRecordHosts: ["example.ch", "www.example.ch"] });
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
    const p = params({ website: { folder: "web", site: "main", domain: "example.ch" }, websiteRecordHosts: ["www.example.ch", "example.ch"] });
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
});

describe("tenant-set-website-domain", () => {
  /** The deploy repository's manifest with the website front handing its chart the domain, as the
   *  product's own does, so a member resolved again shows which domain it was resolved with. */
  const withDomain = () => new FakeRepoReader({
    resolvedSha: SHA,
    files: { [TENANT_MANIFEST_PATH]: MANIFEST_YAML.replace("override: { web: { chart: charts/example-web } }", 'override: { web: { chart: charts/example-web, values: { site: { domain: "{domain}" } } } }'), ...APP_OVERLAYS },
  });
  const MOVE = { tenantId: "tnt_1", app: "example-ch", domain: "example.org" };

  it("plans the move with the member resolved again at the new domain, the new hosts' records and the previous hosts' removal", async () => {
    seedWebsiteTenant();
    const registrations = tenantWith([{ name: "example-ch", folder: "web", site: "main", domain: "example.ch" }]);
    const result = await makeTenantSetWebsiteDomainDef(ports({ registrations, repo: withDomain() }, WEBSITE_APPS)).planStream!(MOVE, planCtx());
    expect(result.outcome).toBe("planned");
    if (result.outcome !== "planned") return;
    expect(result.params).toMatchObject({ previous: "example.ch", domain: "example.org", recordHosts: ["example.org", "www.example.org"], retiredHosts: ["example.ch", "www.example.ch"] });
    expect(result.params.member.sources[1]!.values).toEqual({ site: { domain: "example.org" } });
    expect(result.plan.steps.map((s) => s.name)).toEqual(["attest-target", "provision-website-records", "write-website-domain", "retire-previous-website-domain"]);
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

  it("records the new domain and member in one commit, and removes the previous hosts' records once the site answers; an abort puts the previous ones back", async () => {
    seedWebsiteTenant();
    const registrations = tenantWith([{ name: "example-ch", folder: "web", site: "main", domain: "example.ch" }]);
    const dns = new FakeDnsProvider();
    for (const name of ["www.example.ch", "example.ch"]) {
      dns.seed(name, "CNAME", "acme.example.com");
      recordDnsWrite(db.db, { name, type: "CNAME", content: "acme.example.com", act: "inserted", owner: { kind: "tenant", name: GUID, stage: "prod" }, runId: "run_add" });
    }
    const probe = new FakePublicProbe({ "https://example.org/": OK, "https://www.example.org/": REDIRECTS });
    const prt = ports({ registrations, dns, probe, repo: withDomain() }, WEBSITE_APPS);
    const planned = await makeTenantSetWebsiteDomainDef(prt).planStream!(MOVE, planCtx());
    if (planned.outcome !== "planned") throw new Error("not planned");
    const def = makeTenantSetWebsiteDomainDef(prt);
    for (const step of def.steps(planned.params).slice(1)) await step.run(ctx(params(), step.name, []));
    const moved = (await registrations.readTenant("prod", GUID))!.entry;
    expect(moved.apps.find((a) => a.name === "example-ch")?.domain).toBe("example.org");
    expect(moved.members.find((m) => m.name === "example-ch")).toEqual(planned.params.member);
    expect([dns.record("www.example.org", "CNAME"), dns.record("www.example.ch", "CNAME"), dns.record("example.ch", "CNAME")]).toEqual(["acme.example.com", undefined, undefined]);
    // The abort writes the previous domain and member back.
    for (const cleanup of def.cleanups!(planned.params).reverse()) await cleanup.run(ctx(params(), cleanup.name, []));
    expect((await registrations.readTenant("prod", GUID))!.entry.apps.find((a) => a.name === "example-ch")?.domain).toBe("example.ch");
  });

  it("puts nothing back on abort once another run moved the website on", async () => {
    seedWebsiteTenant();
    const registrations = tenantWith([{ name: "example-ch", folder: "web", site: "main", domain: "example.ch" }]);
    const prt = ports({ registrations, repo: withDomain() }, WEBSITE_APPS);
    const planned = await makeTenantSetWebsiteDomainDef(prt).planStream!(MOVE, planCtx());
    if (planned.outcome !== "planned") throw new Error("not planned");
    await registrations.setWebsiteDomain("prod", GUID, "example-ch", "example.net", planned.params.member, "run_other");
    const restore = makeTenantSetWebsiteDomainDef(prt).cleanups!(planned.params).find((c) => c.name === "restore-website-domain")!;
    const logs: string[] = [];
    await restore.run(ctx(params(), restore.name, logs));
    expect((await registrations.readTenant("prod", GUID))!.entry.apps.find((a) => a.name === "example-ch")?.domain).toBe("example.net");
    expect(logs.some((l) => l.includes("stands at example.net now"))).toBe(true);
  });
});

describe("create-tenant", () => {
  it("takes no website: a website is added to a standing tenant", () => {
    expect(CreateTenantRequest.shape.apps.safeParse([{ name: "erp" }]).success).toBe(true);
    expect(CreateTenantRequest.shape.apps.safeParse([{ name: "example-ch", folder: "web", site: "main", domain: "example.ch" }]).success).toBe(false);
  });
});
