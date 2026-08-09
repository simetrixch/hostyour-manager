import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { openDb, type DbHandle } from "../../db/client.ts";
import { servers, clusters, tenants, tenantApps } from "../../db/schema/inventory.ts";
import { tenantTeardownSteps, TenantTeardownTargetSchema, REPLACE_TEARDOWN, type TenantTeardownTarget, type TenantTeardownOpts } from "./tenant-teardown.ts";
import { TenantRegistry } from "./tenant-registry.ts";
import type { ClusterStageResolver } from "./registry.ts";
import { renderTenantAppProject } from "./appproject.ts";
import type { TenantLifecyclePorts } from "./lifecycle.ts";
import { memberAppProject, tenantApplicationSet } from "./tenant-fanout.ts";
import { FakePlatformRepo } from "../../adapters/git/testing/fake.ts";
import { FakeMasterArgoReader, FakeClusterReader, FakeMasterProjectWriter, FakeClusterKubeResolver, FakeBuildRbacWriter } from "../../adapters/kube/testing/fake.ts";
import { renderTenantArgoSync } from "./build-rbac.ts";
import type { ArgoAppStatus } from "../../adapters/kube/port.ts";
import type { Step, StepCtx } from "../../executor/types.ts";
import type { CredentialStore } from "../../security/store.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { Stage } from "../../../shared/enums.ts";
import type { TenantRegistration } from "../../../shared/tenant.ts";
import { ARGO_NS, STANDING_MEMBER_NAMES as TEST_MEMBERS, testMembers, TEST_QUOTA } from "./tenant-members.fixture.ts";


// tenant-teardown.ts is the ONE pointer-driven teardown both the create-tenant replace and the
// orphan removal compose. These tests pin the OPTS contract that makes it shareable — the
// step-name prefix, the fail-loud/fail-soft prune policy, the per-flavour wording and WHERE a composing
// run's `cascade` lands (the record step must stay last) — plus the proof that a NON-replace flavour
// drives the same four steps end to end. The replace flavour's own behaviour inside a composed
// create-tenant run stays pinned by tenant-replace.run.test.ts.

const SHA = "a".repeat(40);
const GUID = "zsjs023ctne0";
const SUB = "acme.example";
const DEPLOY_REPO = "https://github.com/simetrixch/catalog.git";
const PLATFORM_REPO = "https://github.com/simetrixch/hostyour-cloud.git";
const APPS = [{ name: "erp" }];
const WATCH = tenantApplicationSet([...TEST_MEMBERS, ...APPS.map((a) => a.name)], GUID, "prod");
// The tenant's members — the trio plus its one app. The teardown deletes ONE AppProject per entry.
const MEMBERS = [...TEST_MEMBERS, ...APPS.map((a) => a.name)];

let db: DbHandle;
beforeEach(() => { db = openDb(":memory:"); });
afterEach(() => { db.sqlite.close(); });

/** A cluster-marking resolver that answers from a literal name -> stage map — mirrors registry.test.ts's
 *  helper. Every registration this file commits targets "s1" at "prod". */
function marked(byName: Record<string, Stage>): ClusterStageResolver {
  return async (cluster: string) => {
    const stage = byName[cluster];
    if (!stage) throw new Error(`no cluster map for "${cluster}"`);
    return { name: cluster, stage };
  };
}
const CLUSTERS = marked({ s1: "prod" });

function entry(over: Partial<TenantRegistration> = {}): TenantRegistration {
  return {
    cluster: "s1", subdomain: SUB,
    members: testMembers([{ name: "erp", seedReference: false, seedDemo: false }]), identityProvider: "auth", apps: [{ name: "erp", seedReference: false, seedDemo: false }],
    seedUsers: false, quota: TEST_QUOTA, resetNonce: "1", suspended: false, quiesced: false,
    ...over,
  };
}

/** The INVENTORIED target (a tenants row exists); `tenantId: null` makes it the ORPHAN twin. */
function target(over: Partial<TenantTeardownTarget> = {}): TenantTeardownTarget {
  return TenantTeardownTargetSchema.parse({
    guid: GUID, subdomain: SUB, stage: "prod", clusterId: "cls_1", cluster: "s1",
    tenantId: "tnt_1", watchNames: WATCH, members: MEMBERS, ...over,
  });
}

/** A teardown flavour that is NOT the replace one — proves the builder is genuinely parameterised
 *  (its own step-name prefix, its own wording) and not the replace steps with a knob bolted on. Like the two
 *  pointer-only flavours in the product it settles its rows to "offboarded": it deletes no cluster state,
 *  so the tenant is un-deployed and everything it IS still stands. */
const REAP: TenantTeardownOpts = {
  stepPrefix: "reap",
  prune: "fail-soft",
  wording: { title: "Reap", removing: "reaping orphaned tenant", settled: "reaped tenant" },
  settledStatus: "offboarded",
};

/** The SAME flavour with the OTHER terminal status — the shape tenant-purge composes
 *. A synthetic pair is what proves the builder READS `settledStatus` rather than
 *  hard-coding either literal, which is exactly the defect that made a completed purge indistinguishable
 *  from an offboard. */
