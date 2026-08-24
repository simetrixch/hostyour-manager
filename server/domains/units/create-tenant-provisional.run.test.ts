import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { seedUnitSizes } from "./unit-size.ts";
import { seedQuota } from "../../../shared/unit-size.ts";
import { eq } from "drizzle-orm";
import { openDb, type DbHandle } from "../../db/client.ts";
import { servers, clusters, tenants, tenantApps } from "../../db/schema/inventory.ts";
import { makeCreateTenantDef, CreateTenantParams, type TenantOnboardPorts } from "./create-tenant.run.ts";
import { TenantRegistrations } from "./tenant-registrations.ts";
import type { ClusterStageResolver } from "./registrations.ts";
import { memberAppProject, memberNamespace, tenantApplicationSet } from "./tenant-fanout.ts";
import { renderTenantAppProject } from "./appproject.ts";
import { composeTenantReport, TENANT_MANIFEST_PATH } from "./gates/tenant-gates.ts";
import { FakeRepoReader, FakePlatformRepo } from "../../adapters/git/testing/fake.ts";
import { FakeHelmRenderer } from "../../adapters/helm/testing/fake.ts";
import { FakeMasterArgoReader, FakeClusterReader, FakeMasterProjectWriter, FakeClusterKubeResolver, FakeBuildRbacWriter } from "../../adapters/kube/testing/fake.ts";
import { FakeActivator } from "../../adapters/activation/testing/fake.ts";
import { FakeRegistryProbe } from "../../adapters/registry/testing/fake.ts";
import { resolveRunTenantState } from "./tenant-orphans.ts";
import { AppError } from "../../kernel/errors.ts";
import type { Step, StepCtx, Cleanup } from "../../executor/types.ts";
import type { CredentialStore } from "../../security/store.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { ArgoAppStatus } from "../../adapters/kube/port.ts";
import type { RenderedDoc } from "../../adapters/helm/port.ts";
import type { TenantValidationReport } from "../../../shared/tenant.ts";
import { STANDING_MEMBER_NAMES as TEST_MEMBERS, testMembers } from "./tenant-members.fixture.ts";
import type { VaultSeeder } from "../../adapters/vault/seeder-port.ts";


// THE ROOT-CAUSE FIX of the orphan-tenant defect, on its own two axes:
//
//   RECORD INTENT, NOT SUCCESS. The tenants row used to be written LAST, so it recorded
//   SUCCESS while git and the cluster had been mutated several steps earlier — and a failure in between
//   left a tenant every removal run kind was structurally unable to name. record-provisional now writes it
//   FIRST, at status "provisioning"; record-inventory only settles it to "active". The load-bearing
//   asymmetry these tests pin is that "provisioning" is INSERT-ONLY: a resumed run must never demote a
//   row record-inventory already lifted to "active".
//
//   ONE TEARDOWN PATH. create-tenant's abort-with-cleanup used to be a private pair that
//   deleted the isolation AppProject WITHOUT waiting for the fan-out to prune and swallowed every error
//   in a bare catch. It is now the SHARED tenant-teardown.ts steps — the same four the replace,
//   tenant-offboard and tenant-purge run — armed as ONE registration from record-provisional.
//
//   PROBE, DON'T FOLD. create-tenant's one "does a pointer stand here?" question — the guid-mint
//   collision check — asks it through the registrations's TOLERANT scan, like every other probe in the
//   removal family: a directory whose sibling files drifted answers "unreadable" (the guid is TAKEN)
//   instead of throwing the strict five-file fold's error out through the whole plan.
//
// Its own file (the tenant-ensure-images.run.test.ts / create-tenant-activate pattern) so
// create-tenant.run.test.ts stays inside the 400-line budget.

