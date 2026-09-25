// tenant-apps-repo (hostyour-manager#177): the plan's refusals, the tree written from a fake template
// into a fake writer, its idempotency, the build-only chain driven with a github-app credential that
// mints the App's token at every open (#184), and the registration carrying repo and image afterwards.
import { dropCredentialRows } from "../../security/store.fixture.ts";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { parse as parseYaml } from "yaml";
import { seedQuota } from "../../../shared/unit-size.ts";
import { TenantRegistrationSchema } from "../../../shared/tenant.ts";
import { ConsumerManifestSchema } from "../../../shared/consumer.ts";
import { parseAppsManifest } from "../../../shared/apps-manifest.ts";
import { openDb, type DbHandle } from "../../db/client.ts";
import { servers, clusters } from "../../db/schema/inventory.ts";
import { makeTenantAppsRepoDef, type TenantAppsRepoParams } from "./tenant-apps-repo.run.ts";
import { mergeAppsManifest } from "./tenant-apps-tree.ts";
import { CATALOG_URL, GUID, IMAGE_TAG, ORG, SHA, SUBDOMAIN, TEMPLATE_APPS_YAML, TEMPLATE_FILES, TEMPLATE_MANIFEST, TEMPLATE_URL, TENANT_URL, UNIT, catalogManifest, recordTestOwners } from "./tenant-apps-repo.fixture.ts";
import type { TenantOnboardPorts } from "./create-tenant.run.ts";
import { TenantRegistrations } from "./tenant-registrations.ts";
import { TENANT_MANIFEST_PATH } from "./gates/tenant-gates.ts";
import { ports as onboardPorts, FakeBuildPlaneClusterReader, type FakeSeeder } from "./onboard.fixture.ts";
import { testMembers } from "./tenant-members.fixture.ts";
import { FakeRepoReader, FakePlatformRepo, FakeRepoWriter } from "../../adapters/git/testing/fake.ts";
import { FakeGitHubApp } from "../../adapters/github-app/testing/fake.ts";
import { FakeGitHubConsumer } from "../../adapters/github-consumer/testing/fake.ts";
import { FakeHelmRenderer } from "../../adapters/helm/testing/fake.ts";
import { FakeMasterArgoReader, FakeClusterReader, FakeMasterProjectWriter, FakeClusterKubeResolver, FakeBuildRbacWriter } from "../../adapters/kube/testing/fake.ts";
import { FakeRegistryProbe } from "../../adapters/registry/testing/fake.ts";
import { FakeDnsProvider } from "../../adapters/dns/testing/fake.ts";
import { FakeBuildPlane } from "../../adapters/build-plane/testing/fake.ts";
import type { Step, StepCtx, PlanStreamCtx } from "../../executor/types.ts";
import type { CredentialStore } from "../../security/store.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { VaultSeeder } from "../../adapters/vault/seeder-port.ts";

let db: DbHandle;
beforeEach(() => {
  db = openDb(":memory:"); recordTestOwners(db.db);
  db.db.insert(servers).values({ id: "srv_m", name: "m1", host: "5.6.7.8", sshUser: "root", role: "master", status: "healthy" }).run();
  db.db.insert(clusters).values({ id: "cls_m", serverId: "srv_m", stage: "prod", domain: "m1.example", name: "m1", status: "active" }).run();
});
afterEach(() => { db.sqlite.close(); });

function fakeTenantSeeder(): VaultSeeder {
  const no = () => Promise.reject(new Error("a tenant-apps-repo run never seeds through the tenant seeder"));
  return { seed: no, patchApp: no, seedPostgres: no, seedMongodb: no, seedBuildRepoPat: no, refreshBuildRepoPat: no, deleteBuildRepoPat: async () => {}, deleteApp: async () => {}, deletePostgres: async () => {}, deleteMongodb: async () => {}, seedTenantCrypto: async () => ({ created: true }), deleteTenantCrypto: async () => {} };
}

interface Harness {
  ports: TenantOnboardPorts;
  githubApp: FakeGitHubApp;
  /** The catalog's reader: serves the catalog's manifest and the template (ports.repo). */
  catalogReader: FakeRepoReader;
  /** The consumer family's reader: serves the tenant's repository once a test scripts it. */
  unitReader: FakeRepoReader;
  consumerRepo: FakeRepoWriter;
  github: FakeGitHubConsumer;
  seeder: FakeSeeder;
  buildPlane: FakeBuildPlane;
  /** The build plane's cluster reader: what the release re-run deletes the unit's build Secrets through. */
  buildCluster: FakeBuildPlaneClusterReader;
}

