import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Hono } from "hono";
import { pino } from "pino";
import { createApp } from "../../http/app.ts";
import { parseConfig } from "../../kernel/config.ts";
import { openDb, type DbHandle } from "../../db/client.ts";
import { servers, clusters, tenants, tenantApps } from "../../db/schema/inventory.ts";
import { CredentialStore } from "../../security/store.ts";
import { RunEventBus } from "../../executor/bus.ts";
import { Executor } from "../../executor/executor.ts";
import { buildRunDefinitions } from "../../domains/runs/run-definitions.ts";
import { SessionCodec, SESSION_COOKIE } from "../access/session.ts";
import { registerTenantRoutes } from "./api.ts";
import { makeOffboardTenantDef } from "./tenant-offboard.run.ts";
import { makeSuspendTenantDef, makeResumeTenantDef, makeRemoveAppDef } from "./tenant-lifecycle.run.ts";
import { TenantRegistrations } from "./tenant-registrations.ts";
import type { ClusterStageResolver } from "./registrations.ts";
import { FakePlatformRepo } from "../../adapters/git/testing/fake.ts";
import { FakeMasterArgoReader, FakeClusterReader, FakeMasterProjectWriter, FakeClusterKubeResolver } from "../../adapters/kube/testing/fake.ts";
import { FakeActivator } from "../../adapters/activation/testing/fake.ts";
import { BOOTSTRAP_TOKEN_KEY } from "./tenant-admin-invite.ts";
import { TENANT_SECRET } from "./tenant-secrets.ts";
import { memberNamespace } from "./tenant-fanout.ts";
import type { TenantLifecyclePorts } from "./lifecycle.ts";
import type { TenantStatus } from "../../../shared/enums.ts";
import type { SshFactory } from "../../adapters/ssh/port.ts";
import type { AppEnv } from "../../http/app-env.ts";

// The SERVER-SIDE refusals on a tenant whose create-tenant run never finished.
// create-tenant records its tenants row BEFORE it deploys (record-provisional), so a "provisioning" row
// means the tenant may have no namespace, no example-auth ingress and no fan-out at all. Every run kind that
// assumes a LIVE tenant must therefore refuse it AT THE ROUTE — the Tenants UI hides those buttons too,
// but a hidden button is a convenience and this is the guard. The one run kind that must NOT be refused is
// the removal: tenant-offboard is the clean way OUT of that state, and blocking it would strand exactly
// the tenant this whole change exists to make reachable.
//
// Split into this sibling file for the same reason api-tenant-live.test.ts and api-tenant-orphans.test.ts
// were: api.test.ts already sits at the 400-line budget.

const GUID = "e2e8ymj86dk8"; // a live-shaped throwaway guid — minted by the plan, never typed
const DEPLOY_URL = "https://github.com/acme/acme-catalog.git";
const config = parseConfig({ PUBLIC_URL: "https://m1.example", OIDC_ISSUER: "https://i.example/", OIDC_CLIENT_ID: "c", OIDC_CLIENT_SECRET: "s", MANAGER_VERSION: "test", DATA_DIR: "/d", LOG_LEVEL: "silent" } as NodeJS.ProcessEnv);
const logger = pino({ level: "silent" });
const noSsh: SshFactory = () => Promise.reject(new Error("no ssh"));

let db: DbHandle;
beforeEach(() => { db = openDb(":memory:"); });
afterEach(() => { db.sqlite.close(); });

const authed = (cookie: string): RequestInit => ({ headers: { cookie: `${SESSION_COOKIE}=${cookie}`, "sec-fetch-site": "same-origin" } });

/** The slave the tenant lands on plus the tenant itself, at whichever lifecycle status the test needs.
 *  The bootstrap token is pre-seeded on the cluster reader so the invite route would SUCCEED if the
 *  provisional guard were absent — the refusal must come from the status, not from a missing secret. */
function seedTenant(status: TenantStatus): void {
  db.db.insert(servers).values({ id: "srv_1", name: "s1", host: "10.1.1.11", sshUser: "root", role: "slave", status: "healthy" }).run();
  db.db.insert(clusters).values({ id: "cls_1", serverId: "srv_1", stage: "prod", domain: "s1.example", status: "active" }).run();
  db.db.insert(tenants).values({ id: "tnt_1", clusterId: "cls_1", guid: GUID, subdomain: "acme.example", stage: "prod", members: ["auth", "jobs", "report"], identityProvider: "auth", provenance: "manager", status }).run();
  db.db.insert(tenantApps).values({ id: "tna_1", tenantId: "tnt_1", name: "erp", status }).run();
}

/** A cluster-marking resolver that answers every cluster short name at "prod" — the guard's routes
 *  never move a tenant across stages, so a single-stage stand-in is all TenantRegistrations needs. */
const CLUSTER_STAGE: ClusterStageResolver = async (cluster) => ({ name: cluster, stage: "prod" });

function lifecyclePorts(registrations: TenantRegistrations, resolver: FakeClusterKubeResolver): TenantLifecyclePorts {
  return { registrations, resolver, catalogRepoUrl: DEPLOY_URL, argoWatchTimeoutMs: 1000, resolveUnitApex: async () => "example.com" };
}