const REAP_PURGED: TenantTeardownOpts = { ...REAP, settledStatus: "purged" };

type FakeKube = { argo?: FakeMasterArgoReader; projects?: FakeMasterProjectWriter; cluster?: FakeClusterReader };

function ports(reg: TenantRegistry, over: FakeKube & { buildRbac?: FakeBuildRbacWriter } = {}): TenantLifecyclePorts {
  return {
    registry: reg,
    buildRbac: over.buildRbac ?? new FakeBuildRbacWriter(),
    resolver: new FakeClusterKubeResolver({
      clusterReader: over.cluster ?? new FakeClusterReader({ deployState: { domain: "s1.example", stage: "prod", writtenAt: "x", generation: 1 } }),
      argoReader: over.argo ?? new FakeMasterArgoReader(),
      projectWriter: over.projects ?? new FakeMasterProjectWriter(),
      argoNamespace: ARGO_NS,
    }),
    catalogRepoUrl: DEPLOY_REPO,
    argoWatchTimeoutMs: 1000,
    resolveUnitApex: async () => "example.com",
  };
}

function ctx(stepName: string, logs: string[]): StepCtx {
  return {
    runId: "run_td", stepName, db: db.db, creds: {} as unknown as CredentialStore, params: {},
    secrets: { get: () => undefined, wipe: () => undefined }, signal: new AbortController().signal, logger: {} as unknown as Logger,
    ssh: () => Promise.reject(new Error("no ssh")), openPasswordSession: () => Promise.reject(new Error("no ssh")),
    closePasswordSession: () => undefined, attest: () => Promise.reject(new Error("no attest")),
    log: (_s, t) => logs.push(t), checkpoint: () => undefined, readCheckpoint: () => undefined, registerCleanup: () => undefined,
  };
}

function seedTenantRow(): void {
  db.db.insert(servers).values({ id: "srv_1", name: "s1", host: "10.1.1.11", sshUser: "root", role: "slave", status: "healthy" }).run();
  db.db.insert(clusters).values({ id: "cls_1", serverId: "srv_1", stage: "prod", domain: "s1.example", status: "active" }).run();
  db.db.insert(tenants).values({ id: "tnt_1", clusterId: "cls_1", guid: GUID, subdomain: SUB, stage: "prod", members: ["auth", "jobs", "report"], identityProvider: "auth", status: "active" }).run();
  db.db.insert(tenantApps).values({ id: "tna_erp", tenantId: "tnt_1", name: "erp", status: "active" }).run();
}

/** The teardown step of a given suffix, e.g. "watch-prune" — resolved by its FULL prefixed name. */
function step(steps: Step[], opts: TenantTeardownOpts, suffix: string): Step {
  const name = `${opts.stepPrefix}-${GUID}-${suffix}`;
  const found = steps.find((s) => s.name === name);
  if (!found) throw new Error(`no step ${name} in ${steps.map((s) => s.name).join(", ")}`);
  return found;
}

/** Script the fan-out as still LIVE (Synced/Healthy) so allPruned fails — the "not pruned" case. */
function lingeringArgo(): FakeMasterArgoReader {
  const m = new Map<string, ArgoAppStatus>();
  for (const n of WATCH) m.set(n, { syncRevision: SHA, targetRevision: null, sync: "Synced", health: "Healthy" });
  return new FakeMasterArgoReader({ statuses: m });
}

/** Run the steps in order, the way the executor does: the first throw ends the run. */
async function runUntilThrow(steps: Step[], logs: string[]): Promise<void> {
  for (const s of steps) await s.run(ctx(s.name, logs));
}

describe("tenantTeardownSteps — the step-name prefix", () => {
  it("names every step <stepPrefix>-<guid>-<suffix>, so two teardowns in ONE run cannot collide", () => {
    const prt = ports(new TenantRegistry(new FakePlatformRepo(), CLUSTERS));
    const other = "e2e8ymj86dk8";
    const names = [
      ...tenantTeardownSteps(prt, target(), REPLACE_TEARDOWN, []),
      ...tenantTeardownSteps(prt, target({ guid: other, tenantId: null }), REPLACE_TEARDOWN, []),
    ].map((s) => s.name);
    // The guid is appended by the BUILDER (never left to the caller), so the same flavour applied to
    // two tenants still yields eight distinct names — the executor keys step impls by name.
    expect(names).toEqual([
      `replace-${GUID}-remove`, `replace-${GUID}-watch-prune`, `replace-${GUID}-delete-projects`, `replace-${GUID}-record`,
      `replace-${other}-remove`, `replace-${other}-watch-prune`, `replace-${other}-delete-projects`, `replace-${other}-record`,
    ]);
    expect(new Set(names).size).toBe(names.length);
  });

  it("a different flavour yields a different prefix over the same suffixes — plus the fail-soft settle guard", () => {
    // REAP is fail-soft, so it carries the one extra step the loud flavours do not: the settle guard that
    // re-reads the fan-out after the cascade, because only a fail-soft run can reach the record step with
    // its prune unproven.
    const steps = tenantTeardownSteps(ports(new TenantRegistry(new FakePlatformRepo(), CLUSTERS)), target(), REAP, []);
    expect(steps.map((s) => s.name)).toEqual([
      `reap-${GUID}-remove`, `reap-${GUID}-watch-prune`, `reap-${GUID}-delete-projects`, `reap-${GUID}-verify-prune`, `reap-${GUID}-record`,
    ]);
  });
});

