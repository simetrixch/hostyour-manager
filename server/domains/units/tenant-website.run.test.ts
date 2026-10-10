import { describe, it, expect } from "vitest";
import { makeAddAppDef } from "./add-app.run.ts";
import { CreateTenantRequest } from "./create-tenant.run.ts";
import { tenantApps } from "../../db/schema/inventory.ts";
import { and, eq } from "drizzle-orm";
import { TenantRegistrations } from "./tenant-registrations.ts";
import { FakeRepoWriter } from "../../adapters/git/testing/fake.ts";
import { tenantAppsRepoURL } from "./tenant-apps-tree.ts";
import { parseAppsManifest } from "../../../shared/apps-manifest.ts";
import type { CredentialStore } from "../../security/store.ts";
import { FakeDnsProvider } from "../../adapters/dns/testing/fake.ts";
import { ctx, db, params, planCtx, ports, seededPlatformRepo, seedClusters, useMemoryDb } from "./add-app.fixture.ts";
import { WEBSITE_APPS, tenantWith, websitePorts } from "./tenant-website.fixture.ts";

// A website of a live tenant, added: named after its site, running the bundle's folder `web`, and
// served under the tenant's host — the main website at `/`, every other at `/web/<site>`.

useMemoryDb();

const WEBSITE = { tenantId: "tnt_1", app: "main", folder: "web", site: "main" };

/** The registrations of the fixture's tenant when it runs no bundle of its own yet. */
const withoutBundle = (): TenantRegistrations => new TenantRegistrations(seededPlatformRepo({ appsImage: "", appsImageTag: "" }));

