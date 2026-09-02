import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { seedQuota } from "../../../shared/unit-size.ts";
import { eq } from "drizzle-orm";
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
import { getRun, listRuns, readEvents } from "../../executor/read.ts";
import { SessionCodec, SESSION_COOKIE } from "../access/session.ts";
import { registerTenantRoutes } from "./api.ts";
import { makeTenantPurgeDef } from "./tenant-purge.run.ts";
import { memberNamespace } from "./tenant-fanout.ts";
import { TenantRegistrations } from "./tenant-registrations.ts";
import type { ClusterStageResolver } from "./registrations.ts";
import { FakePlatformRepo } from "../../adapters/git/testing/fake.ts";
import { FakeDnsProvider } from "../../adapters/dns/testing/fake.ts";
import { FakeMasterArgoReader, FakeClusterReader, FakeMasterProjectWriter, FakeClusterKubeResolver } from "../../adapters/kube/testing/fake.ts";
import type { TenantLifecyclePorts } from "./lifecycle.ts";
import type { TenantStatus } from "../../../shared/enums.ts";
import type { SshFactory } from "../../adapters/ssh/port.ts";
import type { TenantRegistration } from "../../../shared/tenant.ts";
import type { AppEnv } from "../../http/app-env.ts";
import { STANDING_MEMBER_NAMES as TEST_MEMBERS, testMembers } from "./tenant-members.fixture.ts";

/** The standing members the product under test declares — stated by the fixture, the way a real
 *  tenant's registration states its own. The registration carries the records, since it is what the
 *  charts read; the fan-out helpers reason over the names alone. */
const TEST_MEMBER_RECORDS = testMembers([{ name: "erp", seedReference: false, seedDemo: false }]);

// The SERVER-SIDE live-tenant refusal on tenant-purge, at BOTH of its ends — the mirror image of the
// refusals in api-tenant-provisional.test.ts. Those keep the LIVE-tenant run kinds off a tenant that is not
// there; this one keeps the DESTRUCTIVE run kind off a tenant that IS. tenant-purge deletes the Tenant CR,
// and the tenant operator answers that by deleting the tenant's Vault path, revoking its object-storage
// credential and dropping its Mongo databases — none of it recoverable — so the one row state that must
// never reach it is a tenant that is still deployed and serving.
//
// The UI hides the action on such a tenant, but the Tenants list is fetched once at mount and never
// refreshed: an operator on a stale tab still sees the card of a tenant that has meanwhile finished
// provisioning, retypes its guid and confirms. A hidden button is a convenience; the route is the guard.
//
// And the route ALONE is not the guard either, which is the second describe below. A refusal made while
// a plan is CREATED says nothing about the moment that plan is APPROVED: a purge planned — legitimately —
// against a "provisioning" row sits `planned` for as long as the operator leaves it there, and
// Executor.approve re-validates nothing (no plan guards, no re-read of the row, no plan-hash re-check).
// A create-tenant retry that settles that very row to "active" in the meantime therefore leaves an
// approvable purge aimed at a tenant that is now serving. The rule is stated once (tenant-live-guard.ts)
// and asked again in the run's own attest-target step, where it fails the run before ANY teardown.
//
// Split into its own sibling file for the reason api-tenant-live / -orphans / -provisional were: the
// files that own the other halves of these routes already sit at the 400-line budget.

const GUID = "e2e8ymj86dk8"; // a live-shaped throwaway guid — minted by a plan, never typed
const SUB = "acme.example";
const DEPLOY_URL = "https://github.com/acme/acme-catalog.git";
const config = parseConfig({ PUBLIC_URL: "https://m1.example", OIDC_ISSUER: "https://i.example/", OIDC_CLIENT_ID: "c", OIDC_CLIENT_SECRET: "s", MANAGER_VERSION: "test", DATA_DIR: "/d", ADMIN_SOCKET_PATH: "/run/manager/admin.sock", LOG_LEVEL: "silent" } as NodeJS.ProcessEnv);
const logger = pino({ level: "silent" });
const noSsh: SshFactory = () => Promise.reject(new Error("no ssh"));