describe("tenantTeardownSteps — the relocation mark", () => {
  // Every member chart renders its OWN ServiceClaim, so a tenant's member databases hang off the same
  // claim cascade a consumer's do. A tenant-migrate marks every member namespace at repoint, and an
  // abandoned move leaves those marks standing — after which the service-provisioner KEEPS the member
  // databases of any later teardown. The pointer removal is what sets the prune off, so the marks have
  // to be gone before it commits, on EVERY member the frozen target names.
  const MARK = "platform.hostyour.cloud/relocating";
  function markedCluster(): FakeClusterReader {
    const c = new FakeClusterReader({ deployState: { domain: "s1.example", stage: "prod", writtenAt: "x", generation: 1 } });
    for (const m of MEMBERS) c.namespaceAnnotations.set(`${GUID}-${m}`, { [MARK]: "true" });
    return c;
  }
  it("the remove step clears the mark on every member namespace BEFORE it removes the pointer", async () => {
    const cluster = markedCluster();
    const reg = new TenantRegistry(new FakePlatformRepo(), CLUSTERS);
    await reg.commitTenant({ stage: "prod", guid: GUID, registration: entry(), runId: "run_onb" });
    const logs: string[] = [];
    await step(tenantTeardownSteps(ports(reg, { cluster }), target(), REAP, []), REAP, "remove").run(ctx("remove", logs));
    expect(MEMBERS.every((m) => cluster.namespaceAnnotations.get(`${GUID}-${m}`)?.[MARK] === undefined)).toBe(true);
    expect(logs.findIndex((l) => l.includes(`${MARK} cleared`))).toBeLessThan(logs.findIndex((l) => l.includes("pointer removed")));
  });

  it("clears the mark even when the pointer is already gone — a purge reaps that tenant's namespaces too", async () => {
    const cluster = markedCluster();
    const reg = new TenantRegistry(new FakePlatformRepo(), CLUSTERS); // no tenant.yaml committed
    const logs: string[] = [];
    await step(tenantTeardownSteps(ports(reg, { cluster }), target(), REAP, []), REAP, "remove").run(ctx("remove", logs));
    expect(MEMBERS.every((m) => cluster.namespaceAnnotations.get(`${GUID}-${m}`)?.[MARK] === undefined)).toBe(true);
    expect(logs.some((l) => l.includes("pointer already removed"))).toBe(true);
  });
});

describe("tenantTeardownSteps — the cascade and the record step's place", () => {
  /** Two cluster-side deletes standing in for tenant-purge's (Tenant CR + namespace): the first fails
   *  the way an RBAC-refused or transiently-broken delete does, so the record step behind it must never
   *  run. `ran` records what actually executed. */
  function cascade(ran: string[], fail?: string): Step[] {
    return ["delete-namespaces", "delete-tenant-crypto"].map((name) => ({
      name,
      title: `cascade ${name}`,
      run: () => {
        ran.push(name);
        return name === fail ? Promise.reject(new Error(`${name} forbidden`)) : Promise.resolve();
      },
    }));
  }

  it("places the cascade BETWEEN delete-projects and record, so the row flip is the LAST step", () => {
    const steps = tenantTeardownSteps(ports(new TenantRegistry(new FakePlatformRepo(), CLUSTERS)), target(), REAP, cascade([]));
    expect(steps.map((s) => s.name)).toEqual([
      `reap-${GUID}-remove`, `reap-${GUID}-watch-prune`, `reap-${GUID}-delete-projects`,
      "delete-namespaces", "delete-tenant-crypto",
      `reap-${GUID}-verify-prune`, // the settle guard reads the fan-out AFTER the cascade had its go
      `reap-${GUID}-record`,
    ]);
  });

  it("a FAILING cascade step leaves the rows untouched — no row may claim offboarded while cluster state survives", async () => {
    // The defect this ordering exists to prevent: with the record step ahead of the deletes, a
    // cascade step that fails — a namespace delete the per-cluster credential may not issue, a Vault
    // metadata delete answering 403 — settled the tenant in the inventory anyway. An offboarded row is
    // filtered out of the Tenants list, has no action on its detail page, and cannot be found by the
    // orphan scan either, because the FIRST teardown step already git-rm'd its pointer. The tenant would
    // still be running, with nothing in the product able to name it again.
    seedTenantRow();
    const reg = new TenantRegistry(new FakePlatformRepo(), CLUSTERS);
    await reg.commitTenant({ stage: "prod", guid: GUID, registration: entry(), runId: "run_onb" });
    const ran: string[] = [];
    const steps = tenantTeardownSteps(ports(reg), target(), REAP, cascade(ran, "delete-namespaces"));

    const logs: string[] = [];
    await expect(runUntilThrow(steps, logs)).rejects.toThrow(/delete-namespaces forbidden/);

    expect(ran).toEqual(["delete-namespaces"]); // the run stops AT the failed delete
    expect(db.db.select().from(tenants).where(eq(tenants.id, "tnt_1")).get()?.status).toBe("active");
    expect(db.db.select().from(tenantApps).where(eq(tenantApps.id, "tna_erp")).get()?.status).toBe("active");
  });
});