const SHA = "a".repeat(40);
const GUID = "zsjs023ctne0"; // a live-shaped throwaway guid
const DEPLOY_URL = "https://github.com/simetrixch/catalog.git";
const PLATFORM_URL = "https://github.com/simetrixch/hostyour-cloud.git";
const APPS = [{ name: "erp" }];
const EXPECTED = tenantApplicationSet([...TEST_MEMBERS, ...APPS.map((a) => a.name)], GUID, "prod");
/** The four cleanup names create-tenant arms — the shared teardown under its ABORT flavour. */
const ABORT_STEPS = [`abort-${GUID}-remove`, `abort-${GUID}-watch-prune`, `abort-${GUID}-delete-projects`, `abort-${GUID}-record`];

const MANIFEST_YAML = `
apiVersion: hostyour.cloud/v1
kind: ConsumerManifest
name: catalog
owner: platform
envs: [dev, prod]
builds:
  - name: engine
    containerfile: Containerfile
tenant:
  members:
    - { name: auth, chart: charts/example-auth, identityProvider: true, namespaceLabels: { platform/redis-consumer: "true" } }
    - { name: jobs, chart: charts/example-jobs }
    - { name: report, chart: charts/example-report }
  perApp:
    engine: { chart: charts/example-engine }
    front: { chart: charts/example-ui, override: { web: { chart: charts/example-web } } }
`;

const doc = (kind: string, over: Partial<RenderedDoc> = {}): RenderedDoc => ({
  apiVersion: "v1", kind, name: `${kind.toLowerCase()}-x`, namespace: GUID, raw: { kind }, ...over,
});
// No Tenant CR document: the Manager provisions that object itself (provision-tenant-cr), and the
// T3 isolation gate now refuses a chart that renders one (CLUSTER_SCOPED_FORBIDDEN includes "Tenant").
const CLEAN_DOCS = [
  doc("Namespace", { namespace: "", raw: { kind: "Namespace" } }),
  doc("Deployment"),
];

// The registry host the ports fixture resolves for the target cluster — in the default topology the
// build plane is the master, so the fixture answers zot on m1.example.
const REGISTRY_HOST = "zot.m1.example";

/** A cluster-marking resolver that answers every cluster short name at "prod" — every fixture in this
 *  file lands its tenant on s1/prod, so a single-stage stand-in is all TenantRegistrations needs to
 *  satisfy commitTenant's stage boundary check. */
const CLUSTER_STAGE: ClusterStageResolver = async (cluster) => ({ name: cluster, stage: "prod" });

function passReport(): TenantValidationReport {
  return composeTenantReport({
    resolvedSha: SHA, probeGuid: GUID, appsValidated: ["erp"], resolvedMembers: ["base", "auth", "erp-engine", "erp-front"],
    startedAt: 1, finishedAt: 2, manifest: null,
    gates: [{ id: "T1", title: "manifest", severity: "hard", status: "pass", expected: "e", found: "f", reason: null, detail: "d" }],
  });
}

let db: DbHandle;
// The size table is seeded at BOOT (boot/wire.ts), not by the migration, so an in-memory database
// starts without it — and write-pointer resolves the tenant's ceiling against it.
beforeEach(() => { db = openDb(":memory:"); seedUnitSizes(db.db); });
afterEach(() => { db.sqlite.close(); });

type FakeKube = { argo?: FakeMasterArgoReader; cluster?: FakeClusterReader; projects?: FakeMasterProjectWriter };

/** A VaultSeeder for the tenant runs: create-tenant seeds the crypto entry through it, and nothing
 *  else here touches Vault. `created: true` models the normal first run; the consumer-side methods
 *  throw, because a tenant run reaching one of them would be a wiring mistake, not a pass. */
function fakeTenantSeeder(): VaultSeeder {
  return {
    seed: () => Promise.reject(new Error("a tenant run never seeds a consumer entry")),
    seedPostgres: () => Promise.reject(new Error("a tenant run never seeds postgres")),
    seedMongodb: () => Promise.reject(new Error("a tenant run never seeds mongodb")),
    seedBuildRepoPat: () => Promise.reject(new Error("a tenant run never seeds a repo pat")),
    deleteBuildRepoPat: async () => {},
    deleteApp: async () => {},
    deletePostgres: async () => {}, deleteMongodb: async () => {},
    seedTenantCrypto: async () => ({ created: true }),
    deleteTenantCrypto: async () => {},
  };
}