let db: DbHandle;
beforeEach(() => { db = openDb(":memory:"); });
afterEach(() => { db.sqlite.close(); });

const authed = (cookie: string): RequestInit => ({ headers: { cookie: `${SESSION_COOKIE}=${cookie}`, "sec-fetch-site": "same-origin" } });

/** The slave a tenant lands on. Tenants never live on the master control host, and tenant-purge refuses
 *  that cluster outright, so the whole suite targets cls_1 = s1. */
function seedCluster(): void {
  db.db.insert(servers).values({ id: "srv_1", name: "s1", host: "10.1.1.11", sshUser: "root", role: "slave", status: "healthy" }).run();
  db.db.insert(clusters).values({ id: "cls_1", serverId: "srv_1", stage: "prod", domain: "s1.example", status: "active" }).run();
}

/** The tenant's inventory rows at whichever lifecycle status the test needs. */
function seedTenantRow(status: TenantStatus): void {
  db.db.insert(tenants).values({ id: "tnt_1", clusterId: "cls_1", guid: GUID, subdomain: SUB, stage: "prod", members: ["auth", "jobs", "report"], identityProvider: "auth", provenance: "manager", status }).run();
  db.db.insert(tenantApps).values({ id: "tna_erp", tenantId: "tnt_1", name: "erp", status }).run();
}

/** A cluster-marking resolver that answers every cluster short name at "prod" — the whole suite targets
 *  s1/prod, so a single-stage stand-in is all TenantRegistrations needs to satisfy commitTenant's stage
 *  boundary check. */
const CLUSTER_STAGE: ClusterStageResolver = async (cluster) => ({ name: cluster, stage: "prod" });

/** The tenant as it stands in GitOps — committed through the real registrations, so the guard reads exactly
 *  the bytes a create-tenant would have written. Its presence is the second half of the question the
 *  guard asks: a live row PLUS a standing tenant.yaml is a tenant the appsets are still fanning out. */
function registration(over: Partial<TenantRegistration> = {}): TenantRegistration {
  return {
    cluster: "s1", subdomain: SUB,
    members: TEST_MEMBER_RECORDS, identityProvider: "auth",
    apps: [{ name: "erp", seedReference: false, seedDemo: false }],
    seedUsers: false, quota: seedQuota("small"), resetNonce: "1", suspended: false, quiesced: false,
    ...over,
  };
}

function lifecyclePorts(registrations: TenantRegistrations, clusterReader: FakeClusterReader): TenantLifecyclePorts {
  return {
    registrations,
    resolver: new FakeClusterKubeResolver({
      clusterReader,
      // No scripted statuses ⇒ every fan-out member reads Missing, i.e. already pruned: a purge that is
      // allowed through runs to completion, so a run that does NOT is the belt refusing it.
      argoReader: new FakeMasterArgoReader(), projectWriter: new FakeMasterProjectWriter(), argoNamespace: "argocd",
    }),
    catalogRepoUrl: DEPLOY_URL,
    argoWatchTimeoutMs: 1000,
    resolveUnitApex: async () => "example.com",
    dns: new FakeDnsProvider(),
  };
}

/** The tenant routes with the purge family wired — the registrations rides with it exactly as it does in
 *  production (buildTenantOnboarding constructs both or neither), because the guard reads the pointer
 *  through the very registrations the runs commit through. The cluster reader rides out too: the two deletes
 *  that make a purge destructive (Tenant CR + namespace) record on it, so a test can prove a refused
 *  purge issued neither. */