describe("tenantTeardownSteps — the prune policy", () => {
  it("fail-loud THROWS when the fan-out still stands (the replace must not deploy onto a served FQDN)", async () => {
    const steps = tenantTeardownSteps(ports(new TenantRegistry(new FakePlatformRepo(), CLUSTERS), { argo: lingeringArgo() }), target(), REPLACE_TEARDOWN, []);
    await expect(step(steps, REPLACE_TEARDOWN, "watch-prune").run(ctx("watch-prune", []))).rejects.toThrow(/fan-out was not pruned/);
  });

  it("fail-soft OBSERVES the same lingering fan-out and continues (an orphan never prunes cleanly)", async () => {
    const logs: string[] = [];
    const steps = tenantTeardownSteps(ports(new TenantRegistry(new FakePlatformRepo(), CLUSTERS), { argo: lingeringArgo() }), target(), REAP, []);
    await step(steps, REAP, "watch-prune").run(ctx("watch-prune", logs)); // must NOT throw
    expect(logs.some((l) => l.includes("fan-out was not pruned") && l.includes("continuing"))).toBe(true);
  });

  it("fail-loud propagates a watch READ failure; fail-soft records it and continues", async () => {
    const argo = new FakeMasterArgoReader({ throwOnSet: new Error("argocd unreachable") });
    const loud = tenantTeardownSteps(ports(new TenantRegistry(new FakePlatformRepo(), CLUSTERS), { argo }), target(), REPLACE_TEARDOWN, []);
    await expect(step(loud, REPLACE_TEARDOWN, "watch-prune").run(ctx("watch-prune", []))).rejects.toThrow(/argocd unreachable/);

    const logs: string[] = [];
    const soft = tenantTeardownSteps(ports(new TenantRegistry(new FakePlatformRepo(), CLUSTERS), { argo }), target(), REAP, []);
    await step(soft, REAP, "watch-prune").run(ctx("watch-prune", logs));
    expect(logs.some((l) => l.includes("could not confirm the fan-out prune") && l.includes("argocd unreachable"))).toBe(true);
  });

  it("fail-loud REFUSES an EMPTY watch set — a set nothing proved empty is not a prune", async () => {
    // allPruned([]) is vacuously true for ANY status map, so an empty set would sail through as "fan-out
    // pruned (0 Application(s))" and let the run delete the isolation AppProject while live Applications
    // still reference it — and, for the replace, deploy a fresh guid onto the public FQDN the old
    // fan-out is still serving. Every fail-loud target legitimately carries at least base + auth, so an
    // empty set means the resolution proved nothing.
    const steps = tenantTeardownSteps(ports(new TenantRegistry(new FakePlatformRepo(), CLUSTERS)), target({ watchNames: [] }), REPLACE_TEARDOWN, []);
    await expect(step(steps, REPLACE_TEARDOWN, "watch-prune").run(ctx("watch-prune", []))).rejects.toThrow(/EMPTY fan-out watch set/);
  });

  it("fail-soft still accepts an empty watch set — its cluster-side deletes are the backstop", async () => {
    // The purge flavour reaps the Tenant CR + namespace by guid afterwards, so it must NOT stall on a
    // tenant whose fan-out cannot be named at all (a create-tenant that died before write-registration).
    const logs: string[] = [];
    const steps = tenantTeardownSteps(ports(new TenantRegistry(new FakePlatformRepo(), CLUSTERS)), target({ watchNames: [] }), REAP, []);
    await step(steps, REAP, "watch-prune").run(ctx("watch-prune", logs));
    expect(logs.some((l) => l.includes("fan-out pruned (0 Application(s))"))).toBe(true);
  });

  it("both policies pass a fan-out that IS pruned (every expected name reads Missing)", async () => {
    for (const opts of [REPLACE_TEARDOWN, REAP]) {
      const logs: string[] = [];
      const steps = tenantTeardownSteps(ports(new TenantRegistry(new FakePlatformRepo(), CLUSTERS)), target(), opts, []);
      await step(steps, opts, "watch-prune").run(ctx("watch-prune", logs));
      expect(logs.some((l) => l.includes(`fan-out pruned (${WATCH.length} Application(s))`))).toBe(true);
    }
  });
});

