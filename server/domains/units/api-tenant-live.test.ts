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
import { memberApplication, tenantApplicationSet } from "./tenant-fanout.ts";
import { FakeMasterArgoReader, FakeClusterReader, FakeMasterProjectWriter, FakeClusterKubeResolver } from "../../adapters/kube/testing/fake.ts";
import type { SmokeResult, ArgoAppStatus } from "../../adapters/kube/port.ts";
import type { SshFactory } from "../../adapters/ssh/port.ts";
import type { TenantStatus, DriftVerdict } from "../../../shared/enums.ts";
import type { AppEnv } from "../../http/app-env.ts";

/** The standing members the product under test declares — stated by the fixture, the way a real
 *  tenant's registration states its own. */
const TEST_MEMBERS = ["auth", "jobs", "report"];

// The per-tenant live reconciliation read (GET /api/tenants/:id/live) — the tenant analogue of the
// consumer live route (api.test.ts). A tenant fans out to MANY Applications, so the FACTS are
// aggregated: ONE smoke of the <guid> namespace + the fan-out's Applications read in one set list and
// rolled up (Synced only if all Synced, health worst-of), with drift = the pinned chartsRef vs the
// single-source BASE Application's deployed revision. Split into this sibling file: api.test.ts already
// sits at the 400-line budget, so the new suite lands here beside it.

const SHA = "a".repeat(40);
const DEPLOYED = "b".repeat(40);
const TGUID = "zsjs023ctne0"; // a live-shaped throwaway guid (matches the tenants/** path guard)
// The ONE repo every tenant's charts live in — the platform constant the route resolves the fan-out's
// pin against. Byte-identical to what the appsets render their source repoURL from (hostyour-cloud
// apps/slave/values-common.yaml `repo.deployUrl`), which is what makes the per-repo lookup match.
const DEPLOY_REPO = "https://github.com/acme/acme-catalog.git";
const config = parseConfig({ PUBLIC_URL: "https://m1.example", OIDC_ISSUER: "https://i.example/", OIDC_CLIENT_ID: "c", OIDC_CLIENT_SECRET: "s", MANAGER_VERSION: "test", DATA_DIR: "/d", LOG_LEVEL: "silent" } as NodeJS.ProcessEnv);
const logger = pino({ level: "silent" });
const noSsh: SshFactory = () => Promise.reject(new Error("no ssh"));

let db: DbHandle;
beforeEach(() => { db = openDb(":memory:"); });
afterEach(() => { db.sqlite.close(); });

const authed = (cookie: string): RequestInit => ({ headers: { cookie: `${SESSION_COOKIE}=${cookie}`, "sec-fetch-site": "same-origin" } });

// The master self-cluster cls_1 — the tenant + the master-FQDN lookup (servers.role="master")
// both resolve off it, so argocdUrl derives from s1.example.
function seedCluster(): void {
  db.db.insert(servers).values({ id: "srv_1", name: "m1", host: "1.2.3.4", sshUser: "root", role: "master", status: "healthy" }).run();
  db.db.insert(clusters).values({ id: "cls_1", serverId: "srv_1", stage: "prod", domain: "s1.example", status: "active" }).run();
}

// A live tenant (guid TGUID, one app "erp") pinned at SHA on cls_1. `over` lets a test seed the
// SUSPENDED tenant, whose row carries both the status and the flag the suspend run writes together
// (tenant-lifecycle.run.ts record-suspended) — a tenant suspend prunes NOTHING (it flips a field the
// charts render as replicas 0), so every member Application — the auth anchor included — goes on
// being compared exactly like an active tenant's.
function seedTenant(over: { status?: TenantStatus; suspended?: boolean } = {}): void {
  seedCluster();
  db.db.insert(tenants).values({ id: "tnt_1", clusterId: "cls_1", guid: TGUID, subdomain: "acme.example", stage: "prod", members: ["auth", "jobs", "report"], identityProvider: "auth", provenance: "manager", status: "active", ...over }).run();
  db.db.insert(tenantApps).values({ id: "tna_1", tenantId: "tnt_1", name: "erp" }).run();
}