async function makeTenant(): Promise<{ app: Hono<AppEnv>; executor: Executor; cookie: string; registrations: TenantRegistrations; cluster: FakeClusterReader }> {
  const store = new CredentialStore({ db: db.db, logger });
  const reg = new TenantRegistrations(new FakePlatformRepo(), CLUSTER_STAGE);
  const cluster = new FakeClusterReader({ deployState: { domain: "s1.example", stage: "prod", writtenAt: "x", generation: 1 } });
  const executor = new Executor({ db: db.db, creds: store, bus: new RunEventBus(), logger, runDefinitions: buildRunDefinitions({ db: db.db }, [makeTenantPurgeDef(lifecyclePorts(reg, cluster))]), sshFactory: noSsh, actor: () => "op_system" });
  const session = new SessionCodec(db.db, config);
  const app = createApp({
    config, logger, getReadiness: () => ({ ok: true, checks: [] }), session,
    registerAuth: () => undefined,
    registerProtected: (a) => registerTenantRoutes(a, { executor, db: db.db, onboardingEnabled: true, registrations: reg }),
  });
  const cookie = await session.mint({ sub: "op_test", groups: ["admins"], via: "oidc" });
  return { app, executor, cookie, registrations: reg, cluster };
}

const purge = async (app: Hono<AppEnv>, cookie: string): Promise<Response> =>
  await app.request("/api/tenants/purge", { method: "POST", ...authed(cookie), body: JSON.stringify({ guid: GUID, stage: "prod", clusterId: "cls_1" }) });

/** Assert the purge was refused BEFORE a Run existed: a 400 naming the state, what the purge would have
 *  destroyed and the way out — and no run of any kind was planned. */
async function expectLiveRefusal(res: Response): Promise<void> {
  expect(res.status).toBe(400);
  const body = (await res.json()) as { code: string; message: string };
  expect(body.code).toBe("VALIDATION");
  expect(body.message).toMatch(/drops its Mongo databases/);
  expect(body.message).toMatch(/tenant\.yaml still stands/);
  expect(body.message).toMatch(/offboard the tenant first/);
}