// The SETTLE GUARD (fail-soft only): the step between the cascade and the record step that re-reads the
// fan-out and refuses to let a row be settled over workloads it can still see. Fail-soft is about whether
// the run PROCEEDS past an unpruned fan-out — never about what it RECORDS.
describe("tenantTeardownSteps — the settle guard", () => {
  it("fail-soft REFUSES TO SETTLE what it could not prune — the guard, not the watch, is what fails the run", async () => {
    // The defect this guard closes: fail-soft made the WHOLE run soft. A watch that timed out with the
    // fan-out still standing logged "continuing", the cascade ran, the record step flipped the rows to
    // offboarded and the run ended SUCCEEDED — a settled row over live workloads, which is the exact
    // settled-but-unfinished state (an offboarded row is filtered out of the Tenants list, has
    // no action on its detail page, and the orphan scan cannot see it because the first step git-rm'd its
    // pointer). Fail-soft must keep the run GOING (its cluster-side deletes are the backstop) and still
    // refuse to RECORD: the guard throws before the flip, so the row is untouched and the failed run is
    // retryable from this very step.
    seedTenantRow();
    const reg = new TenantRegistry(new FakePlatformRepo(), CLUSTERS);
    await reg.commitTenant({ stage: "prod", guid: GUID, registration: entry(), runId: "run_onb" });
    const steps = tenantTeardownSteps(ports(reg, { argo: lingeringArgo() }), target(), REAP, []);

    const logs: string[] = [];
    await expect(runUntilThrow(steps, logs)).rejects.toThrow(/fan-out is STILL not pruned after the cluster-side deletes/);
    // Everything reapable was still reaped — the watch itself stayed soft and let the run get this far.
    expect(logs.some((l) => l.includes("fan-out was not pruned") && l.includes("continuing"))).toBe(true);
    expect(await reg.readTenant("prod", GUID)).toBeNull(); // the pointer went
    // and the rows are exactly as they were, so the tenant stays visible and purgeable.
    expect(db.db.select().from(tenants).where(eq(tenants.id, "tnt_1")).get()?.status).toBe("active");
    expect(db.db.select().from(tenantApps).where(eq(tenantApps.id, "tna_erp")).get()?.status).toBe("active");
  });

  it("fail-soft refuses to settle on an UNREADABLE ArgoCD too — an unproven prune is not a prune", async () => {
    // The watch above tolerates a read failure (ArgoCD unreachable) so the cluster-side deletes still
    // fire. The guard cannot: "could not confirm" is not "gone", and a row that settles on it lies just
    // as loudly as one that settles over a lingering fan-out.
    seedTenantRow();
    const steps = tenantTeardownSteps(
      ports(new TenantRegistry(new FakePlatformRepo(), CLUSTERS), { argo: new FakeMasterArgoReader({ throwOnSet: new Error("argocd unreachable") }) }),
      target(), REAP, [],
    );
    await expect(runUntilThrow(steps, [])).rejects.toThrow(/could not confirm the fan-out of reaped tenant .* is gone \(argocd unreachable\)/);
    expect(db.db.select().from(tenants).where(eq(tenants.id, "tnt_1")).get()?.status).toBe("active");
  });

  it("the guard passes once the fan-out IS gone — the second look is what the cascade earns", async () => {
    // Not a repeat of the watch: it runs AFTER the composing run's cascade (for tenant-purge the Tenant CR
    // delete + the namespace backstop reap), which is precisely what can turn a lingering fan-out into a
    // gone one — so a purge that had to force the reap still settles its row and still ends SUCCEEDED.
    seedTenantRow();
    const logs: string[] = [];
    const steps = tenantTeardownSteps(ports(new TenantRegistry(new FakePlatformRepo(), CLUSTERS)), target(), REAP, []);
    await runUntilThrow(steps, logs);
    expect(logs.some((l) => l.includes(`fan-out confirmed gone (${WATCH.length} Application(s))`))).toBe(true);
    expect(db.db.select().from(tenants).where(eq(tenants.id, "tnt_1")).get()?.status).toBe("offboarded");
  });

  it("an EMPTY watch set makes the guard a no-op — there is no fan-out to prove gone", async () => {
    // The "neither source knows this guid" purge (a create-tenant that died before write-registration):
    // its cluster footprint is reaped by guid and nothing names an Application, so the guard must not
    // invent a read — nor block the settle over a set that was empty by design.
    seedTenantRow();
    const logs: string[] = [];
    const steps = tenantTeardownSteps(ports(new TenantRegistry(new FakePlatformRepo(), CLUSTERS), { argo: lingeringArgo() }), target({ watchNames: [] }), REAP, []);
    await runUntilThrow(steps, logs);
    expect(logs.some((l) => l.includes("named no fan-out Application — nothing to verify"))).toBe(true);
    expect(db.db.select().from(tenants).where(eq(tenants.id, "tnt_1")).get()?.status).toBe("offboarded");
  });

  it("the pointer-only REPLACE flavour settles 'offboarded' — it deletes no cluster state, so purge is still its verb", () => {
    // The replace un-deploys the same-subdomain tenant it displaces and keeps everything that tenant IS
    // (namespace, Tenant CR, Vault path, object-storage credential, Mongo databases). Recording it "purged"
    // would tell the operator a deprovision happened that did not, and would drop the row off the Tenants
    // page — taking with it the one verb that could still reap what the replace deliberately left standing.
    expect(REPLACE_TEARDOWN.settledStatus).toBe("offboarded");
  });

  it("the LOUD flavours have no guard at all — their watch already proved it, and a second read is pure cost", () => {
    // create-tenant's replace + abort teardowns pay nothing for this: reaching their record step is itself
    // the proof, since their watch THREW on a fan-out that did not prune.
    const steps = tenantTeardownSteps(ports(new TenantRegistry(new FakePlatformRepo(), CLUSTERS)), target(), REPLACE_TEARDOWN, []);
    expect(steps.map((s) => s.name)).not.toContain(`replace-${GUID}-verify-prune`);
  });
});