function ports(over: Partial<TenantOnboardPorts> & FakeKube = {}): TenantOnboardPorts {
  const { argo, cluster, projects, ...portOver } = over;
  return {
    seeder: fakeTenantSeeder(),
    repo: new FakeRepoReader({ resolvedSha: SHA, files: { [TENANT_MANIFEST_PATH]: MANIFEST_YAML } }),
    helm: new FakeHelmRenderer({ fallback: { ok: true, docs: CLEAN_DOCS } }),
    registrations: new TenantRegistrations(new FakePlatformRepo(), CLUSTER_STAGE),
    resolver: new FakeClusterKubeResolver({
      clusterReader: cluster ?? new FakeClusterReader({ deployState: { domain: "s1.example", stage: "prod", writtenAt: "x", generation: 3 } }),
      argoReader: argo ?? new FakeMasterArgoReader(), // no scripted statuses ⇒ every member reads Missing ⇒ pruned
      projectWriter: projects ?? new FakeMasterProjectWriter(),
      argoNamespace: "argocd",
    }),
    catalogRepoUrl: DEPLOY_URL,
    platformRepoURL: PLATFORM_URL,
    argoWatchTimeoutMs: 1000,
    resolveUnitApex: async () => "example.com",
    resolveClusterValueFiles: async () => [{ path: "installation/profile.yaml", content: `global:\n  endpoints:\n    registrations:\n      host: ${REGISTRY_HOST}\n` }],
    registryProbe: new FakeRegistryProbe(),
    buildRbac: new FakeBuildRbacWriter(),
    attestedBuilds: async () => [{ unit: "example-platform", build: "example-engine" }],
    consumerNames: async () => [],
    ...portOver,
  };
}

function params(over: Partial<CreateTenantParams> = {}): CreateTenantParams {
  return CreateTenantParams.parse({
    guid: GUID, subdomain: "acme.example", stage: "prod", clusterId: "cls_1", domain: "s1.example",
    members: testMembers(APPS),
    identityProvider: "auth",
    cluster: "s1", chartsRef: SHA, registryHost: REGISTRY_HOST,
    apps: APPS, seedUsers: false, quota: seedQuota("small"), owner: "team-acme",
    report: passReport(), expectedApps: EXPECTED, catalogRepoUrl: DEPLOY_URL,
    ...over,
  });
}

/** A step context that CAPTURES the cleanups a step registers (the executor persists their names and
 *  resolves them against def.cleanups() at abort time — see executor.abortWithCleanup). */
function ctx(p: CreateTenantParams, stepName: string, opts: { runId?: string; logs?: string[]; cleanups?: Cleanup[] } = {}): StepCtx {
  return {
    runId: opts.runId ?? "run_tnt", stepName, db: db.db, creds: {} as unknown as CredentialStore, params: p,
    secrets: {
      // What approve collected: the two sealed values and the endpoint in the clear. A tenant
      // created without them has an engine that refuses to boot, so no scenario here can omit them.
      get: (n: string) => ({
        "tenant-storage:key": Buffer.from("r2-access-key", "utf8"),
        "tenant-storage:secret": Buffer.from("r2-secret-key", "utf8"),
        "activation-input:storageEndpoint": Buffer.from("https://acct.eu.r2.cloudflarestorage.com", "utf8"),
      })[n],
      wipe: () => undefined,
    }, signal: new AbortController().signal,
    logger: {} as unknown as Logger,
    ssh: () => Promise.reject(new Error("no ssh")), openPasswordSession: () => Promise.reject(new Error("no ssh")),
    closePasswordSession: () => undefined, attest: () => Promise.reject(new Error("no attest")),
    log: (_s, t) => opts.logs?.push(t), checkpoint: () => undefined, readCheckpoint: () => undefined,
    registerCleanup: (c: Cleanup) => { opts.cleanups?.push(c); },
  };
}

