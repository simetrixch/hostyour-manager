import { describe, it, expect } from "vitest";
import { makeAddAppDef, type AddAppParams } from "./add-app.run.ts";
import { FakeRepoReader, FakeRepoWriter } from "../../adapters/git/testing/fake.ts";
import { FakeBuildPlane } from "../../adapters/build-plane/testing/fake.ts";
import { FakeGitHubConsumer } from "#unit/server/adapters/github-consumer/testing/fake.ts";
import { clusters, servers } from "../../db/schema/inventory.ts";
import { refreshImagesStep } from "./tenant-builds.ts";
import { ports as onboardPorts, FakeBuildPlaneClusterReader } from "./onboard.fixture.ts";
import { FakeDnsProvider } from "../../adapters/dns/testing/fake.ts";
import { tenantAppsManifest, tenantAppsRepoURL } from "./tenant-apps-tree.ts";
import { TenantRegistrations } from "./tenant-registrations.ts";
import { parseAppsManifest } from "../../../shared/apps-manifest.ts";
import type { CredentialStore } from "../../security/store.ts";
import { TEST_BUNDLE } from "./tenant-members.fixture.ts";
import { bundleReleaseTag } from "./engine-line.ts";
import { GUID, NEW_APP, REGISTRY_HOST, ctx, db, params, planCtx, ports, scriptBundle, seededPlatformRepo, TEMPLATE_APPS, useMemoryDb } from "./add-app.fixture.ts";
import { BUNDLE, ORG, SHA, TEMPLATE_MANIFEST, TEMPLATE_URL, UNIT } from "./tenant-apps-repo.fixture.ts";
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

  /** The write-tree step of a planned run, over a writer whose repository holds `standing`; the writer
   *  and the log are the caller's where the test reads the commits and what the step said. */
  async function writeTree(prt: ReturnType<typeof ports>, p: ReturnType<typeof params>, standing: Record<string, string>, writer = new FakeRepoWriter(), logs: string[] = []): Promise<Record<string, string>> {
    for (const [path, content] of Object.entries(standing)) writer.seed(BUNDLE_URL, path, content);
    prt.onboard = () => ({ ports: { consumerRepo: writer } }) as unknown as ReturnType<NonNullable<typeof prt.onboard>>;
    await makeAddAppDef(prt).steps(p).find((s) => s.name === "write-tree")!.run({ ...ctx(p, "write-tree", logs), creds });
    return writer.filesFor(BUNDLE_URL);
  }
  // The manifest a standing bundle carries: every stage of the template's, so the step has no manifest to add.
  const STANDING_MANIFEST = tenantAppsManifest({ unit: UNIT, owner: "platform", envs: ["dev", "test", "prod"], containerfile: "docker/Dockerfile" });
  const HELPER = { "scripts/helper.mjs": "export const helper = true;\n" };

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

  it("PLANTED DEFECT: copies no template file into the bundle for a site it lists, though the repository lacks a root file of the template, and logs that nothing is committed", async () => {
    seedWebsiteTenant();
    const prt = websitePorts({ dns: new FakeDnsProvider() }, { ...WEBSITE_APPS, ...HELPER });
    scriptBundle(prt, { "apps.yaml": manifestOf(webEntry(["main", "simplidigita-ai"])) });
    const result = await makeAddAppDef(prt).planStream!(OWN_SITE, planCtx());
    if (result.outcome !== "planned") throw new Error(`rejected: ${result.summary}`);
    const standing = { "apps.yaml": manifestOf(webEntry(["main", "simplidigita-ai"])), "deploy/platform.yaml": STANDING_MANIFEST, "webs/simplidigita-ai/website.json": "the tenant's own\n" };
    const writer = new FakeRepoWriter();
    const logs: string[] = [];
    const files = await writeTree(prt, result.params, standing, writer, logs);
    expect(writer.commits).toEqual([]);
    expect(logs.some((l) => l.includes("nothing to commit"))).toBe(true);
    expect(files).toEqual(standing);
  });

  it("PLANTED INNOCENT: a new tenant gets its first tree from the template, the root files included", async () => {
    seedWebsiteTenant();
    const registrations = new TenantRegistrations(seededPlatformRepo({ appsImage: "", appsImageTag: "" }));
    const prt = ports({ dns: new FakeDnsProvider(), registrations }, { ...WEBSITE_APPS, ...HELPER });
    const result = await makeAddAppDef(prt).planStream!(WEBSITE, planCtx());
    if (result.outcome !== "planned") throw new Error(`rejected: ${result.summary}`);
    expect(result.params.siteFromBundle).toBe(false);
    const files = await writeTree(prt, result.params, {});
    expect(Object.keys(files)).toEqual(expect.arrayContaining(["scripts/helper.mjs", "package.json", "deploy/platform.yaml", "apps.yaml", "webs/main/website.json"]));
  });

  it("adding a template app to a standing bundle still writes the root files the repository lacks", async () => {
    seedWebsiteTenant();
    const prt = ports({ dns: new FakeDnsProvider() }, { ...TEMPLATE_APPS(), ...HELPER });
    const result = await makeAddAppDef(prt).planStream!({ tenantId: "tnt_1", app: NEW_APP }, planCtx());
    if (result.outcome !== "planned") throw new Error(`rejected: ${result.summary}`);
    expect(result.params.siteFromBundle).toBe(false);
    const writer = new FakeRepoWriter();
    const files = await writeTree(prt, result.params, { "apps.yaml": manifestOf(), "deploy/platform.yaml": STANDING_MANIFEST }, writer);
    expect(writer.commits).toHaveLength(1);
    expect(Object.keys(files)).toEqual(expect.arrayContaining(["scripts/helper.mjs", "package.json", `apps/${NEW_APP}/package.json`]));
  });

  it("names the tenant's bundle, its site and its release in the plan's summary, log and write-tree title for a site it lists, and not the template", async () => {
    seedWebsiteTenant();
    const prt = websitePorts({ dns: new FakeDnsProvider() });
    scriptBundle(prt, { "apps.yaml": manifestOf(webEntry(["main", "simplidigita-ai"])) });
    const logs: string[] = [];
    const result = await makeAddAppDef(prt).planStream!(OWN_SITE, { ...planCtx(), log: (line) => logs.push(line) });
    if (result.outcome !== "planned") throw new Error(`rejected: ${result.summary}`);
    const served = `${ORG}/${TEST_BUNDLE.appsImage} serves the site simplidigita-ai it lists at release ${RELEASE}`;
    expect(result.plan.summary).toContain(served);
    expect(result.plan.summary).not.toContain(TEMPLATE_URL);
    expect(result.plan.steps.find((step) => step.name === "write-tree")?.title).toBe(`Write the tree of ${UNIT}, copying no file from the deploy repository's ${BUNDLE}`);
    const line = logs.find((l) => l.includes(served));
    expect(line).toBeDefined();
    expect(line).not.toContain(TEMPLATE_URL);
  });

  // After the build the run renders the fan-out again against the bundle it just released, and judges
  // the site there: the template's folder lists no such site, so it is the bundle's manifest at the
  // release the build wrote that has to say it.
  describe("refresh-images, after the bundle is built", () => {
    const BUILT_TAG = "0.1.1-stable-20260102000000-def5678";
    const BUILT_RELEASE = bundleReleaseTag(BUILT_TAG);
    const both = manifestOf(webEntry(["main", "simplidigita-ai"]));
    // The App's one row, and a token for every open: what the bundle's build-only chain asks the store for.
    const buildCreds = {
      open: async () => Buffer.from("x", "utf8"),
      list: async ({ kind }: { kind: string }) => (kind === "github-app" ? [{ id: "cred_app", kind, label: "GitHub App (acme-org)", fingerprint: "fp", subject: { kind: "owner", id: ORG }, purpose: "repository-identity" }] : []),
    } as unknown as CredentialStore;

    /** A planned add-app of `request` on the tenant whose bundle stands at TEST_BUNDLE's tag with
     *  `standing` as its apps.yaml, and whose build plane builds it again at BUILT_TAG with `built`. */
    async function plannedBuild(request: Record<string, unknown>, template: Record<string, string>, manifests: { standing: string; built: string }): Promise<{ step: (name: string) => Promise<void>; reader: FakeRepoReader; params: AddAppParams; bundleRefs: (from: number) => string[]; registrations: TenantRegistrations }> {
      seedWebsiteTenant();
      db.db.insert(servers).values({ id: "srv_m", name: "m1", host: "5.6.7.8", sshUser: "root", role: "master", status: "healthy" }).run();
      db.db.insert(clusters).values({ id: "cls_m", serverId: "srv_m", stage: "prod", domain: "m1.example", name: "m1", status: "active" }).run();
      const buildPlane = new FakeBuildPlane();
      buildPlane.seedReleaseRun(TEST_BUNDLE.appsImage, { runName: `${TEST_BUNDLE.appsImage}-release-1`, releaseTag: "0.1.000-stable-20260102000000", succeeded: true, imageTag: BUILT_TAG });
      // The bundle's repository as the build-only chain reads it back after write-tree.
      const unitReader = new FakeRepoReader({ resolvedSha: SHA, files: {} });
      unitReader.scriptFor(BUNDLE_URL, { resolvedSha: SHA, files: { "deploy/platform.yaml": TEMPLATE_MANIFEST.replace(/example-apps/g, TEST_BUNDLE.appsImage) } });
      const onboard = onboardPorts({ repo: unitReader, consumerRepo: new FakeRepoWriter(), github: new FakeGitHubConsumer(), buildPlane, buildClusterReader: new FakeBuildPlaneClusterReader(TEST_BUNDLE.appsImage) });
      const prt = websitePorts({ dns: new FakeDnsProvider(), onboard: () => ({ ports: onboard }), buildUnitRegistration: async () => null }, template);
      scriptBundle(prt, { "apps.yaml": manifests.standing });
      const reader = prt.repo as FakeRepoReader;
      reader.scriptFor(`${TEST_BUNDLE.appsRepo}@${BUILT_RELEASE}`, { resolvedSha: SHA, files: { "apps.yaml": manifests.built } });
      const result = await makeAddAppDef(prt).planStream!(request, planCtx());
      if (result.outcome !== "planned") throw new Error(`rejected: ${result.summary}`);
      // One run, one memory: the tag onboard-build-only reads off the release is what refresh-images renders at.
      const defined = makeAddAppDef(prt).steps(result.params);
      const step = async (name: string): Promise<void> => { await defined.find((s) => s.name === name)!.run({ ...ctx(result.params, name, []), creds: buildCreds }); };
      const bundleRefs = (from: number): string[] => reader.clones.slice(from).filter((c) => c.repoURL === TEST_BUNDLE.appsRepo).map((c) => c.ref);
      return { step, reader, params: result.params, bundleRefs, registrations: prt.registrations };
    }

    it("PLANTED DEFECT: passes for a site only the bundle lists, judged against the bundle's manifest at the release the build wrote", async () => {
      const run = await plannedBuild(OWN_SITE, WEBSITE_APPS, { standing: both, built: both });
      expect(run.params.siteFromBundle).toBe(true);
      await run.step("onboard-build-only");
      await run.step("record-apps-repo");
      expect((await run.registrations.readTenant("prod", GUID))?.entry.appsImageTag).toBe(BUILT_TAG);
      const from = run.reader.clones.length;
      await run.step("refresh-images");
      expect(run.bundleRefs(from)).toEqual([BUILT_RELEASE]);
    });

    it("PLANTED INNOCENT: judges a template app added to a standing bundle against the template, and reads no bundle", async () => {
      const run = await plannedBuild({ tenantId: "tnt_1", app: NEW_APP }, TEMPLATE_APPS(), { standing: manifestOf(), built: manifestOf() });
      expect(run.params.siteFromBundle).toBe(false);
      await run.step("onboard-build-only");
      await run.step("record-apps-repo");
      const from = run.reader.clones.length;
      await run.step("refresh-images");
      expect(run.bundleRefs(from)).toEqual([]);
    });

    it("PLANTED DEFECT: fails naming T4 where the manifest at the release the build wrote no longer lists the site, though the tag the plan stood at did", async () => {
      // record-apps-repo has not run, so the registration still names the tag the plan stood at: a read
      // at the registration's tag would find the site, and only the pass's own tag finds it gone.
      const run = await plannedBuild(OWN_SITE, WEBSITE_APPS, { standing: both, built: manifestOf(webEntry(["main", "shop"])) });
      await run.step("onboard-build-only");
      const from = run.reader.clones.length;
      await expect(run.step("refresh-images")).rejects.toThrow(/the fan-out no longer validates after the builds wrote their pins — T4 did not pass/);
      expect(run.bundleRefs(from)).toEqual([BUILT_RELEASE]);
    });

    it("PLANTED DEFECT: fails by name, and does not judge the site against the template, where the registration names no apps repository", async () => {
      seedWebsiteTenant();
      const template = { ...WEBSITE_APPS, "apps.yaml": manifestOf(webEntry(["main", "shop", "simplidigita-ai"])) };
      const prt = websitePorts({ registrations: new TenantRegistrations(seededPlatformRepo({ appsImage: "", appsImageTag: "" })) }, template);
      const app = { name: "simplidigita-ai", folder: "web", site: "simplidigita-ai", domain: "simplidigita.ai", seedReference: false, seedDemo: false, selections: {} };
      const step = refreshImagesStep(prt, { guid: GUID, domain: "s1.example", stage: "prod", subdomain: "acme", apps: [app], seedUsers: false, registryHost: REGISTRY_HOST, requiredImages: [], appsImage: UNIT, siteFromBundle: true }, { appsImageTag: BUILT_TAG });
      await expect(step.run(ctx(params(), "refresh-images", []))).rejects.toThrow(`the website's site is listed by the tenant's own bundle, but the registration of tenant ${GUID} at prod names no apps repository`);
    });

    it("PLANTED DEFECT: refuses by name a new stage's size beside a site from the bundle, whose registration this step does not read", async () => {
      seedWebsiteTenant();
      const prt = websitePorts({}, WEBSITE_APPS);
      const app = { name: "simplidigita-ai", folder: "web", site: "simplidigita-ai", domain: "simplidigita.ai", seedReference: false, seedDemo: false, selections: {} };
      const step = refreshImagesStep(prt, { guid: GUID, domain: "s1.example", stage: "prod", subdomain: "acme", apps: [app], seedUsers: false, registryHost: REGISTRY_HOST, requiredImages: [], appsImage: UNIT, siteFromBundle: true, size: "small" }, { appsImageTag: BUILT_TAG });
      await expect(step.run(ctx(params(), "refresh-images", []))).rejects.toThrow(`which only a standing tenant's registration names, and this run creates a stage of tenant ${GUID} at size small`);
    });
  });
});
