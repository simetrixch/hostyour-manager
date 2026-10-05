import { describe, it, expect } from "vitest";
import { FakeRepoReader, FakePlatformRepo } from "../../adapters/git/testing/fake.ts";
import { FakeRegistryProbe } from "../../adapters/registry/testing/fake.ts";
import { TENANT_MANIFEST_PATH } from "./gates/tenant-gates.ts";
import { tenantRegistrationWrite } from "./tenant-registrations.ts";
import { APP_OVERLAYS, TEST_BUNDLE } from "./tenant-members.fixture.ts";
import { GUID, MANIFEST_YAML, SHA, ctx, db, params, planCtx, ports, useMemoryDb } from "./add-app.fixture.ts";
import { WEBSITE_APPS, seedWebsiteTenant, tenantWith } from "./tenant-website.fixture.ts";
import { makeTenantSetWebsiteSiteDef } from "./tenant-website-site.run.ts";

// A website of a live tenant moved to another site of the tenant's bundle: the site, its member and the
// bundle release that carries the site, written together, and never moved back by an abort.

useMemoryDb();

describe("tenant-set-website-site", () => {
  /** The deploy repository's manifest with the website front handing its chart the site, as the
   *  product's own does, so a member resolved again shows which site it was resolved with. */
  const withSite = () => new FakeRepoReader({
    resolvedSha: SHA,
    files: { [TENANT_MANIFEST_PATH]: MANIFEST_YAML.replace("override: { web: { chart: charts/example-web } }", 'override: { web: { chart: charts/example-web, values: { site: { id: "{site}" } } } }'), ...APP_OVERLAYS },
  });
  /** The release the website moves onto: a later one of the tenant's own bundle, whose apps.yaml lists
   *  the renamed site under the website folder. */
  const TARGET = "0.1.1-stable-20260201000000-def5678";
  const TARGET_RELEASE = "0.1.1-stable-20260201000000";
  const RENAMED_APPS = "apps:\n  - name: erp\n    title: ERP\n  - name: web\n    title: Website\n    sites: [main, renamed]\n";
  const RENAME = { tenantId: "tnt_1", app: "example-ch", site: "renamed", appsImageTag: TARGET };
  /** A repository reader holding the bundle release `apps` at `release`, beside the deploy manifest. */
  const repoWith = (apps = RENAMED_APPS, release = TARGET_RELEASE) => {
    const repo = withSite();
    repo.scriptFor(`${TEST_BUNDLE.appsRepo}@${release}`, { resolvedSha: SHA, files: { "apps.yaml": apps } });
    return repo;
  };
  const website = [{ name: "example-ch", folder: "web", site: "main", domain: "example.ch" }];

  it("plans the site and the bundle release in one move, with the member resolved again at the new site", async () => {
    seedWebsiteTenant();
    const registrations = tenantWith(website);
    const result = await makeTenantSetWebsiteSiteDef(ports({ registrations, repo: repoWith() }, WEBSITE_APPS)).planStream!(RENAME, planCtx());
    expect(result.outcome === "planned" ? "planned" : result.summary).toBe("planned");
    if (result.outcome !== "planned") return;
    expect(result.params).toMatchObject({ app: "example-ch", previousSite: "main", site: "renamed", previousAppsImageTag: TEST_BUNDLE.appsImageTag, appsImageTag: TARGET });
    expect(result.params.member.sources[1]!.values).toEqual({ site: { id: "renamed" } });
    expect(result.plan.steps.map((s) => s.name)).toEqual(["attest-target", "write-website-site"]);
    // Before approval the plan says that the move cannot be undone.
    expect(result.plan.summary).toMatch(/no abort moves it back/);
  });

  it("refuses an app that is no website, the site it serves, a site another website serves, and a site the release does not list", async () => {
    seedWebsiteTenant();
    const registrations = tenantWith([...website, { name: "shop", folder: "web", site: "shop", domain: "example.net" }]);
    const def = makeTenantSetWebsiteSiteDef(ports({ registrations, repo: repoWith("apps:\n  - name: web\n    title: Website\n    sites: [main, renamed, shop]\n") }, WEBSITE_APPS));
    await expect(def.planStream!({ ...RENAME, app: "erp" }, planCtx())).rejects.toThrow(/is no website/);
    await expect(def.planStream!({ ...RENAME, site: "main" }, planCtx())).rejects.toThrow(/already serves site main/);
    await expect(def.planStream!({ ...RENAME, site: "shop" }, planCtx())).rejects.toThrow(/already the site of website "shop"/);
    await expect(def.planStream!({ ...RENAME, site: "other" }, planCtx())).rejects.toThrow(/release 0\.1\.1-stable-20260201000000 of .* lists no site other under its folder web/);
  });

  it("refuses a bundle that is no image tag, one older than the tenant runs, one off the engines' line, and one the registry does not hold", async () => {
    seedWebsiteTenant();
    const def = (over: Parameters<typeof ports>[0]) => makeTenantSetWebsiteSiteDef(ports({ registrations: tenantWith(website), ...over }, WEBSITE_APPS));
    await expect(def({ repo: repoWith() }).planStream!({ ...RENAME, appsImageTag: "latest" }, planCtx())).rejects.toThrow();
    const older = "0.0.9-stable-20251201000000-0123456";
    await expect(def({ repo: repoWith(RENAMED_APPS, "0.0.9-stable-20251201000000") }).planStream!({ ...RENAME, appsImageTag: older }, planCtx())).rejects.toThrow(/older than 0\.1\.0-stable-20260101000000-abc1234, the bundle the tenant runs/);
    // The tenant's engines run line 0.1; a bundle written for line 0.9 cannot run beside them.
    const engines = new FakePlatformRepo();
    const onLine = tenantWith(website, undefined, engines);
    const entry = (await onLine.readTenant("prod", GUID))!.entry;
    const w = tenantRegistrationWrite("prod", GUID, { ...entry, approvedTags: { "example-ch": { "example-engine": "0.1.0-stable-20260101000000-abc1234" } } });
    engines.seed(engines.booksBranch, w.path, w.content);
    const offLine = makeTenantSetWebsiteSiteDef(ports({ registrations: onLine, repo: repoWith(`engine:\n  build: example-engine\n  line: "0.9"\n${RENAMED_APPS}`) }, WEBSITE_APPS));
    await expect(offLine.planStream!(RENAME, planCtx())).rejects.toThrow(/written for example-engine 0\.9/);
    const missing = def({ repo: repoWith(), registryProbe: new FakeRegistryProbe({ missing: [`${TEST_BUNDLE.appsImage}:${TARGET}`] }) });
    await expect(missing.planStream!(RENAME, planCtx())).rejects.toThrow(new RegExp(`${TEST_BUNDLE.appsImage}:${TARGET} is not in the registry`));
  });

  it("PLANTED DEFECT: writes the site, the member and the bundle release in one commit, and keeps the website's databases", async () => {
    seedWebsiteTenant();
    const books = new FakePlatformRepo();
    const registrations = tenantWith(website, undefined, books);
    const before = (await registrations.readTenant("prod", GUID))!.entry;
    const prt = ports({ registrations, repo: repoWith() }, WEBSITE_APPS);
    const planned = await makeTenantSetWebsiteSiteDef(prt).planStream!(RENAME, planCtx());
    if (planned.outcome !== "planned") throw new Error(planned.summary);
    const commits = books.commits.length;
    const def = makeTenantSetWebsiteSiteDef(prt);
    for (const step of def.steps(planned.params).slice(1)) await step.run(ctx(params(), step.name, []));
    expect(books.commits.length).toBe(commits + 1);
    const moved = (await registrations.readTenant("prod", GUID))!.entry;
    expect(moved.appsImageTag).toBe(TARGET);
    expect(moved.apps.find((a) => a.name === "example-ch")).toEqual({ ...before.apps.find((a) => a.name === "example-ch"), site: "renamed" });
    expect(moved.members.find((m) => m.name === "example-ch")).toEqual(planned.params.member);
    // Nothing else of the tenant moves: its other apps and members stay as they stood.
    expect(moved.apps.filter((a) => a.name !== "example-ch")).toEqual(before.apps.filter((a) => a.name !== "example-ch"));
    expect(moved.members.filter((m) => m.name !== "example-ch")).toEqual(before.members.filter((m) => m.name !== "example-ch"));
    // A resume finds its own write standing and writes nothing more.
    for (const step of def.steps(planned.params).slice(1)) await step.run(ctx(params(), step.name, []));
    expect(books.commits.length).toBe(commits + 1);
  });

  it("refuses to write where another run moved the website or the bundle since the plan", async () => {
    seedWebsiteTenant();
    const registrations = tenantWith(website);
    const prt = ports({ registrations, repo: repoWith() }, WEBSITE_APPS);
    const planned = await makeTenantSetWebsiteSiteDef(prt).planStream!(RENAME, planCtx());
    if (planned.outcome !== "planned") throw new Error(planned.summary);
    await registrations.setWebsiteDomain("prod", GUID, "example-ch", "example.org", [], planned.params.previousMember, "run_other");
    const write = makeTenantSetWebsiteSiteDef(prt).steps(planned.params).find((s) => s.name === "write-website-site")!;
    // The member the plan resolved carries the previous domain; written now, it would move the website back.
    await expect(write.run(ctx(params(), write.name, []))).rejects.toThrow(/plan it again/);
    const other = tenantWith(website);
    const prt2 = ports({ registrations: other, repo: repoWith() }, WEBSITE_APPS);
    const planned2 = await makeTenantSetWebsiteSiteDef(prt2).planStream!(RENAME, planCtx());
    if (planned2.outcome !== "planned") throw new Error(planned2.summary);
    const entry = (await other.readTenant("prod", GUID))!.entry;
    await other.setTenantAppsRepo("prod", GUID, { appsRepo: entry.appsRepo!, appsImage: entry.appsImage!, appsImageTag: "0.1.2-stable-20260301000000-fedcba9" }, "run_other");
    const write2 = makeTenantSetWebsiteSiteDef(prt2).steps(planned2.params).find((s) => s.name === "write-website-site")!;
    await expect(write2.run(ctx(params(), write2.name, []))).rejects.toThrow(/plan it again/);
  });

  it("refuses an abort once the new site is written: the catalog's migration renames the records on the first boot", async () => {
    seedWebsiteTenant();
    const registrations = tenantWith(website);
    const prt = ports({ registrations, repo: repoWith() }, WEBSITE_APPS);
    const def = makeTenantSetWebsiteSiteDef(prt);
    const planned = await def.planStream!(RENAME, planCtx());
    if (planned.outcome !== "planned") throw new Error(planned.summary);
    expect(def.cleanups?.(planned.params) ?? []).toEqual([]);
    await expect(def.assertAbortable!(planned.params, { db: db.db })).resolves.toBeUndefined();
    for (const step of def.steps(planned.params).slice(1)) await step.run(ctx(params(), step.name, []));
    await expect(def.assertAbortable!(planned.params, { db: db.db })).rejects.toThrow(/cannot be undone/);
  });
});