/** The tenant routes with the row-keyed lifecycle family wired, plus the resolver + apex resolver +
 *  activator the invite route needs — without ALL THREE the invite answers 501 before it ever reaches
 *  the status check, which would make this suite pass for the wrong reason. */
async function makeTenant(): Promise<{ app: Hono<AppEnv>; cookie: string; activator: FakeActivator }> {
  const store = new CredentialStore({ db: db.db, logger });
  const bus = new RunEventBus();
  const reg = new TenantRegistrations(new FakePlatformRepo(), CLUSTER_STAGE);
  const resolver = new FakeClusterKubeResolver({
    clusterReader: new FakeClusterReader({
      deployState: { domain: "s1.example", stage: "prod", writtenAt: "x", generation: 1 },
      secretValues: { [`${memberNamespace(GUID, "auth")}/${TENANT_SECRET}/${BOOTSTRAP_TOKEN_KEY}`]: "boot_tok_abc" },
    }),
    argoReader: new FakeMasterArgoReader(), projectWriter: new FakeMasterProjectWriter(), argoNamespace: "argocd",
  });
  const ports = lifecyclePorts(reg, resolver);
  const defs = [makeOffboardTenantDef(ports), makeSuspendTenantDef(ports), makeResumeTenantDef(ports), makeRemoveAppDef(ports)];
  const executor = new Executor({ db: db.db, creds: store, bus, logger, runDefinitions: buildRunDefinitions({ db: db.db }, defs), sshFactory: noSsh, actor: () => "op_system" });
  const session = new SessionCodec(db.db, config);
  const activator = new FakeActivator();
  const app = createApp({
    config, logger, getReadiness: () => ({ ok: true, checks: [] }), session,
    registerAuth: () => undefined,
    registerProtected: (a) => registerTenantRoutes(a, { executor, db: db.db, onboardingEnabled: true, registrations: reg, resolver, activator, resolveUnitApex: async () => "example.com" }),
  });
  const cookie = await session.mint({ sub: "op_test", groups: ["admins"], via: "oidc" });
  return { app, cookie, activator };
}

const post = async (app: Hono<AppEnv>, cookie: string, path: string, body = "{}"): Promise<Response> =>
  await app.request(path, { method: "POST", ...authed(cookie), body });

/** Assert a 400 carrying the provisional refusal — the message must NAME the state and the ways out, so
 *  the operator is never left guessing why an action they can see was rejected. */
async function expectProvisionalRefusal(res: Response): Promise<void> {
  expect(res.status).toBe(400);
  const body = (await res.json()) as { code: string; message: string };
  expect(body.code).toBe("VALIDATION");
  expect(body.message).toMatch(/still provisioning/);
  expect(body.message).toMatch(/Finish the create-tenant run, or offboard\/purge the tenant/);
}

describe("the live tenant actions REFUSE a tenant that is still provisioning", () => {
  it("add-app: refused at the route, before a Run is planned", async () => {
    seedTenant("provisioning");
    const { app, cookie } = await makeTenant();
    await expectProvisionalRefusal(await post(app, cookie, "/api/tenants/tnt_1/apps", JSON.stringify({ app: "web" })));
  });

  it("invite-admin: refused WITHOUT touching the activator, even though the bootstrap token is there", async () => {
    seedTenant("provisioning");
    const { app, cookie, activator } = await makeTenant();
    await expectProvisionalRefusal(await post(app, cookie, "/api/tenants/tnt_1/invite-admin", JSON.stringify({ email: "admin@acme.test" })));
    // The refusal is a GUARD, not a late failure: nothing was invoked over the tenant's (possibly
    // nonexistent) auth ingress, so no half-invited admin can be left behind.
    expect(activator.calls).toHaveLength(0);
  });

  it("remove-app: refused — the drop is a pointer edit on a pointer that may never have been written", async () => {
    seedTenant("provisioning");
    const { app, cookie } = await makeTenant();
    await expectProvisionalRefusal(await post(app, cookie, "/api/tenants/tnt_1/apps/erp/remove"));
  });

  it("suspend and resume: both refused — they flip a pointer field on a tenant that may have no pointer", async () => {
    seedTenant("provisioning");
    const { app, cookie } = await makeTenant();
    await expectProvisionalRefusal(await post(app, cookie, "/api/tenants/tnt_1/suspend"));
    await expectProvisionalRefusal(await post(app, cookie, "/api/tenants/tnt_1/resume"));
  });

  it("offboard is NOT refused — it is the clean way OUT of an unfinished tenant", async () => {
    seedTenant("provisioning");
    const { app, cookie } = await makeTenant();
    const res = await post(app, cookie, "/api/tenants/tnt_1/offboard");
    expect(res.status).toBe(201);
    expect(((await res.json()) as { runId: string }).runId).toMatch(/^run_/);
  });

  it("an ACTIVE tenant is untouched by the guard — the refusal is keyed on the status, not on tenants", async () => {
    seedTenant("active");
    const { app, cookie } = await makeTenant();
    const res = await post(app, cookie, "/api/tenants/tnt_1/suspend");
    expect(res.status).toBe(201);
  });

  it("an unknown tenant still 404s rather than being refused as provisional", async () => {
    seedTenant("provisioning");
    const { app, cookie } = await makeTenant();
    expect((await post(app, cookie, "/api/tenants/tnt_nope/suspend")).status).toBe(404);
  });
});