describe("POST /api/tenants/purge refuses a tenant that is still LIVE", () => {
  it("an ACTIVE row whose pointer still stands is refused, and NO run is planned", async () => {
    // The stale-tab path: the tenant finished provisioning in another tab while this list sat at mount,
    // so the operator confirms a purge for a tenant that is now serving. Approving that run would drop
    // the tenant's Mongo databases and its Vault path.
    seedCluster();
    seedTenantRow("active");
    const { app, cookie, registrations } = await makeTenant();
    await registrations.commitTenant({ stage: "prod", guid: GUID, registration: registration(), runId: "run_onb" });
    await expectLiveRefusal(await purge(app, cookie));
    // Refused BEFORE the executor was asked to plan: no run exists for an operator to approve later.
    expect(listRuns(db.db)).toHaveLength(0);
  });

  it("a SUSPENDED row is refused too — suspend keeps the Tenant CR, the databases and the Vault path", async () => {
    // A suspended tenant is one tenant-resume away from serving; nothing about it is leftover state.
    seedCluster();
    seedTenantRow("suspended");
    const { app, cookie, registrations } = await makeTenant();
    await registrations.commitTenant({ stage: "prod", guid: GUID, registration: registration({ suspended: true }), runId: "run_onb" });
    await expectLiveRefusal(await purge(app, cookie));
  });

  it("PROVISIONING is allowed — the unfinished create-tenant is exactly what a purge is the remedy for", async () => {
    seedCluster();
    seedTenantRow("provisioning");
    const { app, executor, cookie, registrations } = await makeTenant();
    await registrations.commitTenant({ stage: "prod", guid: GUID, registration: registration(), runId: "run_onb" }); // its pointer landed before the run died
    const res = await purge(app, cookie);
    expect(res.status).toBe(201);
    const { runId } = (await res.json()) as { runId: string };
    await executor.settle(runId);
    expect(getRun(db.db, runId)?.status).toBe("planned");
  });

  it("NO row at all is allowed — naming a tenant the inventory does not know is why this run kind exists", async () => {
    seedCluster();
    const { app, executor, cookie, registrations } = await makeTenant();
    await registrations.commitTenant({ stage: "prod", guid: GUID, registration: registration(), runId: "run_onb" }); // an orphan: live pointer, no row
    const { runId } = (await (await purge(app, cookie)).json()) as { runId: string };
    await executor.settle(runId);
    expect(getRun(db.db, runId)?.status).toBe("planned");
  });

  it("an OFFBOARDED row is allowed — offboard KEEPS the cluster state only a purge can reap", async () => {
    // tenant-offboard un-deploys a tenant and leaves its Tenant CR, namespace, Vault path and Mongo
    // databases standing (soft state, re-onboardable), so the leftovers behind a settled row are purge's
    // business. It is also the retry path for a purge whose own record step already ran.
    seedCluster();
    seedTenantRow("offboarded");
    const { app, executor, cookie } = await makeTenant();
    const { runId } = (await (await purge(app, cookie)).json()) as { runId: string };
    await executor.settle(runId);
    expect(getRun(db.db, runId)?.status).toBe("planned");
  });

  it("a PURGED row is STILL allowed — a re-purge is idempotent, and it is the migration path for rows purged before 'purged' existed", async () => {
    // The purge got its own terminal status so the product could stop OFFERING the
    // action on a tenant with nothing left (the Tenants page drops such a row, web tenantRows.ts). It did
    // NOT tighten the route, deliberately: every step of tenant-purge reaps only what is still there, so
    // running it again is harmless — and it is how a tenant purged BEFORE that status existed (its row
    // reading "offboarded", indistinguishable from a genuine offboard by design) gets recorded correctly.
    // A route that refused here would make that one-line migration impossible.
    seedCluster();
    seedTenantRow("purged");
    const { app, executor, cookie } = await makeTenant();
    const { runId } = (await (await purge(app, cookie)).json()) as { runId: string };
    await executor.settle(runId);
    expect(getRun(db.db, runId)?.status).toBe("planned");
  });

  it("a LIVE row whose pointer is GONE is allowed — the failed-offboard state has no other way out", async () => {
    // tenant-offboard's remove-tenant committed the pointer removal and a later step failed, so the row
    // still says active while the tenant is already un-deployed and only leftovers stand. Refusing here
    // would leave that tenant with NO removal run kind at all: offboard cannot settle it while its fan-out
    // refuses to prune, and the orphan scan cannot see it because the pointer is gone. ABSENT is the one
    // pointer state that counts as un-deployed — the same rule the teardown's own remove step follows.
    seedCluster();
    seedTenantRow("active");
    const { app, executor, cookie } = await makeTenant(); // nothing committed ⇒ no tenant.yaml
    const { runId } = (await (await purge(app, cookie)).json()) as { runId: string };
    await executor.settle(runId);
    expect(getRun(db.db, runId)?.status).toBe("planned");
  });

  it("an UNREADABLE pointer beside a live row is refused — a body nobody can parse is no proof of removal", async () => {
    // The scan reports "unreadable" when a tenant.yaml DOES stand but its body cannot be trusted. That is
    // not absence, so the tenant is still to be treated as deployed.
    seedCluster();
    seedTenantRow("active");
    const { app, cookie, registrations } = await makeTenant();
    registrations.scanTenant = () => Promise.resolve({ status: "unreadable", reason: `tenants/prod/${GUID}/tenant.yaml failed its schema: cluster Invalid input` });
    await expectLiveRefusal(await purge(app, cookie));
  });

  it("the guard reads no pointer at all when there is no live row — the orphan path stays a pure DB read", async () => {
    // The guard's git read is the price of refusing a live tenant, and only a live row can be refused, so
    // the everyday orphan purge must not pay it.
    seedCluster();
    const { app, executor, cookie, registrations } = await makeTenant();
    let scans = 0;
    const scan = registrations.scanTenant.bind(registrations);
    registrations.scanTenant = (stage, guid) => { scans += 1; return scan(stage, guid); };
    const { runId } = (await (await purge(app, cookie)).json()) as { runId: string };
    await executor.settle(runId);
    expect(getRun(db.db, runId)?.status).toBe("planned");
    expect(scans).toBe(1); // the PLAN's own resolution read, never a second one from the guard
  });
});

