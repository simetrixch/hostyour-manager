import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { tenants, tenantApps } from "../../db/schema/inventory.ts";
import { makeAddAppDef, AddAppParams, type AddAppPorts } from "./add-app.run.ts";
import { TenantRegistrations } from "./tenant-registrations.ts";
import { memberApplication, memberAppProject } from "./tenant-fanout.ts";
import { TENANT_MANIFEST_PATH } from "./gates/tenant-gates.ts";
import { FakeRepoReader, FakeRepoWriter, FAKE_BOOKS_BRANCH } from "../../adapters/git/testing/fake.ts";
import type { CredentialStore } from "../../security/store.ts";
import { tenantAppsRepoURL } from "./tenant-apps-tree.ts";
import { FakeHelmRenderer } from "../../adapters/helm/testing/fake.ts";
import { FakeMasterArgoReader, FakeClusterReader, FakeMasterProjectWriter } from "../../adapters/kube/testing/fake.ts";
import { FakeRegistryProbe } from "../../adapters/registry/testing/fake.ts";
import { type TenantValidationReport } from "../../../shared/tenant.ts";
import type { Cleanup } from "../../executor/types.ts";
import { APP_OVERLAYS, TEST_BUNDLE, TEST_RESOURCES, testMembers } from "./tenant-members.fixture.ts";
import { ORG } from "./tenant-apps-repo.fixture.ts";
import { buildUnitStepName } from "./tenant-builds.ts";
import { CLEAN_DOCS, GUID, MANIFEST_YAML, NEW_APP, NS_DOC, REGISTRY_HOST, SHA, TEMPLATE_APPS, ctx, db, doc, params, planCtx, ports, runAll, seedClusters, seededPlatformRepo, useMemoryDb } from "./add-app.fixture.ts";

useMemoryDb();