function seedClusters(): void {
  db.db.insert(servers).values({ id: "srv_1", name: "s1", host: "10.1.1.11", sshUser: "root", role: "slave", status: "healthy" }).run();
  db.db.insert(clusters).values({ id: "cls_1", serverId: "srv_1", stage: "prod", domain: "s1.example", status: "active", tier: "rehearsal" }).run();
}

const stepNamed = (prt: TenantOnboardPorts, p: CreateTenantParams, name: string): Step => {
  const found = makeCreateTenantDef(prt).steps(p).find((s) => s.name === name);
  if (!found) throw new Error(`no step ${name}`);
  return found;
};

const tenantRow = () => db.db.select().from(tenants).where(eq(tenants.guid, GUID)).get();
const appRows = (tenantId: string) => db.db.select().from(tenantApps).where(eq(tenantApps.tenantId, tenantId)).all();

/** Script the fan-out as still LIVE so allPruned fails — the "the fan-out did not go" case. */
function lingeringArgo(): FakeMasterArgoReader {
  const m = new Map<string, ArgoAppStatus>();
  for (const n of EXPECTED) m.set(n, { syncRevision: SHA, targetRevision: null, sync: "Synced", health: "Healthy" });
  return new FakeMasterArgoReader({ statuses: m });
}

describe("record-provisional — the row exists BEFORE anything is deployed", () => {
  it("follows attest-target and the subdomain belt (both read-only) and precedes every mutation", () => {
    const names = makeCreateTenantDef(ports()).steps(params()).map((s) => s.name);
    expect(names[0]).toBe("attest-target"); // attest stays step 0
    expect(names[1]).toBe("ensure-subdomain-free"); // read-only — refuses a raced subdomain before any write
    expect(names[2]).toBe("record-provisional");
    // Nothing that touches git or the cluster may precede it.
    for (const mutating of ["ensure-images", "seed-tenant-crypto", "apply-appprojects", "write-registration"]) {
      expect(names.indexOf(mutating)).toBeGreaterThan(2);
    }
  });

  it("writes the tenant + its app rows at status \"provisioning\", with no pointer, no Tenant CR and no AppProject yet", async () => {
    seedClusters();
    const projects = new FakeMasterProjectWriter();
    const cluster = new FakeClusterReader({ deployState: { domain: "s1.example", stage: "prod", writtenAt: "x", generation: 3 } });
    const prt = ports({ projects, cluster });
    const p = params();
    await stepNamed(prt, p, "record-provisional").run(ctx(p, "record-provisional"));

    const row = tenantRow();
    expect(row?.status).toBe("provisioning");
    expect(row?.subdomain).toBe("acme.example");
    expect(row?.lastRunId).toBe("run_tnt");
    expect(appRows(row!.id).map((a) => [a.name, a.status])).toEqual([["erp", "provisioning"]]);
    // The whole point: the row is the ONLY thing that exists at this moment.
    expect(await prt.registrations.readTenant("prod", GUID)).toBeNull();
    for (const member of [...TEST_MEMBERS, ...APPS.map((a) => a.name)]) {
      expect(projects.get("argocd", memberAppProject(GUID, member))).toBeUndefined();
    }
  });

  it("record-inventory SETTLES the same rows to active", async () => {
    seedClusters();
    const prt = ports();
    const p = params();
    await stepNamed(prt, p, "record-provisional").run(ctx(p, "record-provisional"));
    await stepNamed(prt, p, "record-inventory").run(ctx(p, "record-inventory"));
    const row = tenantRow();
    expect(row?.status).toBe("active");
    expect(appRows(row!.id).map((a) => a.status)).toEqual(["active"]);
    expect(db.db.select().from(tenants).all()).toHaveLength(1); // upserted, never duplicated
  });

  it("a RESUME never demotes a settled tenant: re-running record-provisional leaves \"active\" alone", async () => {
    seedClusters();
    const prt = ports();
    const p = params();
    const rec = stepNamed(prt, p, "record-provisional");
    await rec.run(ctx(p, "record-provisional"));
    await stepNamed(prt, p, "record-inventory").run(ctx(p, "record-inventory"));
    // The resume: the executor re-walks the run from the top, so record-provisional runs a SECOND time
    // against a row record-inventory has already lifted to "active". Demoting it would paint a live
    // tenant as unfinished, hide its actions behind the provisional refusals and pull it out of the
    // reconciliation view — status is therefore written on INSERT only.
    await rec.run(ctx(p, "record-provisional", { runId: "run_resume" }));

    const row = tenantRow();
    expect(row?.status).toBe("active");
    expect(appRows(row!.id).map((a) => a.status)).toEqual(["active"]);
    // It is still an UPSERT, not a no-op — every other column converges on the params being run.
    expect(row?.lastRunId).toBe("run_resume");
  });

  it("a resume leaves a SUSPENDED tenant suspended — status and its `suspended` projection move as ONE unit", async () => {
    seedClusters();
    const prt = ports();
    const p = params();
    await stepNamed(prt, p, "record-provisional").run(ctx(p, "record-provisional"));
    // What tenant-suspend's record step writes: the two fields together, never one of them.
    db.db.update(tenants).set({ status: "suspended", suspended: true }).where(eq(tenants.guid, GUID)).run();
    await stepNamed(prt, p, "record-provisional").run(ctx(p, "record-provisional"));
    // Rewriting `suspended` alone would leave the row claiming status "suspended" while the appset
    // selector reads it as live — so the provisional phase leaves the whole lifecycle unit alone.
    expect(tenantRow()).toMatchObject({ status: "suspended", suspended: true });
  });
});

