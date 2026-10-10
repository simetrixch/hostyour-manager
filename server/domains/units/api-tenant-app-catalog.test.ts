import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Hono } from "hono";
import { pino } from "pino";
import { createApp } from "../../http/app.ts";
import { parseConfig } from "../../kernel/config.ts";
import { REQUIRED_ENV } from "../../kernel/config.fixture.ts";
import { openDb, type DbHandle } from "../../db/client.ts";
import { servers, clusters, tenants } from "../../db/schema/inventory.ts";
import { SessionCodec, SESSION_COOKIE } from "../access/session.ts";
import { seedQuota } from "#unit/shared/unit-size.ts";
import { TenantRegistrationSchema } from "../../../shared/tenant.ts";
import type { TenantAppCatalogView } from "../../../shared/apps-manifest.ts";
import type { AppCatalog } from "./app-catalog.ts";
import { FakeGitHubApp } from "../../adapters/github-app/testing/fake.ts";
import { seedCredentialRow } from "../../security/store.fixture.ts";
import { CredentialStore } from "../../security/store.ts";
import { registerTenantAppCatalogRoute, type TenantAppCatalogApiDeps } from "./api-tenant-app-catalog.ts";
import { TenantRegistrations, tenantRegistrationWrite } from "./tenant-registrations.ts";
import { FakePlatformRepo, FakeRepoReader } from "../../adapters/git/testing/fake.ts";
import { bundleReleaseTag, tenantBundleManifest } from "./engine-line.ts";
import { newWebsiteName, websiteFolder } from "../../../web/src/tenantAppRows.ts";
import { testMembers, STANDING_MEMBER_NAMES, TEST_BUNDLE } from "./tenant-members.fixture.ts";
import type { AppEnv } from "../../http/app-env.ts";

// GET /api/tenants/:id/app-catalog — one tenant's catalog over HTTP: the apps the deploy repository's
// TEMPLATE names (what can be added to any tenant, #215), each marked deployed where the
// registration's apps[] carries it, and the read's degradations, each a sentence and never a bare
// empty list.

const config = parseConfig({ ...REQUIRED_ENV, PUBLIC_URL: "https://m1.example", OIDC_ISSUER: "https://i.example/", OIDC_CLIENT_ID: "c", OIDC_CLIENT_SECRET: "s", MANAGER_VERSION: "test", DATA_DIR: "/d", ADMIN_SOCKET_PATH: "/run/manager/admin.sock", LOG_LEVEL: "silent" } as NodeJS.ProcessEnv);
const logger = pino({ level: "silent" });
const GUID = "zsjs023ctne0";

const CATALOG: AppCatalog = {
  packageScopes: [],
  apps: [
    { name: "erp", title: "ERP", description: "Orders and stock.", selections: { seedDemo: { title: "Demo data", default: true } } },
    { name: "crm", title: "CRM", description: "", selections: {} },
  ],
};

let db: DbHandle;
beforeEach(() => {
  db = openDb(":memory:");
  db.db.insert(servers).values({ id: "srv_1", name: "s1", host: "10.1.1.11", sshUser: "root", role: "slave", status: "healthy" }).run();
  db.db.insert(clusters).values({ id: "cls_1", serverId: "srv_1", stage: "prod", domain: "s1.example", name: "s1", status: "active" }).run();
  db.db.insert(tenants).values({ id: "tnt_1", clusterId: "cls_1", guid: GUID, subdomain: "acme", stage: "prod", members: ["auth", "jobs", "report"], identityProvider: "auth" }).run();
});
afterEach(() => { db.sqlite.close(); });

/** The registrations of a tenant deploying "erp", with the bundle given (the empty pair for none). */
function registrationsWith(bundle: { appsRepo?: string; appsImage?: string; appsImageTag?: string } = TEST_BUNDLE): TenantRegistrations {
  const repo = new FakePlatformRepo();
  const registration = TenantRegistrationSchema.parse({
    cluster: "s1", subdomain: "acme", members: testMembers([{ name: "erp" }]), identityProvider: "auth", apps: [{ name: "erp" }], quota: seedQuota("small"), ...bundle,
  });
  const w = tenantRegistrationWrite("prod", GUID, registration);
  repo.seed(repo.booksBranch, w.path, w.content);
  return new TenantRegistrations(repo);
}

const authed = (cookie: string): RequestInit => ({ headers: { cookie: `${SESSION_COOKIE}=${cookie}`, "sec-fetch-site": "same-origin" } });