describe("the same refusal is BELTED in attest-target, so approving a stale plan cannot deprovision", () => {
  it("a purge planned against a PROVISIONING tenant is refused when that tenant has meanwhile gone live", async () => {
    // The whole gap in one run. The purge is planned while the create-tenant run is still unfinished —
    // allowed, and the remedy that state exists for. The operator then retries the create-tenant run in
    // another tab; record-inventory settles the row to "active" and the tenant serves. The purge is still
    // sitting there `planned`, its frozen summary still describing the tenant as it was, and approve
    // re-validates NOTHING — so the plan-time refusal is not the guard, attest-target is.
    seedCluster();
    seedTenantRow("provisioning");
    const { app, executor, cookie, registrations, cluster } = await makeTenant();
    await registrations.commitTenant({ stage: "prod", guid: GUID, registration: registration(), runId: "run_onb" });
    const { runId } = (await (await purge(app, cookie)).json()) as { runId: string };
    await executor.settle(runId);
    expect(getRun(db.db, runId)?.status).toBe("planned");

    db.db.update(tenants).set({ status: "active" }).where(eq(tenants.id, "tnt_1")).run(); // record-inventory settled it
    db.db.update(tenantApps).set({ status: "active" }).where(eq(tenantApps.id, "tna_erp")).run();

    await executor.approve(runId);
    await executor.settle(runId);

    // The run fails at step 0, before the first teardown step — the pointer git-rm that starts the reap.
    const run = getRun(db.db, runId);
    expect(run?.status).toBe("failed");
    expect(run?.steps.find((s) => s.name === "attest-target")?.status).toBe("failed");
    expect(run?.steps.find((s) => s.name === `purge-${GUID}-remove`)?.status).toBe("pending"); // never started
    // Nothing of the live tenant was touched: pointer standing, no Tenant CR delete (the deprovision
    // cascade that drops the Mongo databases and the Vault path), no namespace reap, row untouched.
    expect(await registrations.readTenant("prod", GUID)).not.toBeNull();
    expect(cluster.deletedNamespaces).toEqual([]);
    expect(db.db.select().from(tenants).where(eq(tenants.id, "tnt_1")).get()?.status).toBe("active");
    // ...and the operator reads the SAME sentence the route would have refused with — one rule, one voice.
    const log = readEvents(db.db, runId).map((e) => e.text).join("\n");
    expect(log).toMatch(/drops its Mongo databases/);
    expect(log).toMatch(/tenant\.yaml still stands/);
    expect(log).toMatch(/offboard the tenant first/);
  });

  it("lets the purge it was planned for through — the belt admits it and every reapable artifact goes", async () => {
    // The positive control: the belt must refuse only what the route refuses. A tenant still provisioning
    // when the run is approved is admitted and torn down exactly as planned. Through the real route and
    // the real executor.
    //
    // The run SUCCEEDS. The crypto entry has an owner (delete-tenant-crypto), so the purge completes
    // and the rows settle — where a verify-deprovision standing before the row flip with nothing
    // deprovisioning a tenant refuses by design and ends the run failed.
    seedCluster();
    seedTenantRow("provisioning");
    const { app, executor, cookie, registrations, cluster } = await makeTenant();
    const reg = registration();
    await registrations.commitTenant({ stage: "prod", guid: GUID, registration: reg, runId: "run_onb" });
    const { runId } = (await (await purge(app, cookie)).json()) as { runId: string };
    await executor.settle(runId);
    await executor.approve(runId);
    await executor.settle(runId);

    expect(getRun(db.db, runId)?.status).toBe("succeeded");
    expect(await registrations.readTenant("prod", GUID)).toBeNull();
    // The backstop reap deletes ONE namespace per member (the trio + the tenant's apps) — never a bare
    // <guid> namespace, which does not exist under the per-member model.
    const members = [...TEST_MEMBERS, ...reg.apps.map((a) => a.name)];
    expect(cluster.deletedNamespaces).toEqual(members.map((m) => memberNamespace(GUID, m)));
    // The rows moved, and only at the END: the record step is the last one, after every reap and after
    // the crypto delete, so "purged" states a deprovision that actually ran.
    expect(db.db.select().from(tenants).where(eq(tenants.id, "tnt_1")).get()?.status).toBe("purged");
    expect(db.db.select().from(tenantApps).where(eq(tenantApps.id, "tna_erp")).get()?.status).toBe("purged");
  });
});