// THE OTHER END of the same axis. record-provisional stops a create-tenant from leaving an UNNAMEABLE
// tenant; this pins that the run's failure must never be read as one when the tenant is in fact LIVE.
// `activate` (the first-admin invite) is deliberately the LAST step, after record-inventory, so a failed
// invite never rolls back a live deployment — and an HTTP 503 from a freshly started tenant example-auth
// is a known live condition. The failed run's screen therefore has to resolve the tenants ROW, not
// conclude "failed create-tenant ⇒ orphan" and hold out the one run kind that deprovisions the tenant.
describe("a create-tenant that fails only at `activate` leaves a LIVE tenant", () => {
  const TOKEN_PATH = `${memberNamespace(GUID, "auth")}/hostyour-app-secrets/AUTH_BOOTSTRAP_TOKEN`;

  it("record-inventory has already settled the row to active — so the run's tenant reads LIVE, never purgeable", async () => {
    seedClusters();
    // A tenant example-auth that is up but not yet serving: create-tenant-activate throws on any non-2xx
    // other than 409, so the run fails here with everything before it green.
    const activator = new FakeActivator({ response: { status: 503, ok: false, json: null, bodyText: "Service Unavailable" } });
    const cluster = new FakeClusterReader({
      deployState: { domain: "s1.example", stage: "prod", writtenAt: "x", generation: 3 },
      secretValues: { [TOKEN_PATH]: "boot_tok_abc" },
    });
    const prt = ports({ activator, cluster });
    const p = params({ adminEmail: "admin@acme.test" });

    await stepNamed(prt, p, "record-provisional").run(ctx(p, "record-provisional"));
    await stepNamed(prt, p, "record-inventory").run(ctx(p, "record-inventory"));
    await expect(stepNamed(prt, p, "activate").run(ctx(p, "activate"))).rejects.toThrow(/HTTP 503/);

    // The tenant is deployed, settled and serving; only the invite did not land.
    expect(tenantRow()?.status).toBe("active");
    expect(appRows(tenantRow()!.id).map((a) => a.status)).toEqual(["active"]);
    // What the failed run's screen reads. "live" is the state that offers NO purge and says the tenant
    // is serving — the alternative ("orphan") would put a purge button, plus copy claiming the tenant
    // "may still exist" and is "listed as unfinished", in front of a tenant whose Tenant CR that purge
    // would delete, dropping its Mongo databases and its Vault path.
    const state = resolveRunTenantState(db.db, "run_tnt", p);
    expect(state.state).toBe("live");
    expect(state).toMatchObject({ row: { tenantId: tenantRow()!.id, status: "active", suspended: false } });
  });
});