/** The route over `deps`, with a bundle reader that finds no bundle unless the deps bring one; `null` wires none. */
async function serve(deps: Omit<TenantAppCatalogApiDeps, "db" | "store" | "githubApp">, reader: TenantAppCatalogApiDeps["readTenantManifest"] | null = async () => null): Promise<{ app: Hono<AppEnv>; cookie: string }> {
  const session = new SessionCodec(db.db, config);
  const githubApp = new FakeGitHubApp();
  githubApp.org = "example-org";
  const store = new CredentialStore({ db: db.db, logger });
  const app = createApp({
    config, logger, getReadiness: () => ({ ok: true, checks: [] }), session,
    registerAuth: () => undefined,
    registerProtected: (a) => registerTenantAppCatalogRoute(a, { db: db.db, store, githubApp, ...(reader ? { readTenantManifest: reader } : {}), ...deps }),
  });
  const cookie = await session.mint({ sub: "op_test", groups: ["admins"], via: "oidc" });
  return { app, cookie };
}

const read = async (app: Hono<AppEnv>, cookie: string, id = "tnt_1"): Promise<{ status: number; body: TenantAppCatalogView }> => {
  const res = await app.request(`/api/tenants/${id}/app-catalog`, authed(cookie));
  return { status: res.status, body: (await res.json()) as TenantAppCatalogView };
};