describe("add-app for a website", () => {
  it("plans a website named after its site, running the web folder, served under the tenant's host", async () => {
    seedClusters();
    const def = makeAddAppDef(websitePorts({ dns: new FakeDnsProvider() }));
    const result = await def.planStream!(WEBSITE, planCtx());
    expect(result.outcome).toBe("planned");
    if (result.outcome !== "planned") return;
    expect(result.params.app).toBe("main");
    expect(result.params.website).toEqual({ folder: "web", site: "main" });
    const names = result.plan.steps.map((s) => s.name);
    // Its revalidate secret and its form signing key stand before the append generates the engine and
    // the renderer that read them.
    expect(names.slice(names.indexOf("seed-password-field-key"), names.indexOf("append-app") + 1))
      .toEqual(["seed-password-field-key", "seed-service-key", "seed-revalidate-secret", "seed-form-signing-key", "append-app"]);
    // The two website keys are the tenant's, held by its web server, never the new website's own.
    const titles = def.steps(result.params).filter((s) => s.name === "seed-revalidate-secret" || s.name === "seed-form-signing-key").map((s) => s.title);
    expect(titles).toEqual(["Write the revalidate secret of web", "Write the form signing key of web"]);
    expect(names.slice(names.indexOf("watch-sync-set"))).toEqual(["watch-sync-set", "smoke", "record-inventory"]);
    expect(result.plan.summary).toContain("It is a website of site main. It is served at /web/main of the tenant's host.");
    const main = await def.planStream!({ ...WEBSITE, main: true }, planCtx());
    expect(main.outcome === "planned" && main.plan.summary).toContain("It becomes the main website of the tenant, served at / of the tenant's host.");
  });

  // A tenant without a bundle of its own gets the site's folder from the template.
  it("carries only the site it serves from the template into the bundle of a tenant without one, and lists only that site", async () => {
    seedClusters();
    const sites = { "webs/main/website.json": "{}\n", "webs/shop/website.json": "{}\n" };
    const prt = ports({ dns: new FakeDnsProvider(), registrations: withoutBundle() }, { ...WEBSITE_APPS, ...sites });
    const result = await makeAddAppDef(prt).planStream!(WEBSITE, planCtx());
    if (result.outcome !== "planned") throw new Error(`rejected: ${result.summary}`);
    const p = result.params;
    expect(p.siteFromBundle).toBe(false);
    const writer = new FakeRepoWriter();
    prt.onboard = () => ({ ports: { consumerRepo: writer } }) as unknown as ReturnType<NonNullable<typeof prt.onboard>>;
    const creds = { list: async () => [{ id: "cred_app", subject: { kind: "owner" } }] } as unknown as CredentialStore;
    await makeAddAppDef(prt).steps(p).find((s) => s.name === "write-tree")!.run({ ...ctx(p, "write-tree", []), creds });
    const files = writer.filesFor(tenantAppsRepoURL(p.appsUnit!.org, p.appsUnit!.templateBuild, p.subdomain));
    expect(Object.keys(files).filter((f) => f.startsWith("webs/"))).toEqual(["webs/main/website.json"]);
    expect(parseAppsManifest(files["apps.yaml"]!).apps.find((a) => a.name === "web")?.sites).toEqual(["main"]);
  });

  it("refuses a website not named after its site, and a folder named without its site", async () => {
    seedClusters();
    const def = makeAddAppDef(ports({}, WEBSITE_APPS));
    // The name a website got from its domain before is no name for a new one.
    await expect(def.planStream!({ ...WEBSITE, app: "example-ch" }, planCtx())).rejects.toThrow(/a website of site main is named main, or that name with -2, -3 and on where it is taken, never example-ch/);
    await expect(def.planStream!({ tenantId: "tnt_1", app: "main", folder: "web" }, planCtx())).rejects.toThrow(/a website names its folder and its site/);
  });

  it("takes the numbered name of a site whose id the tenant already carries, and refuses the id itself", async () => {
    seedClusters();
    const registrations = tenantWith([{ name: "main" }]);
    const def = makeAddAppDef(websitePorts({ registrations, dns: new FakeDnsProvider() }));
    await expect(def.planStream!(WEBSITE, planCtx())).rejects.toThrow(/app "main" already exists/);
    const result = await def.planStream!({ ...WEBSITE, app: "main-2" }, planCtx());
    expect(result.outcome === "planned" && result.params.app).toBe("main-2");
  });

  it("refuses a website whose site the catalog carries no folder for under webs/, naming the folder, for a tenant without a bundle", async () => {
    seedClusters();
    const withoutSite = { "apps.yaml": WEBSITE_APPS["apps.yaml"], "webs/shop/website.json": "{}\n" };
    await expect(makeAddAppDef(ports({ registrations: withoutBundle() }, withoutSite)).planStream!(WEBSITE, planCtx())).rejects.toThrow(/carries no webs\/main\/ although its apps\.yaml names it/);
  });

  it("records the site of a website in the inventory, which keeps it out of the Apps list once it is removed", async () => {
    seedClusters();
    const p = params({ app: "main", website: { folder: "web", site: "main" } });
    await makeAddAppDef(ports({})).steps(p).find((s) => s.name === "record-inventory")!.run(ctx(p, "record-inventory", []));
    const site = (name: string) => db.db.select({ site: tenantApps.site }).from(tenantApps).where(and(eq(tenantApps.tenantId, "tnt_1"), eq(tenantApps.name, name))).get()?.site;
    expect(site("main")).toBe("main");
    expect(site("erp")).toBeNull(); // an app's row names no site
    // A website added again under a name its earlier row still holds writes the site on that row too.
    db.db.update(tenantApps).set({ status: "offboarded", site: null }).where(and(eq(tenantApps.tenantId, "tnt_1"), eq(tenantApps.name, "main"))).run();
    await makeAddAppDef(ports({})).steps(p).find((s) => s.name === "record-inventory")!.run(ctx(p, "record-inventory", []));
    expect(site("main")).toBe("main");
  });
});

describe("create-tenant", () => {
  it("takes no website: a website is added to a standing tenant", () => {
    expect(CreateTenantRequest.shape.apps.safeParse([{ name: "erp" }]).success).toBe(true);
    expect(CreateTenantRequest.shape.apps.safeParse([{ name: "example-ch", folder: "web", site: "main" }]).success).toBe(false);
  });
});
