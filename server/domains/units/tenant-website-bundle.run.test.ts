import { describe, it, expect } from "vitest";
import { makeAddAppDef } from "./add-app.run.ts";
import { FakeRepoWriter } from "../../adapters/git/testing/fake.ts";
import { FakeDnsProvider } from "../../adapters/dns/testing/fake.ts";
import { tenantAppsRepoURL } from "./tenant-apps-tree.ts";
import { TenantRegistrations } from "./tenant-registrations.ts";
import { parseAppsManifest } from "../../../shared/apps-manifest.ts";
import type { CredentialStore } from "../../security/store.ts";
import { TEST_BUNDLE } from "./tenant-members.fixture.ts";
import { bundleReleaseTag } from "./engine-line.ts";
import { ctx, params, planCtx, ports, scriptBundle, seededPlatformRepo, useMemoryDb } from "./add-app.fixture.ts";
import { WEBSITE_APPS, seedWebsiteTenant, websitePorts } from "./tenant-website.fixture.ts";

useMemoryDb();

const WEBSITE = { tenantId: "tnt_1", app: "main", folder: "web", site: "main", domain: "example.ch" };

// A tenant that runs its own bundle serves a website's site from it, at the release it stands at: the
// bundle may list sites the template never offered, and the template carries no folder of them.
describe("add-app for a website of the tenant's own bundle", () => {
  const RELEASE = bundleReleaseTag(TEST_BUNDLE.appsImageTag);
  const OWN_SITE = { tenantId: "tnt_1", app: "simplidigita-ai", folder: "web", site: "simplidigita-ai", domain: "simplidigita.ai" };
  const webEntry = (sites: string[]): string => `  - name: web\n    title: Website\n    sites: [${sites.join(", ")}]\n`;
  const manifestOf = (...entries: string[]): string => `apps:\n  - name: erp\n    title: ERP\n${entries.join("")}`;
  const BUNDLE_URL = tenantAppsRepoURL("acme-org", "example-apps", "acme");
  const creds = { list: async () => [{ id: "cred_app", subject: { kind: "owner" } }] } as unknown as CredentialStore;

  /** The write-tree step of a planned run, over a writer whose repository holds `standing`. */
  async function writeTree(prt: ReturnType<typeof ports>, p: ReturnType<typeof params>, standing: Record<string, string>): Promise<Record<string, string>> {
    const writer = new FakeRepoWriter();
    for (const [path, content] of Object.entries(standing)) writer.seed(BUNDLE_URL, path, content);
    prt.onboard = () => ({ ports: { consumerRepo: writer } }) as unknown as ReturnType<NonNullable<typeof prt.onboard>>;
    await makeAddAppDef(prt).steps(p).find((s) => s.name === "write-tree")!.run({ ...ctx(p, "write-tree", []), creds });
    return writer.filesFor(BUNDLE_URL);
  }

  it("plans a site its bundle lists and the template lacks, and the write-tree neither requires nor writes that site's folder from the template", async () => {
    seedWebsiteTenant();
    const prt = websitePorts({ dns: new FakeDnsProvider() });
    scriptBundle(prt, { "apps.yaml": manifestOf(webEntry(["main", "simplidigita-ai"])) });
    const result = await makeAddAppDef(prt).planStream!(OWN_SITE, planCtx());
    if (result.outcome !== "planned") throw new Error(`rejected: ${result.summary}`);
    expect(result.params).toMatchObject({ app: "simplidigita-ai", website: { folder: "web", site: "simplidigita-ai", domain: "simplidigita.ai" }, siteFromBundle: true });
    // The template has no folder webs/simplidigita-ai/: were it asked for one, the plan would refuse.
    // Its folders webs/main/ and webs/shop/ stay out of the tenant's repository, which the bundle serves from.
    const standing = { "apps.yaml": manifestOf(webEntry(["main", "simplidigita-ai"])), "webs/simplidigita-ai/website.json": "the tenant's own\n" };
    const files = await writeTree(prt, result.params, standing);
    expect(Object.keys(files).filter((f) => f.startsWith("webs/"))).toEqual(["webs/simplidigita-ai/website.json"]);
    expect(files["webs/simplidigita-ai/website.json"]).toBe("the tenant's own\n");
    expect(files["apps.yaml"]).toBe(standing["apps.yaml"]);
  });

  it("PLANTED DEFECT: refuses a site its bundle does not list, naming the site, the folder and the release, though the template lists it", async () => {
    seedWebsiteTenant();
    const template = { ...WEBSITE_APPS, "apps.yaml": manifestOf(webEntry(["main", "shop", "simplidigita-ai"])), "webs/simplidigita-ai/website.json": "{}\n" };
    const prt = websitePorts({ dns: new FakeDnsProvider() }, template);
    scriptBundle(prt, { "apps.yaml": manifestOf(webEntry(["main", "shop"])) });
    await expect(makeAddAppDef(prt).planStream!(OWN_SITE, planCtx()))
      .rejects.toThrow(`release ${RELEASE} of ${TEST_BUNDLE.appsRepo} lists no site simplidigita-ai under its folder web, so the website would serve an empty site`);
  });

  it("PLANTED INNOCENT: takes the folder and the site from the template where the bundle carries no website folder", async () => {
    seedWebsiteTenant();
    const prt = websitePorts({ dns: new FakeDnsProvider() });
    scriptBundle(prt, { "apps.yaml": manifestOf() });
    const result = await makeAddAppDef(prt).planStream!(WEBSITE, planCtx());
    if (result.outcome !== "planned") throw new Error(`rejected: ${result.summary}`);
    expect(result.params.siteFromBundle).toBe(false);
    const files = await writeTree(prt, result.params, { "apps.yaml": manifestOf() });
    expect(Object.keys(files).filter((f) => f.startsWith("webs/"))).toEqual(["webs/main/website.json"]);
    expect(parseAppsManifest(files["apps.yaml"]!).apps.find((a) => a.name === "web")?.sites).toEqual(["main"]);
  });

  it("PLANTED DEFECT: refuses a bundle that cannot be read, naming the repository and the release, and plans nothing from the template", async () => {
    seedWebsiteTenant();
    const prt = ports({ dns: new FakeDnsProvider() }, WEBSITE_APPS);
    await expect(makeAddAppDef(prt).planStream!(WEBSITE, planCtx()))
      .rejects.toThrow(`${TEST_BUNDLE.appsRepo} carries no apps.yaml at ${RELEASE}, so the apps the tenant runs cannot be read`);
  });

  it("PLANTED DEFECT: refuses a site listed by a registration whose bundle is not the one this run extends", async () => {
    seedWebsiteTenant();
    const stale = { appsRepo: "https://github.com/acme-org/acme-apps.git", appsImage: "acme-apps", appsImageTag: TEST_BUNDLE.appsImageTag };
    const prt = ports({ dns: new FakeDnsProvider(), registrations: new TenantRegistrations(seededPlatformRepo(stale)) }, WEBSITE_APPS);
    scriptBundle(prt, { "apps.yaml": WEBSITE_APPS["apps.yaml"] }, stale.appsRepo);
    await expect(makeAddAppDef(prt).planStream!(WEBSITE, planCtx()))
      .rejects.toThrow(`the website's site is listed by ${stale.appsRepo}, but the registration names the image acme-apps, and this run builds acme-org/example-apps-acme`);
  });
});