describe("tenantTeardownSteps — the wording", () => {
  it("renders the flavour into every step title and into the run log", async () => {
    seedTenantRow();
    const reg = new TenantRegistry(new FakePlatformRepo(), CLUSTERS);
    await reg.commitTenant({ stage: "prod", guid: GUID, registration: entry(), runId: "run_onb" });
    const steps = tenantTeardownSteps(ports(reg), target(), REAP, []);
    expect(steps.map((s) => s.title)).toEqual([
      `Reap ${GUID}: remove its pointer (GitOps un-deploy)`,
      `Reap ${GUID}: wait for ArgoCD to prune its fan-out`,
      `Reap ${GUID}: delete every member's isolation AppProject, admission policy and the argo-sync grant`,
      `Reap ${GUID}: verify its fan-out is gone before settling the row`,
      `Reap ${GUID}: record it offboarded`,
    ]);
    const logs: string[] = [];
    await step(steps, REAP, "remove").run(ctx("remove", logs));
    // `removing` names the tenant WHILE the pointer goes; `settled` names it in every later message.
    expect(logs.some((l) => l.includes(`reaping orphaned tenant ${GUID} (subdomain "${SUB}")`))).toBe(true);
    await step(steps, REAP, "record").run(ctx("record", logs));
    expect(logs.some((l) => l.includes(`reaped tenant ${GUID} recorded as offboarded`))).toBe(true);
  });
});