describe("create-tenant's abort-with-cleanup IS the shared teardown", () => {
  it("record-provisional arms all four teardown steps, in teardown order, and they resolve against def.cleanups()", async () => {
    seedClusters();
    const prt = ports();
    const p = params();
    const cleanups: Cleanup[] = [];
    await stepNamed(prt, p, "record-provisional").run(ctx(p, "record-provisional", { cleanups }));
    // ONE registration point is what fixes the ORDER: abortWithCleanup reverses across STEPS, not within
    // one, so a single step's cleanups run in registration order — remove -> watch-prune ->
    // delete-project -> record, the order tenant-offboard runs them in.
    expect(cleanups.map((c) => c.name)).toEqual(ABORT_STEPS);
    // abortWithCleanup resolves the PERSISTED names against def.cleanups(params); a name that does not
    // resolve would leave the compensation un-runnable, so the two must be built from the same source.
    expect((makeCreateTenantDef(prt).cleanups?.(p) ?? []).map((c) => c.name)).toEqual(ABORT_STEPS);
  });

  it("no OTHER step registers a cleanup — the inverse is armed exactly once", async () => {
    seedClusters();
    const prt = ports();
    const p = params();
    const cleanups: Cleanup[] = [];
    for (const s of ["seed-tenant-crypto", "apply-appprojects", "write-registration"]) {
      await stepNamed(prt, p, s).run(ctx(p, s, { cleanups }));
    }
    expect(cleanups).toEqual([]);
  });

  it("WAITS for the fan-out to prune and FAILS LOUD when it does not — the old pair did neither", async () => {
    // Defect 1: the replaced cleanup deleted the isolation AppProject without ever waiting for the
    // prune. Defect 2: it wrapped every call in a bare `catch {}`, so a compensation that failed
    // reported success. The shared teardown waits, and the ABORT flavour is fail-loud (there is no
    // cluster-side backstop in an abort — no Tenant CR delete, no namespace delete).
    const p = params();
    const prt = ports({ argo: lingeringArgo() });
    const cleanups = makeCreateTenantDef(prt).cleanups?.(p) ?? [];
    const watch = cleanups.find((c) => c.name === `abort-${GUID}-watch-prune`)!;
    await expect(watch.run(ctx(p, "cleanup:watch-prune"))).rejects.toThrow(/fan-out was not pruned/);
    // And the projects delete is a LATER step, so a stuck fan-out stops the compensation before it.
    expect(cleanups.findIndex((c) => c.name === `abort-${GUID}-delete-projects`)).toBeGreaterThan(cleanups.findIndex((c) => c.name === watch.name));
  });

  it("rolls the whole tenant back: pointer removed, every member's AppProject deleted, the provisional row flipped offboarded", async () => {
    seedClusters();
    const projects = new FakeMasterProjectWriter();
    const prt = ports({ projects });
    const p = params();
    const members = [...TEST_MEMBERS, ...APPS.map((a) => a.name)];
    // Deploy as far as write-registration, then compensate — the abort a failed watch-sync-set would trigger.
    for (const s of ["record-provisional", "seed-tenant-crypto", "apply-appprojects", "write-registration"]) {
      await stepNamed(prt, p, s).run(ctx(p, s));
    }
    expect(await prt.registrations.readTenant("prod", GUID)).not.toBeNull();
    for (const member of members) expect(projects.get("argocd", memberAppProject(GUID, member))).toBeDefined();

    const logs: string[] = [];
    for (const c of makeCreateTenantDef(prt).cleanups?.(p) ?? []) await c.run(ctx(p, `cleanup:${c.name}`, { logs }));

    expect(await prt.registrations.readTenant("prod", GUID)).toBeNull();
    for (const member of members) expect(projects.get("argocd", memberAppProject(GUID, member))).toBeUndefined();
    // The record step found the row by (clusterId, guid) even though the frozen target carries
    // tenantId null — record-provisional mints that id at EXECUTE time, so no params could hold it.
    const row = tenantRow();
    expect(row?.status).toBe("offboarded");
    expect(appRows(row!.id).map((a) => a.status)).toEqual(["offboarded"]); // a PROVISIONING app row is flipped too
    expect(logs.some((l) => l.includes(`rolled-back tenant ${GUID} recorded as offboarded`))).toBe(true);
  });

  it("is safe when the run died BEFORE it deployed: every step is idempotent on an absent footprint", async () => {
    seedClusters();
    const projects = new FakeMasterProjectWriter();
    const prt = ports({ projects });
    const p = params();
    await stepNamed(prt, p, "record-provisional").run(ctx(p, "record-provisional"));
    // Nothing was ever written — arming the teardown this early must therefore cost nothing.
    const logs: string[] = [];
    for (const c of makeCreateTenantDef(prt).cleanups?.(p) ?? []) await c.run(ctx(p, `cleanup:${c.name}`, { logs }));
    expect(logs.some((l) => l.includes("pointer already removed") && l.includes("resume"))).toBe(true);
    expect(tenantRow()?.status).toBe("offboarded");
  });

  it("tolerates a tenant with NO row at all (the pre-record-provisional orphan) — it just has nothing to mark", async () => {
    seedClusters();
    const projects = new FakeMasterProjectWriter();
    // A single member's project left standing, e.g. by a run that died right after apply-appprojects —
    // the teardown must reap it even though it was never row-backed.
    await projects.applyAppProject(
      "argocd",
      renderTenantAppProject({ guid: GUID, member: "auth", argoNamespace: "argocd", catalogRepoUrl: DEPLOY_URL, platformRepoURL: PLATFORM_URL, cluster: "s1" }),
    );
    const prt = ports({ projects });
    const p = params();
    const logs: string[] = [];
    for (const c of makeCreateTenantDef(prt).cleanups?.(p) ?? []) await c.run(ctx(p, `cleanup:${c.name}`, { logs }));
    expect(projects.get("argocd", memberAppProject(GUID, "auth"))).toBeUndefined();
    expect(logs.some((l) => l.includes(`rolled-back tenant ${GUID} had no inventory row`))).toBe(true);
  });
});