// The tenant's EXPECTED fan-out Application names — the trio (auth/jobs/report) ALWAYS plus one per
// app, the source of truth the route also derives from — so the scripted status map keys match the
// route's read exactly.
const EXPECTED = tenantApplicationSet([...TEST_MEMBERS, "erp"], TGUID, "prod");
const AUTH_APP = memberApplication(TGUID, "auth", "prod");

/** The AUTH member's Application as the appset renders it: ONE source on catalog, targeting the
 *  pointer's chartsRef and synced to whatever the cluster reached. Expressed through
 *  `sources`/`revisions` (not the singular fields), because a one-element `.spec.sources` array is
 *  exactly what the appset writes — which is why the singular `status.sync.revision` stays empty on
 *  this app. */
function authApp(targets: string, synced: string | null, over: Partial<ArgoAppStatus> = {}): ArgoAppStatus {
  return {
    syncRevision: null,
    syncSources: [{ repoURL: DEPLOY_REPO, revision: synced }],
    targetRevision: null,
    targetSources: [{ repoURL: DEPLOY_REPO, targetRevision: targets }],
    sync: "Synced",
    health: "Healthy",
    ...over,
  };
}

/** Build a name→status map where every member is Synced/Healthy, then apply the per-name overrides —
 *  so a test can flip ONE member (e.g. auth to a drifted revision, or drop a member to Missing). */
function statuses(over: Record<string, ArgoAppStatus | undefined> = {}): Map<string, ArgoAppStatus> {
  const m = new Map<string, ArgoAppStatus>();
  for (const name of EXPECTED) {
    m.set(name, name === AUTH_APP ? authApp(SHA, SHA) : { syncRevision: null, targetRevision: null, sync: "Synced", health: "Healthy" });
  }
  for (const [name, s] of Object.entries(over)) {
    if (s === undefined) m.delete(name); // drop => the route reads it Missing (completeness map)
    else m.set(name, s);
  }
  return m;
}

const SMOKE_OK: SmokeResult = { namespaceExists: true, workloads: [{ kind: "Deployment", name: "erp", available: true, desired: 1, ready: 1 }], externalSecretsReady: true };

/** The drift block the route answers with: the pointer's pin vs the deployed revision (`verdict`, one of
 *  DRIFT_VERDICT). */
interface Drift { pinned: string | null; deployed: string | null; verdict: DriftVerdict }

/** A resolver whose (master) path yields a scripted fan-out set read + smoke, so a test can drive the
 *  reconciliation endpoint's rollup + drift math without a cluster. */
function liveResolver(smoke: SmokeResult, set: ReadonlyMap<string, ArgoAppStatus> | { throwOnSet: Error }): FakeClusterKubeResolver {
  const argoReader = "throwOnSet" in set ? new FakeMasterArgoReader({ throwOnSet: set.throwOnSet }) : new FakeMasterArgoReader({ statuses: set });
  return new FakeClusterKubeResolver({
    clusterReader: new FakeClusterReader({ smoke }),
    argoReader,
    projectWriter: new FakeMasterProjectWriter(),
    argoNamespace: "argocd",
  });
}