describe("tenantTeardownSteps — a full non-replace teardown", () => {
  it("removes the registration, deletes EVERY member AppProject and flips the rows offboarded (kept)", async () => {
    seedTenantRow();
    const reg = new TenantRegistry(new FakePlatformRepo(), CLUSTERS);
    await reg.commitTenant({ stage: "prod", guid: GUID, registration: entry(), runId: "run_onb" });
    const projects = new FakeMasterProjectWriter();
    for (const member of MEMBERS) {
      await projects.applyAppProject(ARGO_NS, renderTenantAppProject({ guid: GUID, member, argoNamespace: ARGO_NS, catalogRepoUrl: DEPLOY_REPO, platformRepoURL: PLATFORM_REPO, cluster: "s1" }));
    }
    for (const member of MEMBERS) expect(projects.get(ARGO_NS, memberAppProject(GUID, member))).toBeDefined();

    const logs: string[] = [];
    for (const s of tenantTeardownSteps(ports(reg, { projects }), target(), REAP, [])) await s.run(ctx(s.name, logs));

    expect(await reg.readTenant("prod", GUID)).toBeNull(); // registration git-rm'd
    // ALL of them — a project the teardown could not name would outlive the tenant it fenced.
    for (const member of MEMBERS) expect(projects.get(ARGO_NS, memberAppProject(GUID, member))).toBeUndefined();
    const row = db.db.select().from(tenants).where(eq(tenants.id, "tnt_1")).get();
    expect(row?.status).toBe("offboarded"); // soft state — the row is KEPT
    expect(row?.lastRunId).toBe("run_td");
    expect(db.db.select().from(tenantApps).where(eq(tenantApps.id, "tna_erp")).get()?.status).toBe("offboarded");
  });

  it("deletes the tenant's argo-sync grant beside its AppProjects — no Role naming this guid's Applications outlives it", async () => {
    seedTenantRow();
    const reg = new TenantRegistry(new FakePlatformRepo(), CLUSTERS);
    await reg.commitTenant({ stage: "prod", guid: GUID, registration: entry(), runId: "run_onb" });
    const buildRbac = new FakeBuildRbacWriter();
    await buildRbac.applyBuildRbac([renderTenantArgoSync({ guid: GUID, applications: WATCH, argoNamespace: ARGO_NS, units: ["example-platform"] })]);
    expect(buildRbac.keys()).toEqual([`Role ${ARGO_NS}/${GUID}-argo-sync`, `RoleBinding ${ARGO_NS}/${GUID}-argo-sync`]);

    const logs: string[] = [];
    for (const s of tenantTeardownSteps(ports(reg, { buildRbac }), target(), REAP, [])) await s.run(ctx(s.name, logs));

    expect(buildRbac.keys()).toEqual([]); // Role AND Binding — a Role without its Binding grants nothing, but it is still a leftover
    expect(logs.some((l) => l.includes("argo-sync grant deleted"))).toBe(true);
  });

  it("settles the rows to the FLAVOUR's terminal status — a purge records 'purged', not 'offboarded'", async () => {
    // THE regression at the one place the status is written. Both flavours are the
    // same fail-soft teardown; only `settledStatus` differs, and the rows have to follow it. When the
    // builder hard-coded "offboarded" a finished purge was indistinguishable from an offboard, so a fully
    // deprovisioned tenant stayed on the Tenants page's "Offboarded tenants" panel and went on offering
    // the purge that had just completed — the most destructive verb in the product looking like a no-op.
    seedTenantRow();
    const reg = new TenantRegistry(new FakePlatformRepo(), CLUSTERS);
    await reg.commitTenant({ stage: "prod", guid: GUID, registration: entry(), runId: "run_onb" });
    const steps = tenantTeardownSteps(ports(reg), target(), REAP_PURGED, []);

    // The step SAYS which state it settles, before it does it — the run log is where an operator reads
    // what happened, so a step titled "record it offboarded" on a purge would be the same lie one screen
    // further out.
    expect(step(steps, REAP_PURGED, "record").title).toBe(`Reap ${GUID}: record it purged`);
    const logs: string[] = [];
    for (const s of steps) await s.run(ctx(s.name, logs));

    expect(db.db.select().from(tenants).where(eq(tenants.id, "tnt_1")).get()?.status).toBe("purged");
    expect(db.db.select().from(tenantApps).where(eq(tenantApps.id, "tna_erp")).get()?.status).toBe("purged");
    expect(logs.some((l) => l.includes(`reaped tenant ${GUID} recorded as purged (row kept)`))).toBe(true);
  });

  it("leaves an ALREADY-SETTLED app row exactly as it was — a removal must not restamp what it did not remove", async () => {
    // The record step flips every app row that is not yet SETTLED, asked as the shared set
    // (TENANT_SETTLED_STATUS, shared/enums.ts) rather than as `!== "offboarded"`. The difference shows on
    // the app row settled by the OTHER terminal state: a "purged" row is a deprovision that already
    // happened, and the bare test would have DOWNGRADED it to "offboarded" here — rewriting one removal's
    // record with another's, and restamping it with a run id that deleted nothing.
    seedTenantRow();
    db.db.insert(tenantApps).values({ id: "tna_gone", tenantId: "tnt_1", name: "web", status: "purged", lastRunId: "run_tpurge" }).run();
    const reg = new TenantRegistry(new FakePlatformRepo(), CLUSTERS);
    await reg.commitTenant({ stage: "prod", guid: GUID, registration: entry(), runId: "run_onb" });
    for (const s of tenantTeardownSteps(ports(reg), target(), REAP, [])) await s.run(ctx(s.name, []));

    const gone = db.db.select().from(tenantApps).where(eq(tenantApps.id, "tna_gone")).get();
    expect(gone?.status).toBe("purged");
    expect(gone?.lastRunId).toBe("run_tpurge");
    // ...while the row that was still standing takes THIS teardown's status and run id.
    const erp = db.db.select().from(tenantApps).where(eq(tenantApps.id, "tna_erp")).get();
    expect(erp?.status).toBe("offboarded");
    expect(erp?.lastRunId).toBe("run_td");
  });

  it("REFUSES TO DOWNGRADE a tenant a purge already settled — a teardown that removed nothing may not restamp it", async () => {
    // The downgrade sequence an operator hit end to end, entirely from the UI: a create-tenant
    // failed, the operator purged the tenant it left behind (rows settled "purged", pointer gone,
    // AppProject + Tenant CR + namespace deleted), then went back to the failed run — whose
    // "Abort (cleanup)" was still on offer — and confirmed it. That abort runs THIS builder with
    // settledStatus "offboarded" and tenantId NULL (create-tenant's record-provisional mints the row id at
    // execute time, so no frozen params can carry it), so every step no-ops on a tenant that is already
    // gone... and the record step re-resolved the row by (clusterId, guid) and wrote "offboarded" over
    // "purged", with the create-tenant's run id. The tenant then REAPPEARED on the Tenants page's
    // "Offboarded tenants" panel, advertising the purge that had just run, and its detail page told the
    // operator its namespace, Tenant CR, Vault path, object-storage credential and Mongo databases all
    // still stood — every one of which that purge deleted. The app rows, guarded from the start, stayed
    // "purged", so the row and its own matrix disagreed as well.
    seedTenantRow();
    db.db.update(tenants).set({ status: "purged", lastRunId: "run_tpurge" }).where(eq(tenants.id, "tnt_1")).run();
    db.db.update(tenantApps).set({ status: "purged", lastRunId: "run_tpurge" }).where(eq(tenantApps.id, "tna_erp")).run();

    const logs: string[] = [];
    // The abort's own target shape: no row id, so the record step MUST take the (clusterId, guid)
    // fallback — the path that carried no status filter at all.
    for (const s of tenantTeardownSteps(ports(new TenantRegistry(new FakePlatformRepo(), CLUSTERS)), target({ tenantId: null }), REAP, [])) {
      await s.run(ctx(s.name, logs));
    }

    const row = db.db.select().from(tenants).where(eq(tenants.id, "tnt_1")).get();
    expect(row?.status).toBe("purged"); // NOT downgraded to the flavour's "offboarded"
    expect(row?.lastRunId).toBe("run_tpurge"); // and not restamped with the run id that removed nothing
    expect(db.db.select().from(tenantApps).where(eq(tenantApps.id, "tna_erp")).get()?.status).toBe("purged");
    // The step SAYS it left the row alone. A log line claiming "recorded as offboarded" over a row that
    // kept its "purged" is the same false statement one layer down — the run log is where an operator
    // reads what happened.
    expect(logs.some((l) => l.includes(`reaped tenant ${GUID} is already recorded purged`))).toBe(true);
    expect(logs.some((l) => l.includes("recorded as offboarded"))).toBe(false);
  });

  it("DEEPENS the rows an earlier offboard settled — the purge that follows it deletes what they still claimed", async () => {
    // The other half of the same rule, and the reason the guard is not simply "skip anything settled".
    // The product prescribes offboard FIRST, then purge (the Tenants panel, the offboard dialog and the
    // purge's own live-tenant refusal all say so). The offboard settles every tenant_apps row
    // "offboarded"; on that order the purge then found them all already settled and skipped them, so the
    // tenant read "purged" while every app of its matrix was still badged with the word this codebase
    // defines as "un-deployed, cluster state KEPT" — directly above a bar saying the namespace, the Vault
    // path and the Mongo databases are gone. They ARE gone: the purge's cascade deleted the Tenant CR and
    // the namespace those apps were, so "purged" is the only honest word for them too.
    seedTenantRow();
    db.db.update(tenants).set({ status: "offboarded", lastRunId: "run_off" }).where(eq(tenants.id, "tnt_1")).run();
    db.db.update(tenantApps).set({ status: "offboarded", lastRunId: "run_off" }).where(eq(tenantApps.id, "tna_erp")).run();

    const logs: string[] = [];
    for (const s of tenantTeardownSteps(ports(new TenantRegistry(new FakePlatformRepo(), CLUSTERS)), target(), REAP_PURGED, [])) {
      await s.run(ctx(s.name, logs));
    }

    expect(db.db.select().from(tenants).where(eq(tenants.id, "tnt_1")).get()?.status).toBe("purged");
    const erp = db.db.select().from(tenantApps).where(eq(tenantApps.id, "tna_erp")).get();
    expect(erp?.status).toBe("purged");
    expect(erp?.lastRunId).toBe("run_td"); // the deprovision that actually took it down owns the row now
    expect(logs.some((l) => l.includes(`reaped tenant ${GUID} recorded as purged`))).toBe(true);
  });

  it("tolerates the ORPHAN: no inventory row to flip, the GitOps + cluster footprint still goes", async () => {
    const reg = new TenantRegistry(new FakePlatformRepo(), CLUSTERS); // no seedTenantRow ⇒ nothing in inventory
    await reg.commitTenant({ stage: "prod", guid: GUID, registration: entry(), runId: "run_onb" });
    const logs: string[] = [];
    for (const s of tenantTeardownSteps(ports(reg), target({ tenantId: null }), REAP, [])) await s.run(ctx(s.name, logs));

    expect(await reg.readTenant("prod", GUID)).toBeNull();
    expect(logs.some((l) => l.includes(`reaped tenant ${GUID} had no inventory row`))).toBe(true);
  });

  it("is re-runnable: a second pass skips the already-removed pointer instead of throwing", async () => {
    const reg = new TenantRegistry(new FakePlatformRepo(), CLUSTERS); // pointer never committed ⇒ already absent
    const logs: string[] = [];
    for (const s of tenantTeardownSteps(ports(reg), target({ tenantId: null }), REAP, [])) await s.run(ctx(s.name, logs));
    expect(logs.some((l) => l.includes("pointer already removed") && l.includes("resume"))).toBe(true);
  });

  it("removes a tenant whose registration is CORRUPT — only ABSENT skips, never unreadable", async () => {
    // The removal is BY PATH, so a corrupt registration body is irrelevant to it — and that tenant is
    // exactly the one an operator is purging. Reading it with the strict fold would throw here (in the
    // step AND inside removeTenant), leaving the broken tenant deployed forever; the tolerant scan
    // reports "unreadable", which is NOT "absent" and so still git-rm's.
    const repo = new FakePlatformRepo();
    const reg = new TenantRegistry(repo, CLUSTERS);
    await reg.commitTenant({ stage: "prod", guid: GUID, registration: entry(), runId: "run_onb" });
    repo.seed(repo.booksBranch, `registrations/${GUID}/prod.yaml`, 'cluster: "s1"\nsubdomain: 7\n'); // subdomain must be a string
    const logs: string[] = [];
    await step(tenantTeardownSteps(ports(reg), target({ tenantId: null }), REAP, []), REAP, "remove").run(ctx("remove", logs));
    expect(repo.commits.at(-1)?.remove).toEqual([`registrations/${GUID}/prod.yaml`]);
    expect(logs.some((l) => l.includes(`reaping orphaned tenant ${GUID}`))).toBe(true);
    expect(await reg.readTenant("prod", GUID)).toBeNull(); // nothing of the tenant is left to fold
  });
});
