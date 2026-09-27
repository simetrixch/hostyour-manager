import { describe, it, expect } from "vitest";
import { seedQuota } from "#unit/shared/unit-size.ts";
import { tenantZone } from "#unit/shared/unit-host.ts";
import { FakePublicProbe } from "#unit/server/adapters/http-probe/testing/fake.ts";
import { makeAddAppDef } from "./add-app.run.ts";
import { makeRemoveAppDef } from "./tenant-lifecycle.run.ts";
import { recordDnsWrite } from "../../db/dns-writes.ts";
import { TenantRegistrations, tenantRegistrationWrite } from "./tenant-registrations.ts";
import { FakePlatformRepo } from "../../adapters/git/testing/fake.ts";
import { FakeDnsProvider } from "../../adapters/dns/testing/fake.ts";
import { TenantRegistrationSchema } from "../../../shared/tenant.ts";
import { testMembers, TEST_BUNDLE } from "./tenant-members.fixture.ts";
import { GUID, ctx, db, params, planCtx, ports, seedClusters, useMemoryDb } from "./add-app.fixture.ts";

// A website of a live tenant (#308), added and removed: named by its domain, running the bundle's
// folder `web`, served at www.<domain> with <domain> redirecting there, its hosts pointed at the
// tenant's zone while it stands.

useMemoryDb();

/** The template's catalog with a website folder: `web` carries the sites main and shop. */
const WEBSITE_APPS = {
  "apps.yaml": "apps:\n  - name: erp\n    title: ERP\n  - name: web\n    title: Website\n    sites: [main, shop]\n",
};
const WEBSITE = { tenantId: "tnt_1", app: "example-ch", folder: "web", site: "main", domain: "example.ch" };
const OK = { reachable: true, status: 200, detail: "HTTP 200" };
const REDIRECTS = { reachable: true, status: 307, detail: "HTTP 307" };

/** A live tenant whose registration carries `apps` beside erp, and optionally an own domain. */
function tenantWith(apps: readonly { name: string; [field: string]: string }[], own: { ownDomain: string; ownDomainRedirects: string[] } = { ownDomain: "", ownDomainRedirects: [] }): TenantRegistrations {
  const repo = new FakePlatformRepo();
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
  it("plans a website named by its domain, running the web folder, with the records of both its hosts", async () => {
    seedClusters();
    const def = makeAddAppDef(ports({ dns: new FakeDnsProvider() }, WEBSITE_APPS));
    const result = await def.planStream!(WEBSITE, planCtx());
    expect(result.outcome).toBe("planned");
    if (result.outcome !== "planned") return;
    expect(result.params.website).toEqual({ folder: "web", site: "main", domain: "example.ch" });
    expect(result.params.websiteRecordHosts).toEqual(["www.example.ch", "example.ch"]);
    const names = result.plan.steps.map((s) => s.name);
    expect(names.slice(names.indexOf("watch-sync-set"))).toEqual(["watch-sync-set", "provision-website-records", "wait-website", "smoke", "record-inventory"]);
    expect(result.plan.summary).toContain("website of site main, served at www.example.ch, and example.ch redirects there");
  });

  it("refuses a website not named by its domain, a domain typed with www, and a domain another website serves", async () => {
    seedClusters();
    const def = makeAddAppDef(ports({}, WEBSITE_APPS));
    await expect(def.planStream!({ ...WEBSITE, app: "example" }, planCtx())).rejects.toThrow(/is named example-ch/);
    await expect(def.planStream!({ ...WEBSITE, app: "www-example-ch", domain: "www.example.ch" }, planCtx())).rejects.toThrow(/type the domain without \\"www\.\\"/);
    // A moved website keeps its name, so the domain is held on its own.
    const moved = tenantWith([{ name: "old-site", folder: "web", site: "shop", domain: "example.ch" }]);
    await expect(makeAddAppDef(ports({ registrations: moved }, WEBSITE_APPS)).planStream!(WEBSITE, planCtx())).rejects.toThrow(/example\.ch is already the domain of website "old-site"/);
  });

  it("writes no record for a website on the tenant's own domain, whose records tenant-set-own-domain holds", async () => {
    seedClusters();
    const own = tenantWith([], { ownDomain: "www.example.ch", ownDomainRedirects: ["example.ch"] });
    const result = await makeAddAppDef(ports({ registrations: own }, WEBSITE_APPS)).planStream!(WEBSITE, planCtx());
    expect(result.outcome === "planned" && result.params.websiteRecordHosts).toEqual([]);
  });

  it("points both hosts at the tenant's zone, then waits until the site answers and its bare domain redirects", async () => {
    seedClusters();
    const dns = new FakeDnsProvider();
    const probe = new FakePublicProbe({ "https://www.example.ch/": OK, "https://example.ch/": REDIRECTS });
    const p = params({ website: { folder: "web", site: "main", domain: "example.ch" }, websiteRecordHosts: ["www.example.ch", "example.ch"] });
    const steps = makeAddAppDef(ports({ dns, probe })).steps(p);
    const logs: string[] = [];
    for (const name of ["provision-website-records", "wait-website"]) await steps.find((s) => s.name === name)!.run(ctx(p, name, logs));
    const zone = tenantZone("acme", "prod", "example.com");
    expect([dns.record("www.example.ch", "CNAME"), dns.record("example.ch", "CNAME")]).toEqual([zone, zone]);
    expect(probe.probed).toEqual(["https://www.example.ch/", "https://example.ch/"]);
    expect(logs.some((l) => l.includes("https://example.ch/ redirects"))).toBe(true);
  });

  it("removes a website's records while the registration still names its domain", async () => {
    seedClusters();
    const dns = new FakeDnsProvider();
    for (const name of ["www.example.ch", "example.ch"]) {
      dns.seed(name, "CNAME", "acme.example.com");
      recordDnsWrite(db.db, { name, type: "CNAME", content: "acme.example.com", act: "inserted", owner: { kind: "tenant", name: GUID, stage: "prod" }, runId: "run_add" });
    }
    const registrations = tenantWith([{ name: "example-ch", folder: "web", site: "main", domain: "example.ch" }]);
    const step = makeRemoveAppDef(ports({ dns, registrations })).steps({ tenantId: "tnt_1", app: "example-ch" }).find((s) => s.name === "remove-website-records")!;
    await step.run(ctx(params(), step.name, []));
    expect([dns.record("www.example.ch", "CNAME"), dns.record("example.ch", "CNAME")]).toEqual([undefined, undefined]);
  });
});