describe("add-app run definition", () => {
  it("keeps attest-target first under `mutating` and refuses the synchronous plan() path", () => {
    const def = makeAddAppDef(ports());
    expect(def.mutating).toBe(true);
    expect(def.steps({} as AddAppParams).map((s) => s.name)).toEqual([
      "attest-target", "ensure-images", "apply-appproject", "provision-argo-sync", "seed-password-field-key", "seed-service-key", "append-app", "watch-sync-set", "smoke", "record-inventory",
    ]);
    expect(() => def.plan({} as AddAppParams, { db: db.db })).toThrow(/planStream/);
  });

  it("walking skeleton: a new app is appended to a live tenant green against the fakes", async () => {
    seedClusters();
    const prt = ports();
    const logs: string[] = [];
    await runAll(params(), prt, logs);

    // append-app appended the new app to the registration, keeping the existing app AND the cluster
    // field (drop-trap: the read-modify-write rewrite must not erase it).
    const read = await prt.registrations.readTenant("prod", GUID);
    expect(read?.entry.apps.map((a: { name: string }) => a.name)).toEqual(["erp", "crm"]);
    expect(read?.entry.cluster).toBe("s1");

    // record-inventory added a tenant_apps row for the new app + bumped the tenant's lastRunId
    const appRows = db.db.select().from(tenantApps).where(eq(tenantApps.tenantId, "tnt_1")).all();
    expect(appRows.map((a) => a.name).sort()).toEqual(["crm", "erp"]);
    expect(db.db.select().from(tenants).where(eq(tenants.id, "tnt_1")).get()?.lastRunId).toBe("run_add");

    expect(logs.some((l) => l.includes("appended to tenant"))).toBe(true);
    expect(logs.some((l) => l.includes("Synced + Healthy"))).toBe(true);
  });

  it("the new app starts on the newest available versions, fixed as its own; dropping it takes them away and leaves the others", async () => {
    seedClusters();
    const OLD = "0.1.11-stable-20260920120000-def5678";
    const NEW = "0.1.12-stable-20260925120000-abc1234";
    const repo = seededPlatformRepo();
    repo.seed(repo.booksBranch, "charts/example-engine/pins-prod.yaml", `builds:
  - { name: example-engine, image: example-engine, tag: "${NEW}" }
`);
    const registrations = new TenantRegistrations(repo);
    await registrations.setApprovedTags("prod", GUID, { erp: { "example-engine": OLD } }, "run_before");
    const p = params();
    const cleanups: Cleanup[] = [];
    const c = ctx(p, "append-app", []);
    await makeAddAppDef(ports({ registrations })).steps(p).find((s) => s.name === "append-app")!.run({ ...c, registerCleanup: (cl) => cleanups.push(cl) });
    const both = { erp: { "example-engine": OLD }, crm: { "example-engine": NEW } };
    expect((await registrations.readTenant("prod", GUID))?.entry.approvedTags).toEqual(both);
    expect(db.db.select({ a: tenants.approvedTags }).from(tenants).where(eq(tenants.id, "tnt_1")).get()?.a).toEqual(both);
    await cleanups[0]!.run(c);
    expect((await registrations.readTenant("prod", GUID))?.entry.approvedTags).toEqual({ erp: { "example-engine": OLD } });
    expect(db.db.select({ a: tenants.approvedTags }).from(tenants).where(eq(tenants.id, "tnt_1")).get()?.a).toEqual({ erp: { "example-engine": OLD } });
  });

  it("threads both seed tiers into the appended apps[] entry", async () => {
    seedClusters();
    const prt = ports();
    await runAll(params({ seedReference: true, seedDemo: true }), prt, []);
    const read = await prt.registrations.readTenant("prod", GUID);
    // The pre-seeded "erp" keeps its default-false tiers; the appended "crm" carries both tiers true.
    expect(read?.entry.apps).toEqual([
      { name: "erp", seedReference: false, seedDemo: false, selections: {}, needs: [], path: "/app/erp" },
      { name: "crm", seedReference: true, seedDemo: true, selections: {}, needs: [], path: "/app/crm" },
    ]);
  });

  it("plans the new app with the needs its catalog entry declares, and appends it with its path into its apps[] entry", async () => {
    seedClusters();
    const prt = ports({}, TEMPLATE_APPS("    needs: [report]\n"));
    const result = await makeAddAppDef(prt).planStream!({ tenantId: "tnt_1", app: NEW_APP }, planCtx());
    expect(result.outcome).toBe("planned");
    const planned = (result as { params: AddAppParams }).params;
    expect(planned.needs).toEqual(["report"]);
    await runAll(params({ needs: planned.needs }), prt, []);
    const appended = (await prt.registrations.readTenant("prod", GUID))?.entry.apps.find((a) => a.name === NEW_APP);
    expect(appended).toMatchObject({ needs: ["report"], path: `/app/${NEW_APP}` });
    expect(appended).not.toHaveProperty("sitePath");
  });

  it("plans an app whose catalog entry declares no needs with an empty list", async () => {
    seedClusters();
    const result = await makeAddAppDef(ports()).planStream!({ tenantId: "tnt_1", app: NEW_APP }, planCtx());
    expect((result as { params: AddAppParams }).params.needs).toEqual([]);
  });

  it("appends a website with its admin path and the path it answers at", async () => {
    seedClusters();
    const prt = ports();
    const p = params({ app: "starter", website: { folder: "web", site: "starter", main: true }, member: testMembers([{ name: "starter", site: "starter" }])[3]! });
    await makeAddAppDef(prt).steps(p).find((s) => s.name === "append-app")!.run(ctx(p, "append-app", []));
    const website = (await prt.registrations.readTenant("prod", GUID))?.entry.apps.find((a) => a.name === "starter");
    expect(website).toMatchObject({ folder: "web", site: "starter", main: true, path: "/admin/starter", sitePath: "/" });
  });

  it("apply-appproject creates the NEW member's own AppProject and touches no sibling's (no delete cleanup registered)", async () => {
    seedClusters();
    const projects = new FakeMasterProjectWriter();
    const cleanups: string[] = [];
    const p = params();
    const step = makeAddAppDef(ports({ projects })).steps(p).find((s) => s.name === "apply-appproject")!;
    const c = ctx(p, "apply-appproject", []);
    await step.run({ ...c, registerCleanup: (cl) => cleanups.push(cl.name) });
    const projectName = memberAppProject(GUID, NEW_APP, "prod");
    expect(projects.get("argocd", projectName)?.metadata.name).toBe(projectName);
    // the existing "erp" member's project is untouched — a member is self-contained, so adding an app
    // adds exactly one namespace and one AppProject, never a sibling's.
    expect(projects.get("argocd", memberAppProject(GUID, "erp", "prod"))).toBeUndefined();
    expect(cleanups).toEqual([]); // never registers a project delete — the member's namespace/AppProject are cluster state that stays
  });

  // The ensure-images gate's run-level tests (placement, probe behavior) live in
  // tenant-ensure-images.run.test.ts, and the argo-sync grant's in tenant-argo-sync.run.test.ts —
  // both shared with create-tenant (the onboard-activate pattern).

  it("append-app is idempotent on a resume (a second run does not double-append or throw)", async () => {
    seedClusters();
    const prt = ports();
    const p = params();
    const step = makeAddAppDef(prt).steps(p).find((s) => s.name === "append-app")!;
    await step.run(ctx(p, "append-app", []));
    await step.run(ctx(p, "append-app", []));
    const read = await prt.registrations.readTenant("prod", GUID);
    expect(read?.entry.apps.map((a: { name: string }) => a.name)).toEqual(["erp", "crm"]);
  });

  it("watch-sync-set waits ONLY on the new app's Application(s)", async () => {
    const prt = ports();
    const p = params();
    const step = makeAddAppDef(prt).steps(p).find((s) => s.name === "watch-sync-set")!;
    // scripted statuses cover exactly the new app's Application, so the watch converges
    await expect(step.run(ctx(p, "watch-sync-set", []))).resolves.toBeUndefined();

    const stalled = makeAddAppDef(ports({ argo: new FakeMasterArgoReader({}) })).steps(p).find((s) => s.name === "watch-sync-set")!;
    await expect(stalled.run(ctx(p, "watch-sync-set", []))).rejects.toThrow(/fan-out did not converge — \d+ of \d+ Application\(s\) are not Synced\/Healthy/);
  });

  it("smoke checks the NEW member's own namespace (<guid>-<app>), never a sibling's", async () => {
    const memberNs = memberAppProject(GUID, NEW_APP, "prod"); // identity law: AppProject name == namespace
    const cluster = new FakeClusterReader({ smoke: { namespaceExists: false, workloads: [], externalSecretsReady: true } });
    const step = makeAddAppDef(ports({ cluster })).steps(params()).find((s) => s.name === "smoke")!;
    await expect(step.run(ctx(params(), "smoke", []))).rejects.toThrow(new RegExp(`namespace ${memberNs} does not exist`));
  });
});

