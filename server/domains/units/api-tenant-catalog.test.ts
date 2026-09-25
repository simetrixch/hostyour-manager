import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Hono } from "hono";
import { pino } from "pino";
import { createApp } from "../../http/app.ts";
import { parseConfig } from "../../kernel/config.ts";
import { REQUIRED_ENV } from "../../kernel/config.fixture.ts";
import { openDb, type DbHandle } from "../../db/client.ts";
import { CredentialStore } from "../../security/store.ts";
import { RunEventBus } from "../../executor/bus.ts";
import { Executor } from "../../executor/executor.ts";
import { buildRunDefinitions } from "../../domains/runs/run-definitions.ts";
import { SessionCodec, SESSION_COOKIE } from "../access/session.ts";
import { registerTenantRoutes } from "./api.ts";
import { makeAppCatalogProvider, type AppCatalogProvider } from "./app-catalog.ts";
import { FakeRepoReader } from "../../adapters/git/testing/fake.ts";
import type { SshFactory } from "../../adapters/ssh/port.ts";
import type { AppEnv } from "../../http/app-env.ts";

// GET /api/tenants/app-catalog — the create-tenant wizard's picker, end-to-end over HTTP: the
// wired provider clones a fake catalog whose manifest names an apps bundle, clones the apps
// repository and answers its apps.yaml as-is (titles, descriptions, selections). The provider's
// fail-soft, its cache and the overlay stand-in are unit-tested in app-catalog.test.ts. A sibling
// of api.test.ts because that file is at the file-size budget.

const config = parseConfig({ ...REQUIRED_ENV, PUBLIC_URL: "https://m1.example", OIDC_ISSUER: "https://i.example/", OIDC_CLIENT_ID: "c", OIDC_CLIENT_SECRET: "s", MANAGER_VERSION: "test", DATA_DIR: "/d", ADMIN_SOCKET_PATH: "/run/manager/admin.sock", LOG_LEVEL: "silent" } as NodeJS.ProcessEnv);
const logger = pino({ level: "silent" });
const noSsh: SshFactory = () => Promise.reject(new Error("no ssh"));
const DEPLOY_URL = "https://github.com/acme/acme-catalog.git";

/** The catalog's manifest, naming the apps template: the bundle's name and its repository. */
const TENANT_MANIFEST = `apiVersion: hostyour.cloud/v1
kind: ConsumerManifest
name: catalog
owner: platform
envs: [dev, test, prod]
builds:
  - { name: example-engine, containerfile: Dockerfile }
tenant:
  appsBundle: acme-apps
  appsRepo: https://github.com/acme/acme-apps.git
  members:
    - { name: auth, chart: charts/example-auth, identityProvider: true }
  perApp:
    engine: { chart: charts/example-engine }
    front: { chart: charts/example-ui }
`;
const APPS_YAML = `apps:
  - name: erp
    title: ERP
    description: Orders and stock.
    selections:
      seedDemo: { title: Demo data, default: true }
`;

let db: DbHandle;
beforeEach(() => { db = openDb(":memory:"); });
afterEach(() => { db.sqlite.close(); });

const authed = (cookie: string): RequestInit => ({ headers: { cookie: `${SESSION_COOKIE}=${cookie}`, "sec-fetch-site": "same-origin" } });

async function makeTenant(appCatalog?: AppCatalogProvider): Promise<{ app: Hono<AppEnv>; cookie: string }> {
  const store = new CredentialStore({ db: db.db, logger });
  const executor = new Executor({ db: db.db, creds: store, bus: new RunEventBus(), logger, runDefinitions: buildRunDefinitions({ db: db.db }), sshFactory: noSsh, actor: () => "op_system" });
  const session = new SessionCodec(db.db, config);
  const app = createApp({
    config, logger, getReadiness: () => ({ ok: true, checks: [] }), session,
    registerAuth: () => undefined,
    registerProtected: (a) => registerTenantRoutes(a, { executor, db: db.db, onboardingEnabled: true, ...(appCatalog ? { appCatalog } : {}) }),
  });
  const cookie = await session.mint({ sub: "op_test", groups: ["admins"], via: "oidc" });
  return { app, cookie };
}

describe("GET /api/tenants/app-catalog", () => {
  it("serves the template repository's apps.yaml as-is (route→provider→clone→parse)", async () => {
    const repo = new FakeRepoReader({ files: { "deploy/platform.yaml": TENANT_MANIFEST, "apps.yaml": APPS_YAML } });
    const { app, cookie } = await makeTenant(makeAppCatalogProvider({ repo, repoURL: DEPLOY_URL, ref: "master", credentialId: "catalog-read-pat", warn: () => {} }));
    expect(await (await app.request("/api/tenants/app-catalog", authed(cookie))).json()).toEqual({
      apps: [{ name: "erp", title: "ERP", description: "Orders and stock.", selections: { seedDemo: { title: "Demo data", default: true } } }],
      packageScopes: [], // the template routes no scope to GitHub Packages (#233)
    });
    // The catalog at the books ref, then the template at its default branch head.
    expect(repo.clones.map((c) => [c.repoURL, c.ref])).toEqual([[DEPLOY_URL, "master"], ["https://github.com/acme/acme-apps.git", "HEAD"]]);
  });

  it("answers { apps: [] } with no provider wired — the wizard degrades, never blank-screens", async () => {
    const { app, cookie } = await makeTenant();
    expect(await (await app.request("/api/tenants/app-catalog", authed(cookie))).json()).toEqual({ apps: [] });
  });
});