function harness(over: { catalog?: string; ports?: Partial<TenantOnboardPorts>; noApp?: boolean } = {}): Harness {
  const githubApp = new FakeGitHubApp();
  githubApp.org = ORG;
  const unitReader = new FakeRepoReader({ resolvedSha: SHA, files: {} });
  const catalogReader = new FakeRepoReader({ resolvedSha: SHA, files: { [TENANT_MANIFEST_PATH]: over.catalog ?? catalogManifest() } });
  catalogReader.scriptFor(TEMPLATE_URL, { resolvedSha: SHA, files: TEMPLATE_FILES });
  const consumerRepo = new FakeRepoWriter();
  const github = new FakeGitHubConsumer();
  const buildPlane = new FakeBuildPlane();
  buildPlane.seedReleaseRun(UNIT, { runName: `${UNIT}-release-1`, releaseTag: "0.1.0-stable-20260101000000", succeeded: true, imageTag: IMAGE_TAG });
  const buildCluster = new FakeBuildPlaneClusterReader(UNIT);
  const onboard = onboardPorts({ repo: unitReader, consumerRepo, github, buildPlane, buildClusterReader: buildCluster });
  const ports: TenantOnboardPorts = {
    seeder: fakeTenantSeeder(),
    repo: catalogReader,
    helm: new FakeHelmRenderer({ fallback: { ok: true, docs: [] } }),
    registrations: new TenantRegistrations(new FakePlatformRepo()),
    resolver: new FakeClusterKubeResolver({
      clusterReader: new FakeClusterReader({ deployState: { domain: "m1.example", stage: "prod", writtenAt: "2026-01-01T00:00:00Z", generation: 3 } }),
      argoReader: new FakeMasterArgoReader({}), projectWriter: new FakeMasterProjectWriter(), argoNamespace: "argocd",
    }),
    catalogRepoUrl: CATALOG_URL,
    platformRepoURL: "https://github.com/simetrixch/hostyour-cloud.git",
    catalogCredentialId: "catalog-read-pat",
    argoWatchTimeoutMs: 1000,
    resolveUnitApex: async () => "example.com",
    resolveClusterValueFiles: async () => [],
    registryProbe: new FakeRegistryProbe(),
    dns: new FakeDnsProvider(),
    buildRbac: new FakeBuildRbacWriter(),
    attestedBuilds: async () => [],
    consumerHostLabels: async () => [],
    onboard: () => ({ ports: onboard }),
    buildUnitRegistration: async () => null,
    ...(over.noApp ? {} : { githubApp }),
    ...over.ports,
  };
  return { ports, githubApp, catalogReader, unitReader, consumerRepo, github, seeder: onboard.seeder as FakeSeeder, buildPlane, buildCluster };
}

/** A credential store shaped like the real one for the kind under test: a `github-app` credential
 *  opens to the token the App answers at THAT moment (security/store.ts mints it), every other kind
 *  to what was sealed. Records every seal and every open. */
/** A credential store standing on the App's ONE row (#226): `cred_app`, the owner's, which opens
 *  to a token minted by the App now — no row is sealed per unit any more. */
function fakeCreds(app: FakeGitHubApp): { store: CredentialStore; seals: { id: string; kind: string; label: string; fingerprint: string; plaintext: string }[]; opened: string[] } {
  const seals: { id: string; kind: string; label: string; fingerprint: string; plaintext: string }[] = [];
  const opened: string[] = [];
  const appRow = { id: "cred_app", kind: "github-app", label: `GitHub App (${app.org})`, fingerprint: app.identityFingerprint(), subject: { kind: "owner", id: app.org }, purpose: "repository-identity" };
  const store = {
    seal: async (i: { kind: string; label: string; plaintext: Buffer; fingerprint: string }) => {
      const id = `cred_${seals.length + 1}`;
      seals.push({ id, kind: i.kind, label: i.label, fingerprint: i.fingerprint, plaintext: i.plaintext.toString("utf8") });
      return { id, kind: i.kind, label: i.label, fingerprint: i.fingerprint };
    },
    open: async (id: string) => {
      opened.push(id);
      if (id === "cred_pkg_org") return Buffer.from("ghp_packages_org", "utf8"); // the owner's packages reader (recordTestOwners)
      if (id === appRow.id) return Buffer.from(await app.installationToken(), "utf8");
      const s = seals.find((x) => x.id === id);
      if (!s) throw new Error(`unknown credential ${id}`);
      return Buffer.from(s.kind === "github-app" ? await app.installationToken() : s.plaintext, "utf8");
    },
    // The scope preflight asks the store which rows are the App's, and skips itself for one of them.
    list: async ({ kind }: { kind: string }) => [appRow, ...seals.map(({ id, kind: k, label, fingerprint }) => ({ id, kind: k, label, fingerprint, subject: { kind: "unit", id: "?" }, purpose: "repository-identity" }))].filter((x) => x.kind === kind),
  };
  return { store: store as unknown as CredentialStore, seals, opened };
}

