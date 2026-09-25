import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Hono } from "hono";
import { pino } from "pino";
import { createApp } from "../../http/app.ts";
import { parseConfig } from "../../kernel/config.ts";
import { REQUIRED_ENV } from "../../kernel/config.fixture.ts";
import { openDb, type DbHandle } from "../../db/client.ts";
import { servers, clusters, tenants } from "../../db/schema/inventory.ts";
import { SessionCodec, SESSION_COOKIE } from "../access/session.ts";
import { seedQuota } from "../../../shared/unit-size.ts";
import { TenantRegistrationSchema } from "../../../shared/tenant.ts";
import type { TenantAppCatalogView } from "../../../shared/apps-manifest.ts";
import type { AppCatalog } from "./app-catalog.ts";
import { FakeGitHubApp } from "../../adapters/github-app/testing/fake.ts";
import { seedCredentialRow } from "../../security/store.fixture.ts";
import { CredentialStore } from "../../security/store.ts";
import { registerTenantAppCatalogRoute, type TenantAppCatalogApiDeps } from "./api-tenant-app-catalog.ts";
import { TenantRegistrations, tenantRegistrationWrite } from "./tenant-registrations.ts";
import { FakePlatformRepo } from "../../adapters/git/testing/fake.ts";
import { testMembers, TEST_BUNDLE } from "./tenant-members.fixture.ts";
import type { AppEnv } from "../../http/app-env.ts";

// GET /api/tenants/:id/app-catalog — one tenant's catalog over HTTP: the apps the catalog's
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

async function serve(deps: Omit<TenantAppCatalogApiDeps, "db" | "store" | "githubApp">): Promise<{ app: Hono<AppEnv>; cookie: string }> {
  const session = new SessionCodec(db.db, config);
  const githubApp = new FakeGitHubApp();
  githubApp.org = "example-org";
  const store = new CredentialStore({ db: db.db, logger });
  const app = createApp({
    config, logger, getReadiness: () => ({ ok: true, checks: [] }), session,
    registerAuth: () => undefined,
    registerProtected: (a) => registerTenantAppCatalogRoute(a, { db: db.db, store, githubApp, ...deps }),
  });
  const cookie = await session.mint({ sub: "op_test", groups: ["admins"], via: "oidc" });
  return { app, cookie };
}

const read = async (app: Hono<AppEnv>, cookie: string, id = "tnt_1"): Promise<{ status: number; body: TenantAppCatalogView }> => {
  const res = await app.request(`/api/tenants/${id}/app-catalog`, authed(cookie));
  return { status: res.status, body: (await res.json()) as TenantAppCatalogView };
};

describe("GET /api/tenants/:id/app-catalog", () => {
  it("answers the template's apps, each marked deployed where the registration's apps[] names it — with a bundle and without one alike", async () => {
    const template = { list: async () => CATALOG };
    const { app, cookie } = await serve({ registrations: registrationsWith(), appCatalog: template });
    const { status, body } = await read(app, cookie);
    expect(status).toBe(200);
    expect(body).toEqual({ apps: [{ ...CATALOG.apps[0], deployed: true }, { ...CATALOG.apps[1], deployed: false }] });
    // A tenant onboarded as its platform alone (#211) has no bundle yet: the same template, nothing deployed.
    const noBundle = await serve({ registrations: registrationsWith({ appsImage: "", appsImageTag: "" }), appCatalog: template });
    expect((await read(noBundle.app, noBundle.cookie)).body).toEqual({ apps: [{ ...CATALOG.apps[0], deployed: true }, { ...CATALOG.apps[1], deployed: false }] });
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
    const notOnboarded = await serve({ registrations: new TenantRegistrations(new FakePlatformRepo()), appCatalog: { list: async () => CATALOG } });
    expect((await read(notOnboarded.app, notOnboarded.cookie)).body).toEqual({ apps: [], reason: expect.stringContaining("is not onboarded") });
  });

  it("answers { apps: [], error } when the read fails, and 404 for a tenant the inventory does not know", async () => {
    const { app, cookie } = await serve({ registrations: registrationsWith(), appCatalog: { list: async () => { throw new Error("clone failed: authentication required"); } } });
    expect((await read(app, cookie)).body).toEqual({ apps: [], error: "clone failed: authentication required" });
    expect((await read(app, cookie, "tnt_none")).status).toBe(404);
  });
});