describe("the guid mint probes with the TOLERANT scan", () => {
  it("a pointer the strict fold chokes on cannot wedge a create-tenant plan", async () => {
    // mintFreeGuid asks ONE question of each candidate: does registrations/<guid>/<stage>.yaml stand?
    // It used to ask through readTenant, which folds all five files and THROWS on a drifted
    // auth/jobs/report/reset.yaml — so a candidate landing on such a directory failed the whole plan
    // instead of being discarded, and no tenant could be created at that stage until someone repaired
    // the file by hand. The candidate guid is CSPRNG-minted and cannot be planted in advance, so the
    // strict fold's throw is injected on the registrations itself: the scan-grade probe never calls it, while
    // "absent" — the one answer that means the guid is FREE — still comes from the real scan.
    seedClusters();
    const registrations = new TenantRegistrations(new FakePlatformRepo(), CLUSTER_STAGE);
    registrations.readTenant = () => Promise.reject(new AppError("INTERNAL", `tenant file tenants/prod/${GUID}/reset.yaml failed its schema: nonce Invalid input`));
    const result = await makeCreateTenantDef(ports({ registrations })).planStream!(
      { clusterId: "cls_1", subdomain: "acme.example", owner: "team-acme", apps: APPS, trio: { jobs: false } },
      { db: db.db, log: () => undefined, signal: new AbortController().signal },
    );
    expect(result.outcome).toBe("planned");
    if (result.outcome !== "planned") return;
    expect(result.params.guid).toMatch(/^[0-9a-hjkmnp-tv-z]{12}$/);
  });
});