function ctx(p: Record<string, unknown>, logs: string[], creds: CredentialStore): StepCtx {
  return {
    runId: "run_apps", stepName: "s", db: db.db, creds, params: p,
    secrets: { get: () => undefined, wipe: () => undefined },
    signal: new AbortController().signal, logger: {} as unknown as Logger,
    ssh: () => Promise.reject(new Error("no ssh")), openPasswordSession: () => Promise.reject(new Error("no ssh")),
    closePasswordSession: () => undefined, attest: () => Promise.reject(new Error("no attest")),
    log: (_s, t) => logs.push(t), checkpoint: () => undefined, readCheckpoint: () => undefined, registerCleanup: () => undefined,
  };
}
function planCtx(logs: string[] = []): PlanStreamCtx {
  return { db: db.db, log: (l) => logs.push(l), signal: new AbortController().signal };
}
const REQUEST = { subdomain: SUBDOMAIN, guid: GUID, stage: "prod", apps: [{ name: "erp", selections: { seedReference: true } }] };

async function plan(h: Harness, request: Record<string, unknown> = REQUEST) {
  return makeTenantAppsRepoDef(h.ports).planStream!(request, planCtx());
}
async function planned(h: Harness, request: Record<string, unknown> = REQUEST): Promise<TenantAppsRepoParams> {
  const r = await plan(h, request);
  if (r.outcome !== "planned") throw new Error(r.summary);
  return r.params;
}
/** One execute() pass: the executor builds the step list ONCE and the steps share its memory. */
function pass(h: Harness, p: TenantAppsRepoParams): (name: string) => Step {
  const steps = makeTenantAppsRepoDef(h.ports).steps(p);
  return (name) => {
    const s = steps.find((x) => x.name === name);
    if (!s) throw new Error(`no step ${name}`);
    return s;
  };
}
function step(h: Harness, p: TenantAppsRepoParams, name: string) {
  return pass(h, p)(name);
}