describe("GET /api/tenants/:id/app-catalog", () => {
  it("PLANTED DEFECT: marks a live member deployed even when apps[] does not list it", async () => {
    const repo = new FakePlatformRepo();
    const registration = TenantRegistrationSchema.parse({ cluster: "s1", subdomain: "acme", members: testMembers(["crm", "erp"]), identityProvider: "auth", apps: [{ name: "erp" }], quota: seedQuota("small"), ...TEST_BUNDLE });
    const w = tenantRegistrationWrite("prod", GUID, registration);
    repo.seed(repo.booksBranch, w.path, w.content);
    const { app, cookie } = await serve({ registrations: new TenantRegistrations(repo), appCatalog: { list: async () => CATALOG } });
    expect((await read(app, cookie)).body.apps.map((a) => [a.name, a.deployed])).toEqual([["erp", true], ["crm", true]]);
  });

  it("answers the template's apps, each marked deployed where the registration's apps[] names it — with a bundle and without one alike", async () => {
    const template = { list: async () => CATALOG };
    const { app, cookie } = await serve({ registrations: registrationsWith(), appCatalog: template, readTenantManifest: async () => ({ apps: [{ name: "erp", title: "ERP", description: "", selections: {} }] }) });
    const { status, body } = await read(app, cookie);
    expect(status).toBe(200);
    // An answered catalog names the tenant's websites even where there are none, so an absent list
    // means only that the catalog did not answer.
    expect(body).toEqual({ apps: [{ ...CATALOG.apps[0], deployed: true }, { ...CATALOG.apps[1], deployed: false }], websites: [], members: [...STANDING_MEMBER_NAMES, "erp"] });
    // A tenant onboarded as its platform alone (#211) has no bundle yet: the same template, nothing deployed.
    const noBundle = await serve({ registrations: registrationsWith({ appsImage: "", appsImageTag: "" }), appCatalog: template });
    expect((await read(noBundle.app, noBundle.cookie)).body).toEqual({ apps: [{ ...CATALOG.apps[0], deployed: true }, { ...CATALOG.apps[1], deployed: false }], websites: [], members: [...STANDING_MEMBER_NAMES, "erp"] });
  });

  it("names the tenant's websites off its registration, each with its site, and every member name a new website stays clear of", async () => {
    const repo = new FakePlatformRepo();
    const apps = [{ name: "erp" }, { name: "example-ch", folder: "web", site: "main" }];
    const registration = TenantRegistrationSchema.parse({ cluster: "s1", subdomain: "acme", members: testMembers(apps), identityProvider: "auth", apps, quota: seedQuota("small"), ...TEST_BUNDLE });
    const w = tenantRegistrationWrite("prod", GUID, registration);
    repo.seed(repo.booksBranch, w.path, w.content);
    const { app, cookie } = await serve({ registrations: new TenantRegistrations(repo), appCatalog: { list: async () => CATALOG } });
    const { body } = await read(app, cookie);
    expect(body.websites).toEqual([{ name: "example-ch", site: "main" }]);
    expect(body.members).toEqual([...STANDING_MEMBER_NAMES, "erp", "example-ch"]);
  });

  it("marks the tenant's main website in the websites it names, and no other", async () => {
    const repo = new FakePlatformRepo();
    const apps = [{ name: "erp" }, { name: "example-ch", folder: "web", site: "main", main: true }, { name: "shop", folder: "web", site: "shop" }];
    const registration = TenantRegistrationSchema.parse({ cluster: "s1", subdomain: "acme", members: testMembers(apps), identityProvider: "auth", apps, quota: seedQuota("small"), ...TEST_BUNDLE });
    const w = tenantRegistrationWrite("prod", GUID, registration);
    repo.seed(repo.booksBranch, w.path, w.content);
    const { app, cookie } = await serve({ registrations: new TenantRegistrations(repo), appCatalog: { list: async () => CATALOG } });
    expect((await read(app, cookie)).body.websites).toEqual([{ name: "example-ch", site: "main", main: true }, { name: "shop", site: "shop" }]);
  });

  // THE FIRST TENANT ONBOARDING ASKS FOR THE PACKAGES READER, NONE AFTER (#233): the template's
  // scopes travel with the catalog, and the owner's recorded reader says whether the form asks.
  it("names the packages reader the bundle needs — asked while the owner records none, shown recorded once it does, absent where the template routes no scope", async () => {
    const routing = { list: async () => ({ ...CATALOG, packageScopes: ["example-org", "shared"] }) };
    const asked = await serve({ registrations: registrationsWith(), appCatalog: routing });
    expect((await read(asked.app, asked.cookie)).body.packagesReader).toEqual({ owner: "example-org", scopes: ["example-org", "shared"], recorded: null });
    seedCredentialRow(db.db, { id: "cred_pkg", kind: "pat", label: "packages reader (example-org)", subject: { kind: "owner", id: "example-org" }, purpose: "packages-reader", fingerprint: "sha256:pkg" });
    const recorded = (await read(asked.app, asked.cookie)).body.packagesReader;
    expect(recorded?.recorded?.fingerprint).toBe("sha256:pkg");
    expect(recorded?.recorded?.recordedAt).toMatch(/^\d{4}-/);
    const none = await serve({ registrations: registrationsWith(), appCatalog: { list: async () => CATALOG } });
    expect((await read(none.app, none.cookie)).body.packagesReader).toBeUndefined();
  });

  it("says why there is no catalog: not wired, no catalog reader, not onboarded — each a reason, never a bare empty list", async () => {
    const unwired = await serve({ appCatalog: { list: async () => CATALOG } });
    expect((await read(unwired.app, unwired.cookie)).body).toEqual({ apps: [], reason: expect.stringContaining("tenant onboarding is not configured") });
    const noReader = await serve({ registrations: registrationsWith() });
    expect((await read(noReader.app, noReader.cookie)).body).toEqual({ apps: [], reason: expect.stringContaining("reads no app catalog") });
    // A Manager that can read the template and not a tenant's bundle cannot tell the tenant's sites.
    const noBundleReader = await serve({ registrations: registrationsWith(), appCatalog: { list: async () => CATALOG } }, null);
    expect((await read(noBundleReader.app, noBundleReader.cookie)).body).toEqual({ apps: [], reason: expect.stringContaining("reads no app catalog") });
    const notOnboarded = await serve({ registrations: new TenantRegistrations(new FakePlatformRepo()), appCatalog: { list: async () => CATALOG } });
    expect((await read(notOnboarded.app, notOnboarded.cookie)).body).toEqual({ apps: [], reason: expect.stringContaining("is not onboarded") });
  });

  it("answers { apps: [], error } when the read fails, and 404 for a tenant the inventory does not know", async () => {
    const { app, cookie } = await serve({ registrations: registrationsWith(), appCatalog: { list: async () => { throw new Error("clone failed: authentication required"); } } });
    expect((await read(app, cookie)).body).toEqual({ apps: [], error: "clone failed: authentication required" });
    expect((await read(app, cookie, "tnt_none")).status).toBe(404);
  });
});