async function makeTenantLive(resolver?: FakeClusterKubeResolver): Promise<{ app: Hono<AppEnv>; cookie: string }> {
  const store = new CredentialStore({ db: db.db, logger });
  const bus = new RunEventBus();
  // The live route is a pure READ — no run defs are needed; the bare registrations satisfies the executor dep.
  const executor = new Executor({ db: db.db, creds: store, bus, logger, runDefinitions: buildRunDefinitions({ db: db.db }), sshFactory: noSsh, actor: () => "op_system" });
  const session = new SessionCodec(db.db, config);
  const app = createApp({
    config, logger, getReadiness: () => ({ ok: true, checks: [] }), session,
    registerAuth: () => undefined,
    // resolver + catalogRepoUrl are wired together (both come from config.catalog), so the
    // "not configured" case below drops BOTH — the live read needs both or it degrades to SQL-only.
    registerProtected: (a) => registerTenantRoutes(a, { executor, db: db.db, onboardingEnabled: true, ...(resolver ? { resolver, catalogRepoUrl: DEPLOY_REPO } : {}) }),
  });
  const cookie = await session.mint({ sub: "op_test", groups: ["admins"], via: "oidc" });
  return { app, cookie };
}

describe("tenant live reconciliation (GET /api/tenants/:id/live)", () => {
  it("404 for an unknown tenant", async () => {
    seedTenant();
    const { app, cookie } = await makeTenantLive(liveResolver(SMOKE_OK, statuses()));
    const res = await app.request("/api/tenants/tnt_missing/live", authed(cookie));
    expect(res.status).toBe(404);
  });

  it("degrades to SQL-only (reason) when tenant onboarding is not configured (no resolver)", async () => {
    seedTenant();
    const { app, cookie } = await makeTenantLive(); // no resolver threaded
    const body = (await (await app.request("/api/tenants/tnt_1/live", authed(cookie))).json()) as Record<string, unknown>;
    expect(body).toMatchObject({ cluster: null, argo: null, drift: null, argocdUrl: null, reason: "onboarding-not-configured" });
    expect((body.row as { guid: string }).guid).toBe(TGUID);
  });

  it("aggregates the fan-out + reads the cluster; no drift when the base deployed SHA matches the pin", async () => {
    seedTenant();
    const { app, cookie } = await makeTenantLive(liveResolver(SMOKE_OK, statuses()));
    const body = (await (await app.request("/api/tenants/tnt_1/live", authed(cookie))).json()) as {
      row: { guid: string; domain: string; suspended: boolean };
      cluster: { ok: boolean; namespaceExists: boolean; externalSecretsReady: boolean };
      argo: { ok: boolean; sync: string; health: string; syncRevision: string | null };
      drift: Drift;
      argocdUrl: string | null;
    };
    expect(body.row).toMatchObject({ guid: TGUID, domain: "s1.example", suspended: false });
    expect(body.cluster).toMatchObject({ ok: true, namespaceExists: true, externalSecretsReady: true });
    // Every member Synced/Healthy ⇒ the rollup is Synced/Healthy; the base app carries the deployed SHA.
    expect(body.argo).toMatchObject({ ok: true, sync: "Synced", health: "Healthy", syncRevision: SHA });
    expect(body.drift).toEqual({ pinned: SHA, deployed: SHA, verdict: "converged" });
    // The deep-link points at the label-filtered fan-out on the master's ArgoCD.
    expect(body.argocdUrl).toContain("argo.s1.example/applications?labels=");
    expect(body.argocdUrl).toContain(encodeURIComponent(`platform/tenant=${TGUID}`));
  });

  it("reads the auth member's deployed revision from syncSources[0] when the singular syncRevision is empty (one-element .spec.sources)", async () => {
    seedTenant();
    // The auth member's Application expresses its ONE source inside `.spec.sources`, so ArgoCD reports
    // its revision in `status.sync.revisions[]` (mapped to syncSources) and leaves the singular
    // `status.sync.revision` empty — the shape `authApp` builds. singleSourceRevision must still
    // resolve the deployed SHA from the sole source; a null there would spuriously read as
    // pinned-but-not-deployed drift. Its DESIRED side is the same story: the pin
    // lives in `.spec.sources[0]`, so a reader of the singular `.spec.source` would find nothing.
    const { app, cookie } = await makeTenantLive(liveResolver(SMOKE_OK, statuses()));
    const body = (await (await app.request("/api/tenants/tnt_1/live", authed(cookie))).json()) as {
      argo: { ok: boolean; sync: string; health: string; syncRevision: string | null };
      drift: Drift;
    };
    // The deployed revision resolves from syncSources[0] (not the null singular) ⇒ equals the pin ⇒ no drift.
    expect(body.argo).toMatchObject({ ok: true, sync: "Synced", health: "Healthy", syncRevision: SHA });
    expect(body.drift).toEqual({ pinned: SHA, deployed: SHA, verdict: "converged" });
  });

  it("resolves the pin PER REPO: a foreign source on the auth member yields no pin, never that source's revision", async () => {
    seedTenant();
    // An auth member Application whose SYNC side is untouched (still catalog@SHA — what is
    // actually running) but whose TARGET side was rewritten to a foreign repo (a drifted/hand-edited
    // appset). targetedRevisionFor filters by repo, so the foreign source is never read positionally as
    // the pin: pinned comes back null (the tenants row carries no revision of its own to fall back on),
    // never DEPLOYED — the foreign source's own revision, which would be a lie about what catalog
    // pins. Positional reading is exactly what handed the Consumers card an install-branch NAME where a
    // SHA belonged.
    const foreign = authApp(SHA, SHA);
    const set = statuses({ [AUTH_APP]: { ...foreign, targetSources: [{ repoURL: "https://github.com/x/not-catalog.git", targetRevision: DEPLOYED }] } });
    const { app, cookie } = await makeTenantLive(liveResolver(SMOKE_OK, set));
    const body = (await (await app.request("/api/tenants/tnt_1/live", authed(cookie))).json()) as { drift: Drift };
    expect(body.drift).toEqual({ pinned: null, deployed: SHA, verdict: "drift" });
  });

  it("rolls up worst-of health + OutOfSync, and flags DRIFT when the auth member's deployed SHA != the pin", async () => {
    seedTenant();
    // The auth member still targets the recorded pin but the cluster sits on a different revision
    // (OutOfSync/Degraded); the other members stay Synced/Healthy.
    const set = statuses({ [AUTH_APP]: authApp(SHA, DEPLOYED, { sync: "OutOfSync", health: "Degraded" }) });
    const { app, cookie } = await makeTenantLive(liveResolver(SMOKE_OK, set));
    const body = (await (await app.request("/api/tenants/tnt_1/live", authed(cookie))).json()) as {
      argo: { ok: boolean; sync: string; health: string; syncRevision: string | null };
      drift: Drift;
    };
    // Any OutOfSync member ⇒ the set is OutOfSync; health is the WORST-of (Degraded over Healthy).
    expect(body.argo).toMatchObject({ ok: true, sync: "OutOfSync", health: "Degraded", syncRevision: DEPLOYED });
    expect(body.drift).toEqual({ pinned: SHA, deployed: DEPLOYED, verdict: "drift" });
  });

  it("still flags a REAL drift: the pointer moved but the cluster has not caught up", async () => {
    seedTenant();
    // What the pointer pins advanced to DEPLOYED while the synced revision is still SHA — the genuine
    // "cluster has not converged on the pointer" case the badge exists for. The record is stale too:
    // the bump did not come from a Manager run, so both verdicts fire, each on its own row.
    const set = statuses({ [AUTH_APP]: authApp(DEPLOYED, SHA, { sync: "OutOfSync", health: "Progressing" }) });
    const { app, cookie } = await makeTenantLive(liveResolver(SMOKE_OK, set));
    const body = (await (await app.request("/api/tenants/tnt_1/live", authed(cookie))).json()) as { drift: Drift };
    expect(body.drift).toEqual({ pinned: DEPLOYED, deployed: SHA, verdict: "drift" });
  });

  it("a MISSING member rolls up to health Missing + sync Unknown (the completeness gate)", async () => {
    seedTenant();
    // Drop the per-app member: absent from the set list ⇒ the route reads it Missing.
    const set = statuses({ [`${TGUID}-erp-prod`]: undefined });
    const { app, cookie } = await makeTenantLive(liveResolver(SMOKE_OK, set));
    const body = (await (await app.request("/api/tenants/tnt_1/live", authed(cookie))).json()) as {
      argo: { ok: boolean; sync: string; health: string };
      drift: { verdict: DriftVerdict };
    };
    // Not every member is Synced (erp reads Unknown/Missing) and none is OutOfSync ⇒ Unknown; worst-of ⇒ Missing.
    expect(body.argo).toMatchObject({ ok: true, sync: "Unknown", health: "Missing" });
    // The auth member still matches the pin, so this is not drift — the incompleteness shows in health, not drift.
    expect(body.drift.verdict).toBe("converged");
  });

  it("an UNREADABLE ArgoCD is drift=UNKNOWN, never a false 'drift' badge; the smoke still shows", async () => {
    seedTenant();
    const { app, cookie } = await makeTenantLive(liveResolver(SMOKE_OK, { throwOnSet: new Error("argocd unreachable") }));
    const body = (await (await app.request("/api/tenants/tnt_1/live", authed(cookie))).json()) as {
      cluster: { ok: boolean };
      argo: { ok: boolean; error?: string };
      drift: Drift;
      argocdUrl: string | null;
    };
    // The set read failed on its own row, but NEITHER verdict may claim a difference — UNKNOWN, not
    // drifted and not stale: with no readable Application there is no pin to compare anything against,
    // and the tenants row carries no revision of its own to fall back on either.
    expect(body.cluster.ok).toBe(true); // the smoke read is fanned independently — it still succeeds
    expect(body.argo.ok).toBe(false);
    expect(body.drift).toEqual({ pinned: null, deployed: null, verdict: "unknown" });
    expect(body.argocdUrl).toContain("argo.s1.example"); // the link survives a failed read
  });

  // The tenant side of the suspend question — and the reason the answer is per KIND.
  // A consumer suspend MOVES the pointer so the appset stops generating its one Application, and the live
  // route must read that absence as the suspend rather than as drift. A tenant suspend is a different
  // operation: a FIELD FLIP on the one tenant.yaml — every member Application keeps being generated and
  // stays Synced/Healthy, and the charts render the off state (replicas 0, no Ingress) — so a tenant
  // suspend PRUNES NOTHING (tenant-lifecycle.run.ts: watch-off waits for the whole fan-out to CONVERGE,
  // never to vanish). The auth member is exactly what this route reads the pin off, so a suspended
  // tenant's fan-out is compared exactly like an active one's, and giving tenants the consumer's
  // absence-means-suspended carve-out would blind the card to a suspended tenant whose auth member is
  // genuinely gone (the test after this one).
  it("a SUSPENDED tenant keeps EVERY member's Application by design — nothing is pruned, so the pin still resolves and is still compared", async () => {
    seedTenant({ status: "suspended", suspended: true });
    // What a correctly suspended tenant looks like: the WHOLE fan-out stays Synced/Healthy — only the
    // workloads inside each member namespace scale to zero, which this route's argo read cannot see at
    // all (that fact is the smoke/workload read's job, not this one's).
    const { app, cookie } = await makeTenantLive(liveResolver(SMOKE_OK, statuses()));
    const body = (await (await app.request("/api/tenants/tnt_1/live", authed(cookie))).json()) as {
      row: { status: string; suspended: boolean };
      argo: { ok: boolean; sync: string; health: string };
      drift: Drift;
    };
    expect(body.row).toMatchObject({ status: "suspended", suspended: true });
    expect(body.argo).toMatchObject({ ok: true, sync: "Synced", health: "Healthy" });
    expect(body.drift).toEqual({ pinned: SHA, deployed: SHA, verdict: "converged" });
  });

  it("a tenant whose AUTH member's Application is GONE reads the neutral not-deployed, never converged", async () => {
    // A missing auth member is a real fault whatever the row's status: the member carries the tenant's
    // own catalog chart, and nothing but tenant-offboard/-purge ever removes it. The tenants row
    // carries no revision of its own any more (the route always passes recorded: null to driftOf), so
    // once ArgoCD cannot resolve the auth member's Application there is nothing left to promote to
    // `pinned`: no comparison took place, and the honest answer is the neutral not-deployed — never the
    // green converged, which would say the tenant is fine.
    seedTenant();
    const set = statuses({ [AUTH_APP]: undefined });
    const { app, cookie } = await makeTenantLive(liveResolver(SMOKE_OK, set));
    const body = (await (await app.request("/api/tenants/tnt_1/live", authed(cookie))).json()) as { drift: Drift };
    expect(body.drift).toEqual({ pinned: null, deployed: null, verdict: "not-deployed" });
  });

  it("a SETTLED tenant's absent fan-out reads the NEUTRAL 'not-deployed' — never 'drift', and never green", async () => {
    // The one tenant state that DOES match the consumer rule: tenant-offboard git-rm's the whole pointer
    // directory (and tenant-purge additionally deprovisions the tenant), so nothing generates the base any
    // more and its absence is what the removal was for. Such a row is off the Reconciliation cards
    // (tenantRows.ts splits it onto the offboarded list, and a purged one off the page entirely), but this
    // route still answers for it by URL and must answer honestly.
    //
    // Honestly means the neutral verdict and not the green one, for the same reason as on the consumer side:
    // nothing is pinned and nothing runs, so no comparison took place and none may be reported. A settled
    // tenant is additionally the state a create-tenant ABORT or a half-finished removal leaves a row in, and
    // "in sync" said of a row whose cluster state may still be standing is the wrong direction to be wrong.
    seedTenant({ status: "offboarded" });
    const set = statuses(Object.fromEntries(EXPECTED.map((n) => [n, undefined])));
    const { app, cookie } = await makeTenantLive(liveResolver(SMOKE_OK, set));
    const body = (await (await app.request("/api/tenants/tnt_1/live", authed(cookie))).json()) as { drift: Drift };
    expect(body.drift).toEqual({ pinned: null, deployed: null, verdict: "not-deployed" });
  });

  it("a PROVISIONING tenant's app rows still count toward the expected set — a half-created tenant reads Missing, not Healthy", async () => {
    // create-tenant records the tenant AND its app rows BEFORE it deploys, so the
    // rows of a half-created tenant sit at "provisioning". This route's expected set therefore filters
    // "everything except offboarded", the exact mirror of tenantWatchSet — with an "active" filter the
    // erp member would drop out, the rollup would run over base+auth alone and the card would read
    // Synced/Healthy for a tenant whose app never deployed.
    seedCluster();
    db.db.insert(tenants).values({ id: "tnt_1", clusterId: "cls_1", guid: TGUID, subdomain: "acme.example", stage: "prod", members: ["auth", "jobs", "report"], identityProvider: "auth", provenance: "manager", status: "provisioning" }).run();
    db.db.insert(tenantApps).values({ id: "tna_1", tenantId: "tnt_1", name: "erp", status: "provisioning" }).run();
    const { app, cookie } = await makeTenantLive(liveResolver(SMOKE_OK, statuses({ [`${TGUID}-erp-prod`]: undefined })));
    const body = (await (await app.request("/api/tenants/tnt_1/live", authed(cookie))).json()) as {
      row: { status: string };
      argo: { ok: boolean; sync: string; health: string };
    };
    expect(body.row.status).toBe("provisioning"); // the TRACE says unfinished…
    expect(body.argo).toMatchObject({ ok: true, sync: "Unknown", health: "Missing" }); // …and the FACTS agree
  });
});