describe("tenant-apps-repo planStream — the refusals, each a sentence", () => {
  it("refuses without the GitHub App, naming the three config keys", async () => {
    const r = await plan(harness({ noApp: true }));
    expect(r.outcome).toBe("rejected");
    if (r.outcome !== "rejected") return;
    for (const key of ["GITHUB_APP_ID", "GITHUB_APP_INSTALLATION_ID", "GITHUB_APP_PRIVATE_KEY"]) expect(r.summary).toContain(key);
  });
  it("refuses a catalog that names no apps bundle — there is no template", async () => {
    const r = await plan(harness({ catalog: catalogManifest({ appsOrg: ORG }) }));
    expect(r.outcome).toBe("rejected");
    if (r.outcome !== "rejected") return;
    expect(r.summary).toMatch(/declares no tenant\.appsBundle/);
  });
  it("refuses an app the template's apps.yaml does not offer, naming what it offers", async () => {
    const r = await plan(harness(), { ...REQUEST, apps: [{ name: "erp" }, { name: "crm" }] });
    expect(r.outcome).toBe("rejected");
    if (r.outcome !== "rejected") return;
    expect(r.summary).toMatch(/crm is not in the template's apps\.yaml \(it offers erp, web\)/);
  });
  // The bundle's build installs what the TEMPLATE's .npmrc routes to GitHub Packages (#221): a
  // template routing a scope needs the owner's packages reader at plan; one routing none needs nothing.
  it("refuses a template routing a scope to GitHub Packages where the owner records no packages reader, and plans one routing none without it", async () => {
    dropCredentialRows(db.db, { kind: "owner", id: ORG });
    expect((await plan(harness(), REQUEST)).outcome).toBe("planned"); // TEMPLATE_FILES carry no .npmrc
    const h = harness();
    h.catalogReader.scriptFor(TEMPLATE_URL, { resolvedSha: SHA, files: { ...TEMPLATE_FILES, ".npmrc": `@${ORG}:registry=https://npm.pkg.github.com\n` } });
    const r = await plan(h, REQUEST);
    expect(r.outcome).toBe("rejected");
    if (r.outcome !== "rejected") return;
    expect(r.summary).toMatch(new RegExp(`owner ${ORG} records no packages reader, and ${ORG}/${UNIT} installs private npm packages of @${ORG} from GitHub Packages .* Add app form`));
  });
  it("refuses a catalog whose appsOrg is not the owner the App is installed in", async () => {
    const h = harness();
    h.githubApp.org = "other-org";
    const r = await plan(h);
    expect(r.outcome).toBe("rejected");
    if (r.outcome !== "rejected") return;
    expect(r.summary).toMatch(/tenant\.appsOrg is "acme-org" and the GitHub App is installed in "other-org"/);
  });
  it("refuses a unit registered as deployable under the tenant's apps name", async () => {
    const h = harness({ ports: { buildUnitRegistration: async (unit) => (unit === UNIT ? { form: "deployable" } : null) } });
    const r = await plan(h);
    expect(r.outcome).toBe("rejected");
    if (r.outcome !== "rejected") return;
    expect(r.summary).toMatch(/registered as DEPLOYABLE/);
  });
});

describe("tenant-apps-repo planStream — the plan", () => {
  it("freezes the owner, the template and the master, and reads the template with the catalog's credential", async () => {
    const h = harness();
    const r = await plan(h);
    expect(r.outcome).toBe("planned");
    if (r.outcome !== "planned") return;
    expect(r.params).toMatchObject({ subdomain: SUBDOMAIN, guid: GUID, stage: "prod", apps: ["erp"], owner: SUBDOMAIN, org: ORG, templateRepoURL: TEMPLATE_URL, templateBuild: "example-apps", registered: false, clusterId: "cls_m", domain: "m1.example" });
    expect(r.plan.steps.map((s) => s.name)).toEqual(["attest-target", "create-repository", "write-tree", "onboard-build-only", "record-apps-repo"]);
    expect(r.plan.requiredSecrets).toEqual([]);
    expect(r.plan.targetId).toBe("cls_m");
    expect(r.plan.summary).toContain(`${ORG}/${UNIT}`);
    // The template was cloned through the catalog's reader with the catalog's read credential — it is no unit.
    expect(h.catalogReader.clones).toContainEqual({ repoURL: TEMPLATE_URL, ref: "HEAD", credentialId: "catalog-read-pat" });
    expect(h.unitReader.clones).toEqual([]);
  });
  it("marks a unit already registered build-only, so its release is re-run", async () => {
    const h = harness({ ports: { buildUnitRegistration: async () => ({ form: "build-only", repoCredentialId: "cred_any" }) } });
    const p = await planned(h);
    expect(p.registered).toBe(true);
  });
});

describe("write-tree — the tree from the template into the tenant's repository", () => {
  it("copies the root files and the chosen app folder, skips the kit and the unchosen apps, writes the manifest and the apps.yaml, in one commit", async () => {
    const h = harness();
    const p = await planned(h);
    const creds = fakeCreds(h.githubApp);
    const logs: string[] = [];
    await step(h, p, "write-tree").run(ctx(p, logs, creds.store));
    const files = h.consumerRepo.filesFor(TENANT_URL);
    expect(Object.keys(files).sort()).toEqual([".dockerignore", ".github/CODEOWNERS", "apps.yaml", "deploy/platform.yaml", "docker/Dockerfile", "erp/package.json", "erp/seeds/roles.json", "package.json"]);
    expect(files["package.json"]).toBe(TEMPLATE_FILES["package.json"]);
    // The manifest: a build-only unit named after the tenant, one build, the template's envs and containerfile.
    const manifest = ConsumerManifestSchema.parse(parseYaml(files["deploy/platform.yaml"]!));
    expect(manifest).toMatchObject({ name: UNIT, owner: SUBDOMAIN, envs: ["dev", "test", "prod"], builds: [{ name: UNIT, containerfile: "docker/Dockerfile" }], appsBundle: UNIT });
    expect(manifest.chart).toBeUndefined();
    // apps.yaml: only the chosen entry, as the template spells it, under the template's header.
    const apps = parseAppsManifest(files["apps.yaml"]!);
    expect(apps.apps.map((a) => a.name)).toEqual(["erp"]);
    expect(apps.apps[0]).toEqual(parseAppsManifest(TEMPLATE_APPS_YAML).apps[0]);
    expect(files["apps.yaml"]).toContain("# The app catalog of this bundle.");
    expect(h.consumerRepo.commits).toHaveLength(1);
    expect(h.consumerRepo.commits[0]).toMatchObject({ repoURL: TENANT_URL, branch: "main", message: `Create ${UNIT} from the catalog` });
    expect(h.consumerRepo.commits[0]!.remove).toBeUndefined();
    // The writer opened the repository under the App's one row: the owner's, a row that stores no
    // token and carries the App identity's fingerprint.
    expect(creds.seals).toEqual([]); // no row per unit (#226)
    expect(h.consumerRepo.opened).toEqual([{ repoURL: TENANT_URL, credentialId: "cred_app" }]);
    expect(logs.some((l) => l.includes(`8 file(s) committed to ${TENANT_URL}`))).toBe(true);
  });
  it("a second run adds the missing app folder and entry, deletes nothing, overwrites nothing, and commits nothing when nothing changed", async () => {
    const h = harness();
    const creds = fakeCreds(h.githubApp);
    await step(h, await planned(h), "write-tree").run(ctx({}, [], creds.store));
    // The tenant edited a root file in the meantime: it stays theirs.
    h.consumerRepo.seed(TENANT_URL, "package.json", '{ "name": "acme-apps", "edited": true }\n');
    const p2 = await planned(h, { ...REQUEST, apps: [{ name: "erp" }, { name: "web" }] });
    await step(h, p2, "write-tree").run(ctx(p2, [], creds.store));
    const files = h.consumerRepo.filesFor(TENANT_URL);
    expect(files["web/site.json"]).toBe("{}\n");
    expect(files["erp/package.json"]).toBe(TEMPLATE_FILES["erp/package.json"]);
    expect(files["package.json"]).toBe('{ "name": "acme-apps", "edited": true }\n');
    expect(parseAppsManifest(files["apps.yaml"]!).apps.map((a) => a.name)).toEqual(["erp", "web"]);
    expect(h.consumerRepo.commits).toHaveLength(2);
    expect(h.consumerRepo.commits[1]).toMatchObject({ message: `Add web to ${UNIT} from the catalog`, write: [{ path: "web/site.json", content: "{}\n" }, { path: "apps.yaml", content: files["apps.yaml"] }] });
    expect(h.consumerRepo.commits[1]!.remove).toBeUndefined();
    // Nothing changed: no commit at all.
    const logs: string[] = [];
    await step(h, p2, "write-tree").run(ctx(p2, logs, creds.store));
    expect(h.consumerRepo.commits).toHaveLength(2);
    expect(logs.some((l) => l.includes("nothing to commit"))).toBe(true);
  });
  it("refuses without the consumer repository writer, naming the wiring", async () => {
    const h = harness();
    const p = await planned(h);
    h.ports.onboard = () => undefined;
    await expect(step(h, p, "write-tree").run(ctx(p, [], fakeCreds(h.githubApp).store))).rejects.toThrow(/consumer onboarding is not wired/);
  });
});

describe("mergeAppsManifest — never removes", () => {
  it("keeps an entry the tenant added by hand beside the chosen ones", () => {
    const current = "apps:\n  - name: custom\n    title: Theirs\n";
    const { content, added } = mergeAppsManifest(TEMPLATE_APPS_YAML, current, ["erp"]);
    expect(added).toEqual(["erp"]);
    expect(parseAppsManifest(content).apps.map((a) => a.name)).toEqual(["custom", "erp"]);
    expect(mergeAppsManifest(TEMPLATE_APPS_YAML, content, ["erp"]).added).toEqual([]);
  });
});

describe("create-repository and onboard-build-only — a github-app credential as the unit's credential", () => {
  it("creates the private repository once, then finds it standing", async () => {
    const h = harness();
    const p = await planned(h);
    const logs: string[] = [];
    await step(h, p, "create-repository").run(ctx(p, logs, fakeCreds(h.githubApp).store));
    expect(h.githubApp.created).toEqual([{ org: ORG, name: UNIT, description: expect.stringContaining("example-apps"), private: true, signal: expect.anything() }]);
    await step(h, p, "create-repository").run(ctx(p, logs, fakeCreds(h.githubApp).store));
    expect(h.githubApp.created).toHaveLength(1);
    expect(logs.at(-1)).toContain("already stands");
  });
  it("seals the github-app credential ONCE and hands its id to the build registration, seed-repo-pat, the webhook and the dispatch — each opening a token minted then", async () => {
    const h = harness();
    const p = await planned(h);
    const creds = fakeCreds(h.githubApp);
    const logs: string[] = [];
    const run = pass(h, p);
    h.githubApp.token = "ghs_hour_one";
    await run("write-tree").run(ctx(p, logs, creds.store));
    // The tenant repository as the chain reads it back: the manifest write-tree just committed.
    h.unitReader.scriptFor(TENANT_URL, { resolvedSha: SHA, files: { "deploy/platform.yaml": h.consumerRepo.filesFor(TENANT_URL)["deploy/platform.yaml"]! } });
    // An hour later the App mints another token: everything the chain does now carries THAT one,
    // although the credential was sealed under the first — the row stored no token at all.
    h.githubApp.token = "ghs_hour_two";
    await run("onboard-build-only").run(ctx(p, logs, creds.store));
    const onboard = h.ports.onboard!()!.ports;
    const registration = await onboard.registrations.readBuildRegistration(UNIT);
    expect(registration?.entry).toMatchObject({ name: UNIT, repoURL: TENANT_URL, owner: SUBDOMAIN, builds: [UNIT] });
    expect(h.seeder.buildRepoPats).toEqual([{ consumerName: UNIT, pat: "ghs_hour_two", packages: "ghp_packages_org" }]);
    expect(h.seeder.refreshedRepoPats).toEqual([]);
    expect(h.buildCluster.secretWrites).toEqual([]);
    expect(h.github.created.map((c) => ({ repo: c.repo, token: c.token }))).toEqual([{ repo: UNIT, token: "ghs_hour_two" }]);
    expect(h.github.dispatches.map((d) => ({ repo: d.repo, token: d.token, inputs: d.inputs }))).toEqual([{ repo: UNIT, token: "ghs_hour_two", inputs: { version: "0.1.0", channel: "stable", stage: "prod" } }]);
    expect(h.buildPlane.releaseWatches).toEqual([{ unit: UNIT, version: "0.1.0", channel: "stable" }]);
    // ONE credential for the whole pass, of the kind that stores nothing; every open went to it, and
    // the PAT scope preflight read no scopes off it — the step itself stood aside for the App's row.
    expect(creds.seals).toEqual([]); // no row per unit (#226)
    expect(new Set(creds.opened)).toEqual(new Set(["cred_app", "cred_pkg_org"])); // the App's one row and the owner's packages reader
    expect(logs.some((l) => l.includes("installation permissions stand in for PAT scopes"))).toBe(true);
    expect(logs.some((l) => l.includes("PAT scopes OK"))).toBe(false);
    expect(logs.at(-1)).toContain(`${UNIT} built as ${UNIT}:${IMAGE_TAG} for prod`);
  });
  it("refuses a release run that states no image-tag result — the registration could name no tag", async () => {
    const h = harness();
    h.buildPlane.seedReleaseRun(UNIT, { runName: `${UNIT}-release-1`, releaseTag: "0.1.0-stable-20260101000000", succeeded: true });
    const p = await planned(h);
    const creds = fakeCreds(h.githubApp);
    const run = pass(h, p);
    await run("write-tree").run(ctx(p, [], creds.store));
    h.unitReader.scriptFor(TENANT_URL, { resolvedSha: SHA, files: { "deploy/platform.yaml": TEMPLATE_MANIFEST.replace(/example-apps/g, UNIT) } });
    await expect(run("onboard-build-only").run(ctx(p, [], creds.store))).rejects.toThrow(/states no image-tag result/);
  });
  it("re-runs the release of a unit already registered build-only: rewrites its build repo-pat with a token minted now, deletes its build Secrets, waits for their return, then dispatches with the same", async () => {
    const h = harness({ ports: { buildUnitRegistration: async (unit) => (unit === UNIT ? { form: "build-only", repoCredentialId: "cred_old" } : null) } });
    const p = await planned(h);
    h.unitReader.scriptFor(TENANT_URL, { resolvedSha: SHA, files: { "deploy/platform.yaml": TEMPLATE_MANIFEST.replace(/example-apps/g, UNIT) } });
    const creds = fakeCreds(h.githubApp);
    h.githubApp.token = "ghs_rerun";
    const logs: string[] = [];
    await step(h, p, "onboard-build-only").run(ctx(p, logs, creds.store));
    expect(await h.ports.onboard!()!.ports.registrations.readBuildRegistration(UNIT)).toBeNull();
    // Not the create-only seed: the entry stands from the onboarding and holds a dead token.
    expect(h.seeder.buildRepoPats).toEqual([]);
    expect(h.seeder.refreshedRepoPats).toEqual([{ consumerName: UNIT, pat: "ghs_rerun", packages: "ghp_packages_org" }]);
    // The three target Secrets of the unit's ExternalSecrets, deleted in ITS build namespace behind
    // the rewrite, and the dispatch only after they stood again — a clone that started between the
    // deletion and the materialization would read no credential.
    expect(h.buildCluster.secretWrites).toEqual(["build-git-https", "bump-git-https", "build-npmrc"].map((name) => ({ op: "delete", namespace: `${UNIT}-build`, name })));
    expect(logs.findIndex((l) => l.includes("repo PAT rewritten"))).toBeLessThan(logs.findIndex((l) => l.includes(`deleted in ${UNIT}-build`)));
    expect(logs.findIndex((l) => l.includes(`stand again in ${UNIT}-build`))).toBeLessThan(logs.findIndex((l) => l.includes("release workflow dispatched")));
    expect(h.buildPlane.releaseWatches).toEqual([{ unit: UNIT, version: "0.1.0", channel: "stable" }]);
    expect(h.github.dispatches[0]?.token).toBe("ghs_rerun");
  });
});

describe("record-apps-repo — the registration carries repo, image and tag", () => {
  const registration = () => TenantRegistrationSchema.parse({
    cluster: "s1", subdomain: SUBDOMAIN, apps: [{ name: "erp" }], members: testMembers(["erp"]), identityProvider: "auth",
    quota: seedQuota("small"), seedUsers: false, resetNonce: "1", suspended: false, quiesced: false,
  });
  /** One pass up to the build: the tag the release built is in the pass's memory after it. */
  async function built(h: Harness, p: TenantAppsRepoParams, logs: string[]): Promise<(name: string) => Step> {
    const creds = fakeCreds(h.githubApp);
    const run = pass(h, p);
    await run("write-tree").run(ctx(p, logs, creds.store));
    h.unitReader.scriptFor(TENANT_URL, { resolvedSha: SHA, files: { "deploy/platform.yaml": h.consumerRepo.filesFor(TENANT_URL)["deploy/platform.yaml"]! } });
    await run("onboard-build-only").run(ctx(p, logs, creds.store));
    return run;
  }
  it("writes appsRepo, appsImage and the tag the build read onto a standing registration, and leaves it alone the second time", async () => {
    const h = harness();
    const p = await planned(h);
    await h.ports.registrations.commitTenant({ stage: "prod", guid: GUID, registration: registration(), runId: "run_0" });
    const logs: string[] = [];
    const run = await built(h, p, logs);
    await run("record-apps-repo").run(ctx(p, logs, fakeCreds(h.githubApp).store));
    const after = await h.ports.registrations.readTenant("prod", GUID);
    expect(after?.entry).toMatchObject({ appsRepo: TENANT_URL, appsImage: UNIT, appsImageTag: IMAGE_TAG, apps: [{ name: "erp" }] });
    await run("record-apps-repo").run(ctx(p, logs, fakeCreds(h.githubApp).store));
    expect(logs.at(-1)).toContain("nothing to commit");
  });
  it("says so when the tenant has no registration yet, and writes nothing", async () => {
    const h = harness();
    const p = await planned(h);
    const logs: string[] = [];
    const run = await built(h, p, logs);
    await run("record-apps-repo").run(ctx(p, logs, fakeCreds(h.githubApp).store));
    expect(logs.at(-1)).toMatch(/no registration at prod yet/);
    expect(await h.ports.registrations.readTenant("prod", GUID)).toBeNull();
  });
  it("refuses in a pass that did not build — a resumed pass has no tag in memory", async () => {
    const h = harness();
    const p = await planned(h);
    await expect(step(h, p, "record-apps-repo").run(ctx(p, [], fakeCreds(h.githubApp).store))).rejects.toThrow(/not in this pass's memory/);
  });
});