// A website folder the tenant's own bundle carries offers the sites that bundle lists at the release the
// tenant stands at: the bundle serves them, and may list sites the template never offered.
describe("GET /api/tenants/:id/app-catalog — the sites of the tenant's own bundle", () => {
  const RELEASE = bundleReleaseTag(TEST_BUNDLE.appsImageTag);
  const WEBSITE_CATALOG: AppCatalog = {
    packageScopes: [],
    apps: [CATALOG.apps[0]!, { name: "web", title: "Website", description: "", selections: {}, sites: ["show", "workshop-web"] }],
  };
  const bundleManifest = (folder: string): string => `apps:\n  - name: erp\n    title: ERP\n${folder}`;
  const WEBSITE_FOLDER = (sites: string[]): string => `  - name: web\n    title: Website\n    sites: [${sites.join(", ")}]\n`;

  /** A tenant serving the sites show and veloluck, with the bundle given (the empty pair for none). */
  function websiteRegistrations(bundle: { appsRepo?: string; appsImage?: string; appsImageTag?: string } = TEST_BUNDLE): TenantRegistrations {
    const repo = new FakePlatformRepo();
    const apps = [{ name: "erp" }, { name: "show", folder: "web", site: "show" }, { name: "veloluck", folder: "web", site: "veloluck" }];
    const registration = TenantRegistrationSchema.parse({ cluster: "s1", subdomain: "acme", members: testMembers(apps), identityProvider: "auth", apps, quota: seedQuota("small"), ...bundle });
    const w = tenantRegistrationWrite("prod", GUID, registration);
    repo.seed(repo.booksBranch, w.path, w.content);
    return new TenantRegistrations(repo);
  }

  /** The reader the Manager wires, over a fake repository whose bundle stands at its release with `files` (none: unreadable). */
  function bundleReader(files?: Record<string, string>): { repo: FakeRepoReader; readTenantManifest: NonNullable<TenantAppCatalogApiDeps["readTenantManifest"]> } {
    const repo = new FakeRepoReader();
    if (files) repo.scriptFor(`${TEST_BUNDLE.appsRepo}@${RELEASE}`, { files });
    return { repo, readTenantManifest: (bundle, signal) => tenantBundleManifest({ repo }, bundle, signal) };
  }
  const sitesOf = (body: TenantAppCatalogView): string[] | undefined => body.apps.find((a) => a.name === "web")?.sites;

  it("offers a site the bundle lists at its release and the template does not list, and none of the template's own", async () => {
    const { repo, readTenantManifest } = bundleReader({ "apps.yaml": bundleManifest(WEBSITE_FOLDER(["show", "simplidigita-ai", "veloluck"])) });
    const { app, cookie } = await serve({ registrations: websiteRegistrations(), appCatalog: { list: async () => WEBSITE_CATALOG }, readTenantManifest });
    const { body } = await read(app, cookie);
    expect(sitesOf(body)).toEqual(["show", "simplidigita-ai", "veloluck"]);
    expect(repo.clones.map((c) => `${c.repoURL}@${c.ref}`)).toEqual([`${TEST_BUNDLE.appsRepo}@${RELEASE}`]);
  });

  it("PLANTED INNOCENT: the add form offers the bundle's site the tenant does not serve yet, and not the ones it serves", async () => {
    const { readTenantManifest } = bundleReader({ "apps.yaml": bundleManifest(WEBSITE_FOLDER(["show", "simplidigita-ai", "veloluck"])) });
    const { app, cookie } = await serve({ registrations: websiteRegistrations(), appCatalog: { list: async () => WEBSITE_CATALOG }, readTenantManifest });
    const { body } = await read(app, cookie);
    expect(websiteFolder(body.apps, body.websites)?.sites).toEqual(["simplidigita-ai"]);
    expect(newWebsiteName({ apps: body.apps, ...(body.members ? { members: body.members } : {}) }, "simplidigita-ai")).toBe("simplidigita-ai");
  });

  it("PLANTED INNOCENT: a tenant without a bundle is offered the template's sites, and its bundle is not read", async () => {
    const { repo, readTenantManifest } = bundleReader();
    const { app, cookie } = await serve({ registrations: websiteRegistrations({ appsImage: "", appsImageTag: "" }), appCatalog: { list: async () => WEBSITE_CATALOG }, readTenantManifest });
    expect(sitesOf((await read(app, cookie)).body)).toEqual(["show", "workshop-web"]);
    expect(repo.clones).toEqual([]);
  });

  it("keeps the template's sites for a website folder the bundle does not carry, which the add run takes from the template", async () => {
    const { readTenantManifest } = bundleReader({ "apps.yaml": bundleManifest("") });
    const { app, cookie } = await serve({ registrations: websiteRegistrations(), appCatalog: { list: async () => WEBSITE_CATALOG }, readTenantManifest });
    expect(sitesOf((await read(app, cookie)).body)).toEqual(["show", "workshop-web"]);
  });

  it("PLANTED DEFECT: answers { apps: [], error } for a bundle that cannot be read, never the template's sites", async () => {
    const { readTenantManifest } = bundleReader();
    const { app, cookie } = await serve({ registrations: websiteRegistrations(), appCatalog: { list: async () => WEBSITE_CATALOG }, readTenantManifest });
    expect((await read(app, cookie)).body).toEqual({ apps: [], error: `${TEST_BUNDLE.appsRepo} carries no apps.yaml at ${RELEASE}, so the apps the tenant runs cannot be read` });
  });
});