describe("add-app streaming planner", () => {
  // The bundle this run builds is the tenant's own repository at its head; the new app's engine starts
  // at its stage pin. The two have to be of one line (engine-line.ts).
  const withEngineAt = (line: string): AddAppPorts => {
    const repo = seededPlatformRepo();
    repo.seed(repo.booksBranch, "charts/example-engine/pins-prod.yaml", `builds:\n  - { name: example-engine, image: example-engine, tag: "0.1.12-stable-20260925120000-abc1234" }\n`);
    const prt = ports({ registrations: new TenantRegistrations(repo) });
    (prt.repo as FakeRepoReader).scriptFor(TEST_BUNDLE.appsRepo, { resolvedSha: SHA, files: { "apps.yaml": `apps:\n  - name: erp\n    title: ERP\nengine:\n  build: example-engine\n  line: "${line}"\n` } });
    return prt;
  };

  it("plans an app whose engine starts on the line of the tenant's own bundle, read at its head", async () => {
    seedClusters();
    const prt = withEngineAt("0.1");
    const result = await makeAddAppDef(prt).planStream!({ tenantId: "tnt_1", app: NEW_APP }, planCtx());
    expect(result.outcome).toBe("planned");
    expect((prt.repo as FakeRepoReader).clones.map((c) => `${c.repoURL}@${c.ref}`)).toContain(`${TEST_BUNDLE.appsRepo}@HEAD`);
  });

  it("PLANTED DEFECT: append-app judges the new app's versions as it writes them, and appends no app off the bundle's line", async () => {
    seedClusters();
    const prt = withEngineAt("0.2");
    const p = params();
    await expect(makeAddAppDef(prt).steps(p).find((s) => s.name === "append-app")!.run(ctx(p, "append-app", [])))
      .rejects.toThrow(`app "${p.app}" cannot be added to tenant acme: the apps bundle is written for example-engine 0.2, and ${p.app} would run example-engine 0.1.12-stable-20260925120000-abc1234, of another line`);
    expect((await prt.registrations.readTenant("prod", GUID))?.entry.apps.map((a: { name: string }) => a.name)).toEqual(["erp"]);
    expect((prt.repo as FakeRepoReader).clones.at(-1)).toMatchObject({ repoURL: TEST_BUNDLE.appsRepo, ref: "0.1.0-stable-20260101000000" });
  });

  it("PLANTED DEFECT: refuses an app whose engine would start on another line than the tenant's bundle", async () => {
    seedClusters();
    await expect(makeAddAppDef(withEngineAt("0.2")).planStream!({ tenantId: "tnt_1", app: NEW_APP }, planCtx()))
      .rejects.toThrow(`app "${NEW_APP}" cannot be added to tenant acme: the apps bundle is written for example-engine 0.2, and ${NEW_APP} would run example-engine 0.1.12-stable-20260925120000-abc1234, of another line`);
  });

  it("loads the live tenant, validates the new app, and freezes a plan (targetKind tenant)", async () => {
    seedClusters();
    const def = makeAddAppDef(ports());
    const result = await def.planStream!({ tenantId: "tnt_1", app: NEW_APP }, planCtx());
    expect(result.outcome).toBe("planned");
    if (result.outcome !== "planned") return;
    expect(result.params.guid).toBe(GUID);
    expect(result.params.app).toBe(NEW_APP);
    expect(result.params.chartsRef).toBe(SHA);
    // The registration is the GitOps truth for the tenant's target slave.
    expect(result.params.cluster).toBe("s1");
    expect(result.params.registryHost).toBe(REGISTRY_HOST); // registryHostFromChain over what ports.resolveClusterValueFiles answered for the tenant's cluster
    expect(result.params.expectedApps).toEqual([memberApplication(GUID, NEW_APP, "prod")]);
    expect(result.plan.targetKind).toBe("tenant");
    expect(result.plan.targetId).toBe("tnt_1");
    expect(result.plan.locks).toContainEqual({ resource: "git-branch", key: `deploy@${FAKE_BOOKS_BRANCH}` }); // the books branch, not the trunk the charts stand on
    expect(result.plan.steps.map((s) => s.name)).toEqual(def.steps(result.params).map((s) => s.name));
  });

  it("refuses a duplicate app", async () => {
    seedClusters();
    const def = makeAddAppDef(ports());
    await expect(def.planStream!({ tenantId: "tnt_1", app: "erp" }, planCtx())).rejects.toThrow(/already exists/);
  });

  it("refuses a standing member from a stale add-app form before reading or building the catalog", async () => {
    seedClusters();
    await expect(makeAddAppDef(ports()).planStream!({ tenantId: "tnt_1", app: "auth" }, planCtx())).rejects.toThrow(/already exists/);
  });

  it("refuses an app named with a word the product reserves for its engine, before any validation runs", async () => {
    seedClusters();
    const helm = new FakeHelmRenderer({ fallback: { ok: true, docs: CLEAN_DOCS } });
    await expect(makeAddAppDef(ports({ helm })).planStream!({ tenantId: "tnt_1", app: "api" }, planCtx())).rejects.toThrow(/"api" is reserved by the product for its engine \(api, ws, health, tenant, admin, app\)/);
    expect(helm.requests).toEqual([]);
  });

  // A standing bundle carries every app of its tenant: adding one the bundle lacks extends it —
  // the tenant-apps-repo steps ahead of the image gate, the render at the standing tag until
  // refresh-images re-renders at the built one (#215).
  it("renders the new app with the tenant's OWN bundle at its standing tag, and the steps extend the bundle with the app before the image gate", async () => {
    seedClusters();
    const helm = new FakeHelmRenderer({ fallback: { ok: true, docs: CLEAN_DOCS } });
    const result = await makeAddAppDef(ports({ helm })).planStream!({ tenantId: "tnt_1", app: NEW_APP }, planCtx());
    expect(helm.requests.find((r) => r.namespace === `${GUID}-${NEW_APP}-prod`)?.valuesObject).toMatchObject({ tenant: { appsImage: TEST_BUNDLE.appsImage, appsImageTag: TEST_BUNDLE.appsImageTag } });
    expect(result.outcome).toBe("planned");
    if (result.outcome !== "planned") return;
    expect(result.params).toMatchObject({ appsImage: TEST_BUNDLE.appsImage, appsUnit: { org: ORG } });
    expect(result.plan.steps.map((s) => s.name).slice(0, 7)).toEqual(["attest-target", "create-repository", "write-tree", "onboard-build-only", "record-apps-repo", "refresh-images", "ensure-images"]);
    expect(result.plan.summary).toContain(`${ORG}/${TEST_BUNDLE.appsImage} gains "${NEW_APP}"`);
    // A registration naming another bundle is stale (its repository was renamed or removed): the
    // composer's name wins, the render mounts it at the placeholder, and the run creates it (#216).
    const stale = ports({ helm, registrations: new TenantRegistrations(seededPlatformRepo({ appsRepo: "https://github.com/acme-org/acme-apps.git", appsImage: "acme-apps", appsImageTag: TEST_BUNDLE.appsImageTag })) });
    const renamed = await makeAddAppDef(stale).planStream!({ tenantId: "tnt_1", app: NEW_APP }, planCtx());
    expect(renamed.outcome === "planned" && renamed.params.appsImage).toBe(TEST_BUNDLE.appsImage);
    expect(renamed.outcome === "planned" && renamed.plan.summary).toContain(`${ORG}/${TEST_BUNDLE.appsImage} is created from`);
  });

  // A tenant onboarded as its platform alone (#211) has no bundle: its first app is judged against
  // the TEMPLATE's catalog, the plan freezes the apps unit and the bundle at the placeholder tag, and
  // the run creates the bundle before the member is fanned out (#213).
  it("a tenant without a bundle: the plan freezes the apps unit and the steps create the bundle first, rendered at the placeholder", async () => {
    seedClusters();
    const helm = new FakeHelmRenderer({ fallback: { ok: true, docs: CLEAN_DOCS } });
    const prt = ports({ helm, registrations: new TenantRegistrations(seededPlatformRepo({ appsImage: "", appsImageTag: "" })) });
    const result = await makeAddAppDef(prt).planStream!({ tenantId: "tnt_1", app: "web" }, planCtx());
    expect(result.outcome).toBe("planned");
    if (result.outcome !== "planned") return;
    expect(result.params).toMatchObject({ app: "web", appsImage: "example-apps-acme", appsUnit: { org: ORG }, subdomain: "acme" });
    expect(helm.requests.find((r) => r.namespace === `${GUID}-web-prod`)?.valuesObject).toMatchObject({ tenant: { appsImage: "example-apps-acme" } });
    const names = result.plan.steps.map((s) => s.name);
    expect(names.slice(0, 7)).toEqual(["attest-target", "create-repository", "write-tree", "onboard-build-only", "record-apps-repo", "refresh-images", "ensure-images"]);
    expect(names.indexOf("apply-appproject")).toBeGreaterThan(names.indexOf("ensure-images"));
    expect(result.plan.summary).toContain(`${ORG}/example-apps-acme is created from`);
    // Without the App nothing can create the repository, and the plan says so.
    const { githubApp: _none, ...noApp } = prt;
    await expect(makeAddAppDef(noApp).planStream!({ tenantId: "tnt_1", app: "web" }, planCtx())).rejects.toThrow(/no GitHub App identity/);
  });

  // An app added after the platform pulls images no earlier run had to build (#214): the plan
  // resolves a build unit per missing image's repository exactly as create-tenant does, with its
  // owner's identity (#220), and places the build ahead of the image gate.
  it("a missing image the tenant spec's buildRepos names becomes a build unit ahead of ensure-images, nothing asked at approve", async () => {
    seedClusters();
    const PLATFORM_REPO = "https://github.com/acme/example-platform.git";
    const repo = new FakeRepoReader({ resolvedSha: SHA, files: { [TENANT_MANIFEST_PATH]: MANIFEST_YAML.replace("  members:", `  buildRepos:
    - repo: ${PLATFORM_REPO}
      builds: [example-engine]
  members:`), ...APP_OVERLAYS } });
    const helm = new FakeHelmRenderer({ fallback: { ok: true, docs: [NS_DOC, doc("Deployment", { raw: { kind: "Deployment", spec: { template: { spec: { containers: [{ name: "engine", image: `${REGISTRY_HOST}/example-engine:0.4.0`, resources: TEST_RESOURCES }] } } } } })] } });
    const def = makeAddAppDef(ports({ repo, helm, registryProbe: new FakeRegistryProbe({ missing: ["example-engine:0.4.0"] }) }));
    const result = await def.planStream!({ tenantId: "tnt_1", app: NEW_APP }, planCtx());
    expect(result.outcome).toBe("planned");
    if (result.outcome !== "planned") return;
    expect(result.params.buildUnits).toEqual([{ unit: "example-platform", repoURL: PLATFORM_REPO, images: ["example-engine"], registered: false }]);
    expect(result.plan.requiredSecrets).toEqual([]);
    expect(result.plan.optionalSecrets).toBeUndefined();
    const names = result.plan.steps.map((s) => s.name);
    expect(names.indexOf(buildUnitStepName("example-platform"))).toBe(1); // right after attest-target
    expect(names.indexOf(buildUnitStepName("example-platform"))).toBeLessThan(names.indexOf("ensure-images"));
    expect(def.assertApprovable).toBeUndefined();
    // A missing image no buildRepos entry names is refused by name, never probed for again at run time.
    const nobody = makeAddAppDef(ports({ helm, registryProbe: new FakeRegistryProbe({ missing: ["example-engine:0.4.0"] }) }));
    const refused = await nobody.planStream!({ tenantId: "tnt_1", app: NEW_APP }, planCtx());
    expect(refused.outcome).toBe("rejected");
    if (refused.outcome === "rejected") expect(refused.summary).toMatch(/buildRepos names no repository.*example-engine:0\.4\.0/);
  });

  it("freezes both requested seed tiers into params (default false when the request omits them)", async () => {
    seedClusters();
    const def = makeAddAppDef(ports());
    const seeded = await def.planStream!({ tenantId: "tnt_1", app: NEW_APP, seedReference: true, seedDemo: true }, planCtx());
    expect(seeded.outcome === "planned" && seeded.params.seedReference).toBe(true);
    expect(seeded.outcome === "planned" && seeded.params.seedDemo).toBe(true);
    const plain = await def.planStream!({ tenantId: "tnt_1", app: NEW_APP }, planCtx());
    expect(plain.outcome === "planned" && plain.params.seedReference).toBe(false);
    expect(plain.outcome === "planned" && plain.params.seedDemo).toBe(false);
  });

  it("freezes every further selection into params, and T4 refuses one the TENANT's entry does not declare", async () => {
    seedClusters();
    const def = makeAddAppDef(ports());
    // The template's apps.yaml declares the two seed selections for the new app and nothing else —
    // so a further selection is exactly what T4 refuses here.
    const refused = await def.planStream!({ tenantId: "tnt_1", app: NEW_APP, selections: { seedPrices: true } }, planCtx());
    expect(refused.outcome).toBe("rejected");
    expect(refused.outcome === "rejected" && refused.summary).toMatch(/T4/);
    const planned = await def.planStream!({ tenantId: "tnt_1", app: NEW_APP, seedReference: true, selections: {} }, planCtx());
    expect(planned.outcome === "planned" && planned.params.selections).toEqual({});
    // The same selection passes once the template's entry declares it — the template's catalog is
    // the judge, for a standing tenant as for a new one.
    const priced = ports({}, TEMPLATE_APPS(`      seedPrices: { title: "Prices", default: false }\n`));
    const accepted = await makeAddAppDef(priced).planStream!({ tenantId: "tnt_1", app: NEW_APP, selections: { seedPrices: true } }, planCtx());
    expect(accepted.outcome === "planned" && accepted.params.selections).toEqual({ seedPrices: true });
  });

  it("refuses by name an app the template's catalog lacks, and a Manager without the App", async () => {
    seedClusters();
    await expect(makeAddAppDef(ports()).planStream!({ tenantId: "tnt_1", app: "shop" }, planCtx())).rejects.toThrow(/shop is not in the template's apps\.yaml/);
    const { githubApp: _none, ...withoutApp } = ports();
    await expect(makeAddAppDef(withoutApp).planStream!({ tenantId: "tnt_1", app: NEW_APP }, planCtx())).rejects.toThrow(/no GitHub App identity/);
  });

  it("freezes the full report as a rejection when the new app escapes the namespace fence (T3)", async () => {
    seedClusters();
    const helm = new FakeHelmRenderer({ fallback: { ok: true, docs: [doc("ClusterRole")] } });
    const def = makeAddAppDef(ports({ helm }));
    const result = await def.planStream!({ tenantId: "tnt_1", app: NEW_APP }, planCtx());
    expect(result.outcome).toBe("rejected");
    if (result.outcome !== "rejected") return;
    expect(result.summary).toMatch(/T3/);
    expect((result.planJson as TenantValidationReport).verdict).toBe("fail");
  });
});

describe("add-app — the catalog's layout and the paths it keeps for itself", () => {
  it("writes no file of a path the catalog lists under catalogOnly into the tenant's repository, such as its handbook", async () => {
    seedClusters();
    const template = TEMPLATE_APPS();
    const catalog = { ...template, "apps.yaml": `${template["apps.yaml"]}catalogOnly: [handbook]\n`, "handbook/README.md": "# Handbook\n", "package.json": "{}\n" };
    const prt = ports({}, catalog);
    const result = await makeAddAppDef(prt).planStream!({ tenantId: "tnt_1", app: NEW_APP }, planCtx());
    if (result.outcome !== "planned") throw new Error(`rejected: ${result.summary}`);
    const p = result.params;
    const writer = new FakeRepoWriter();
    prt.onboard = () => ({ ports: { consumerRepo: writer } }) as unknown as ReturnType<NonNullable<typeof prt.onboard>>;
    const creds = { list: async () => [{ id: "cred_app", subject: { kind: "owner" } }] } as unknown as CredentialStore;
    await makeAddAppDef(prt).steps(p).find((s) => s.name === "write-tree")!.run({ ...ctx(p, "write-tree", []), creds });
    const files = Object.keys(writer.filesFor(tenantAppsRepoURL(p.appsUnit!.org, p.appsUnit!.templateBuild, p.subdomain)));
    expect(files.filter((f) => f.startsWith("handbook/"))).toEqual([]);
    expect(files).toEqual(expect.arrayContaining([`apps/${NEW_APP}/package.json`, "package.json"]));
  });

  it("refuses at its plan a catalog in the old layout, whose app folder stands at the root, and names the folder it looked for", async () => {
    seedClusters();
    const oldLayout = Object.fromEntries(Object.entries(TEMPLATE_APPS()).map(([path, content]) => [path.replace(/^apps\//, ""), content]));
    expect(Object.keys(oldLayout)).toContain(`${NEW_APP}/package.json`);
    await expect(makeAddAppDef(ports({}, oldLayout)).planStream!({ tenantId: "tnt_1", app: NEW_APP }, planCtx())).rejects.toThrow(`carries no apps/${NEW_APP}/ although its apps.yaml names it`);
  });
});
