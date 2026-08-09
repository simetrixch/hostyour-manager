import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { seedQuota } from "../../../shared/unit-size.ts";
import { openDb, type DbHandle } from "../../db/client.ts";
import { servers, clusters, tenants } from "../../db/schema/inventory.ts";
import { FakePlatformRepo } from "../../adapters/git/testing/fake.ts";
import { TenantRegistry } from "./tenant-registry.ts";
import type { ClusterStageResolver } from "./registry.ts";
import { scanOrphanTenants, resolveRunTenantState, CreateTenantPurgeTarget } from "./tenant-orphans.ts";
import type { TenantRegistration } from "../../../shared/tenant.ts";
import type { Stage } from "../../../shared/enums.ts";
import { testMembers } from "./tenant-members.fixture.ts";

// The DISCOVERY half of surfacing unrecorded tenants: what makes one nameable at all. The
// load-bearing property throughout is the DIFF — inventory vs the live GitOps pointers — plus the
// honesty of what the diff yields (an unresolvable slave must surface as clusterId null, never as a
// silently dropped row: dropping it would hide the very leftover the operator went looking for).

const SHA = "a".repeat(40);
const GUID = "zsjs023ctne0"; // the RECORDED tenant (a tenants row + a live pointer)
const ORPHAN = "e2e8ymj86dk8"; // a live pointer with no row
const STRANDED = "hp5t8m2wq3xn"; // a live pointer whose slave is not a registered cluster
const BROKEN = "kx4v7n2q9r3s"; // a pointer dir whose registration the scan cannot read

/** A cluster-marking resolver that answers from a literal name -> stage map — mirrors registry.test.ts's
 *  helper. A cluster is marked exactly ONE stage, so a stage-specific fixture gets its own short name
 *  (s1dev, next to s1) rather than reusing s1 at two stages. */
function marked(byName: Record<string, Stage>): ClusterStageResolver {
  return async (cluster: string) => {
    const stage = byName[cluster];
    if (!stage) throw new Error(`no cluster map for "${cluster}"`);
    return { name: cluster, stage };
  };
}
const CLUSTERS = marked({ s1: "prod", s9: "prod", s1dev: "dev" });

/** guid + stage + the registration body — the write-time triple TenantRegistry.commitTenant now takes
 *  (the guid is the DIRECTORY and the stage the FILE NAME, so neither lives in the body). */
interface TenantFixture {
  guid: string;
  stage: Stage;
  registration: TenantRegistration;
}

function entry(guid: string, subdomain: string, over: Partial<TenantRegistration> & { stage?: Stage } = {}): TenantFixture {
  const { stage, ...registrationOver } = over;
  return {
    guid,
    stage: stage ?? "prod",
    registration: {
      cluster: "s1",
      members: testMembers([{ name: "erp", seedReference: false, seedDemo: false }]),
      identityProvider: "auth",
      subdomain,
      apps: [{ name: "erp", seedReference: false, seedDemo: false }],
      seedUsers: false, quota: seedQuota("small"),
      resetNonce: "1",
      suspended: false,
      quiesced: false,
      ...registrationOver,
    },
  };
}

let db: DbHandle;
beforeEach(() => {
  db = openDb(":memory:");
  // ONE registered slave cluster, reachable under the short name "s1" — clusterShortName of its
  // own domain, the only place that name ever comes from.
  db.db.insert(servers).values({ id: "srv_1", name: "s1", host: "10.1.1.11", sshUser: "root", role: "slave", status: "healthy" }).run();
  db.db.insert(clusters).values({ id: "cls_1", serverId: "srv_1", stage: "prod", domain: "s1.example", status: "active" }).run();
});
afterEach(() => db.sqlite.close());

/** A registry whose fake catalog carries the given tenants as live pointers. */
async function deployed(...entries: TenantFixture[]): Promise<TenantRegistry> {
  const registry = new TenantRegistry(new FakePlatformRepo(), CLUSTERS);
  let n = 0;
  for (const e of entries) await registry.commitTenant({ stage: e.stage, guid: e.guid, registration: e.registration, runId: `run_${++n}` });
  return registry;
}

/** The same, plus RAW bytes seeded straight into the fake repo — how a pointer the scan CANNOT read
 *  gets there: no writer of ours would produce one, but a hand-written or drifted file in catalog
 *  is exactly the case this discovery has to stay honest about. */
async function deployedWithRaw(raw: Record<string, string>, ...entries: TenantFixture[]): Promise<TenantRegistry> {
  const repo = new FakePlatformRepo();
  const registry = new TenantRegistry(repo, CLUSTERS);
  let n = 0;
  for (const e of entries) await registry.commitTenant({ stage: e.stage, guid: e.guid, registration: e.registration, runId: `run_${++n}` });
  for (const [path, content] of Object.entries(raw)) repo.seed(repo.booksBranch, path, content);
  return registry;
}

describe("scanOrphanTenants (the pointer-vs-inventory diff)", () => {
  it("returns only the pointers inventory does not know, resolved to their cluster row", async () => {
    db.db.insert(tenants).values({ id: "tnt_1", clusterId: "cls_1", guid: GUID, subdomain: "acme.example", stage: "prod", members: ["auth", "jobs", "report"], identityProvider: "auth", provenance: "controller", status: "active" }).run();
    const registry = await deployed(entry(GUID, "acme.example"), entry(ORPHAN, "ghost.example"));
    expect(await scanOrphanTenants({ db: db.db, registry })).toEqual({
      orphans: [{ guid: ORPHAN, subdomain: "ghost.example", stage: "prod", cluster: "s1", clusterId: "cls_1" }],
      skipped: [],
    });
  });

  it("finds nothing when every deployed pointer has a row, and nothing when nothing is deployed", async () => {
    db.db.insert(tenants).values({ id: "tnt_1", clusterId: "cls_1", guid: GUID, subdomain: "acme.example", stage: "prod", members: ["auth", "jobs", "report"], identityProvider: "auth", provenance: "controller", status: "active" }).run();
    expect(await scanOrphanTenants({ db: db.db, registry: await deployed(entry(GUID, "acme.example")) })).toEqual({ orphans: [], skipped: [] });
    expect(await scanOrphanTenants({ db: db.db, registry: await deployed() })).toEqual({ orphans: [], skipped: [] });
  });

  it("treats an OFFBOARDED row as absent — a live pointer beside it is leftover state, not a healthy tenant", async () => {
    // The row is kept for audit; the pointer should have gone with the offboard. Same rule as
    // resolveTeardownTarget (tenant-replace.ts), so the two can never disagree about what an orphan is.
    db.db.insert(tenants).values({ id: "tnt_1", clusterId: "cls_1", guid: GUID, subdomain: "acme.example", stage: "prod", members: ["auth", "jobs", "report"], identityProvider: "auth", provenance: "controller", status: "offboarded" }).run();
    const found = await scanOrphanTenants({ db: db.db, registry: await deployed(entry(GUID, "acme.example")) });
    expect(found.orphans.map((o) => o.guid)).toEqual([GUID]);
  });

  it("treats a PURGED row as absent too — a pointer that outlived a deprovision is the loudest leftover there is", async () => {
    // The same rule as the offboarded case above, and it has to hold for the later-added "purged" state
    // or the scan silently loses its most important find: a purge deletes the Tenant CR, the
    // namespace, the Vault path and the Mongo databases, so a tenant registration still standing beside a
    // "purged" row is GitOps pointing at a tenant that no longer exists — and reading that row as "known"
    // would hide it from the only surface that can see it (every removal git-rm's the pointer first, so
    // nothing else looks). Written as the shared TENANT_SETTLED_STATUS set, never `!== "offboarded"`.
    db.db.insert(tenants).values({ id: "tnt_1", clusterId: "cls_1", guid: GUID, subdomain: "acme.example", stage: "prod", members: ["auth", "jobs", "report"], identityProvider: "auth", provenance: "controller", status: "purged" }).run();
    const found = await scanOrphanTenants({ db: db.db, registry: await deployed(entry(GUID, "acme.example")) });
    expect(found.orphans.map((o) => o.guid)).toEqual([GUID]);
  });

  it("is stage-scoped on BOTH sides: a row at another stage never covers a pointer at this one", async () => {
    // The same guid recorded at dev must not mask the prod pointer — guid+stage is the identity the
    // pointer path itself is keyed on (registrations/<guid>/<stage>.yaml).
    db.db.insert(tenants).values({ id: "tnt_1", clusterId: "cls_1", guid: GUID, subdomain: "acme.example", stage: "dev", members: ["auth", "jobs", "report"], identityProvider: "auth", provenance: "controller", status: "active" }).run();
    const found = await scanOrphanTenants({ db: db.db, registry: await deployed(entry(GUID, "acme.example")) });
    expect(found.orphans).toEqual([{ guid: GUID, subdomain: "acme.example", stage: "prod", cluster: "s1", clusterId: "cls_1" }]);
  });

  it("scans every stage in one pass — an orphan is found wherever it was left", async () => {
    const registry = await deployed(entry(ORPHAN, "ghost.example"), entry(GUID, "dev-ghost.example", { stage: "dev", cluster: "s1dev" }));
    const found = await scanOrphanTenants({ db: db.db, registry });
    // dev has no registered cluster here, so that one is reported unaimable — but it IS reported.
    expect(found.orphans.map((o) => `${o.stage}/${o.guid}`).sort()).toEqual(["dev/" + GUID, "prod/" + ORPHAN].sort());
  });

  it("reports an orphan whose slave is not a registered cluster with clusterId null instead of dropping it", async () => {
    // A purge is keyed on a clusterId, so this one cannot be aimed from here — but hiding it would hide
    // exactly the leftover the operator is scanning for. The UI says why it offers no action.
    const registry = await deployed(entry(STRANDED, "stranded.example", { cluster: "s9" }));
    expect(await scanOrphanTenants({ db: db.db, registry })).toEqual({
      orphans: [{ guid: STRANDED, subdomain: "stranded.example", stage: "prod", cluster: "s9", clusterId: null }],
      skipped: [],
    });
  });

  it("reports a pointer it could NOT read instead of dropping it — an empty list must mean 'checked'", async () => {
    // Skipping a broken pointer keeps the scan alive (one drifted registration wedges nothing), but
    // swallowing it makes the UI say "every deployed tenant pointer has a matching inventory row" for a
    // tenant nobody can see — and the operator can never act on it, because the purge dialog only offers
    // a guid something HANDED them. The directory guid + the reason are what make it actionable.
    const registry = await deployedWithRaw({ [`registrations/${BROKEN}/prod.yaml`]: "subdomain: \"ghost.example\"\n" }, entry(ORPHAN, "ghost.example"));
    const found = await scanOrphanTenants({ db: db.db, registry });
    expect(found.orphans.map((o) => o.guid)).toEqual([ORPHAN]); // the readable orphan is still found
    expect(found.skipped).toHaveLength(1);
    expect(found.skipped[0]).toMatchObject({ guid: BROKEN, stage: "prod" });
    expect(found.skipped[0]!.reason).toContain("failed its schema");
  });

  it("propagates a registry failure instead of answering an empty list", async () => {
    // Fail-soft is the ROUTE's job (it renders "the scan failed"); flattening it here would make an
    // unreachable catalog read as "no orphans found" — the exact opposite of the truth.
    const registry = { listTenantPointers: () => Promise.reject(new Error("catalog unreachable")) } as unknown as TenantRegistry;
    await expect(scanOrphanTenants({ db: db.db, registry })).rejects.toThrow("catalog unreachable");
  });
});

describe("CreateTenantPurgeTarget (the target frozen in a create-tenant run's params)", () => {
  it("projects a PLANNED run's params to exactly the purge request + subdomain", () => {
    // A superset of the purge request: extra params (owner, chartsRef, the PII adminEmail) are dropped,
    // so only the four fields the dialog needs can ever reach the browser.
    const parsed = CreateTenantPurgeTarget.parse({
      guid: GUID, subdomain: "acme.example", stage: "prod", clusterId: "cls_1",
      owner: "team-acme", chartsRef: SHA, adminEmail: "admin@acme.example",
    });
    expect(parsed).toEqual({ guid: GUID, subdomain: "acme.example", stage: "prod", clusterId: "cls_1" });
  });

  it("refuses the RAW params of a run that failed while still planning — no guid was frozen, so nothing was deployed", () => {
    expect(CreateTenantPurgeTarget.safeParse({ clusterId: "cls_1", subdomain: "acme.example", owner: "team-acme" }).success).toBe(false);
  });
});

// resolveRunTenantState is what stops a failed create-tenant's run screen from describing — or acting
// on — a tenant it never looked at. The run's kind + status say only that the RUN failed; the tenants
// ROW says what the TENANT is, and those two diverge for real: `activate` (the first-admin invite) is
// deliberately the LAST create-tenant step, after record-inventory, so a run can fail with the tenant
// fully deployed, settled "active" and serving. Every case below pins which remedy that state allows.
describe("resolveRunTenantState (what a create-tenant run's tenant IS now)", () => {
  /** The ONLY two states the run screen offers a purge for — a purge deletes the Tenant CR, which drops
   *  the tenant's Mongo databases and its Vault path, so every other state must fall outside this set. */
  const PURGEABLE = ["orphan", "unfinished"];
  const RUN = "run_ct";
  const frozen = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    guid: GUID, subdomain: "acme.example", stage: "prod", clusterId: "cls_1",
    owner: "team-acme", chartsRef: SHA, adminEmail: "admin@acme.example", ...over,
  });
  const seedRow = (over: Record<string, unknown> = {}): void => {
    db.db.insert(tenants).values({ id: "tnt_1", clusterId: "cls_1", guid: GUID, subdomain: "acme.example", stage: "prod", members: ["auth", "jobs", "report"], identityProvider: "auth", provenance: "controller", status: "active", ...over }).run();
  };
  /** The failed create-tenant run itself: its row plus its attest-target step at the status the executor
   *  would have left it — "ok" once the precondition held (every step after it mutates), "failed" when it
   *  refused, "pending" when the run never reached it. Written through the sqlite handle rather than a
   *  drizzle table because runs/steps belong to the executor alone (the dep-cruiser rule
   *  only-executor-touches-runs-schema); the executor's own recovery test takes the same escape. */
  const seedRun = (attest: "ok" | "failed" | "pending" = "ok"): void => {
    db.sqlite
      .prepare("INSERT INTO runs (id, kind, target_kind, target_id, params_json, status, started_by) VALUES (?, 'create-tenant', 'cluster', 'cls_1', '{}', 'failed', 'op_system')")
      .run(RUN);
    db.sqlite
      .prepare("INSERT INTO steps (id, run_id, ordinal, name, title, status) VALUES (?, ?, 0, 'attest-target', 'Attest the target cluster (deploy-state fresh)', ?)")
      .run("step_1", RUN, attest);
  };

  it("a run whose tenant is recorded ACTIVE is LIVE — never an orphan, and never purgeable", () => {
    // THE activate-failure case: watch-sync-set was green, smoke was green, record-inventory settled the
    // tenant and its app rows, and only the final invite threw (HTTP 503 from a freshly started tenant
    // example-auth is a known live condition). Answering with a purge target here would put a
    // "purge tenant" button, and copy claiming the tenant "may still exist", in front of an operator
    // whose tenant is serving — and that purge deprovisions it.
    seedRow();
    seedRun();
    const state = resolveRunTenantState(db.db, RUN, frozen());
    expect(state.state).toBe("live");
    expect(PURGEABLE).not.toContain(state.state);
    // The row travels with it so the screen can badge the tenant exactly as the Tenants list does and
    // link to it, instead of describing a tenant it cannot name.
    expect(state).toMatchObject({ row: { tenantId: "tnt_1", status: "active", suspended: false } });
  });

  it("a SUSPENDED tenant is live too — a tenant-wide pause is not a half-created tenant", () => {
    seedRow({ status: "suspended", suspended: true });
    seedRun();
    const state = resolveRunTenantState(db.db, RUN, frozen());
    expect(state.state).toBe("live");
    expect(state).toMatchObject({ row: { status: "suspended", suspended: true } });
  });

  it("a PROVISIONING row is UNFINISHED — the state the Tenants list badges, and the one purge is for", () => {
    // record-provisional wrote the row and the run never settled it: the tenant may be half-deployed or
    // not deployed at all. This is the gate the Tenants list and the tenant detail page already apply.
    seedRow({ status: "provisioning" });
    seedRun();
    const state = resolveRunTenantState(db.db, RUN, frozen());
    expect(state.state).toBe("unfinished");
    expect(state).toMatchObject({ target: { guid: GUID, subdomain: "acme.example", stage: "prod", clusterId: "cls_1" } });
  });

  it("NO row, and the run got PAST attest-target: ORPHAN — nothing else can name it, so purge is offered", () => {
    // A run that predates record-provisional (or one whose row write was skipped): it mutated — the
    // isolation AppProject, the pointer, the namespace and the Tenant CR may all stand — and nothing
    // recorded the tenant, so this run's frozen params are the only place the minted guid survives.
    seedRun("ok");
    const state = resolveRunTenantState(db.db, RUN, frozen());
    expect(state.state).toBe("orphan");
    expect(state).toEqual({ state: "orphan", target: { guid: GUID, subdomain: "acme.example", stage: "prod", clusterId: "cls_1" } });
  });

  it("NO row because attest-target REFUSED: NOT-DEPLOYED — the run never mutated, so nothing is claimed", () => {
    // The other half of "no row", and the opposite truth. attest-target is the fail-closed precondition
    // (step 0) and record-provisional — the only step before any mutation — comes after it, so a run
    // refused there deployed NOTHING: no fan-out, no AppProject, no namespace, no Tenant CR, and no
    // cleanups armed either. Reading it as "orphan" told the operator the run "failed after it had
    // started deploying" and offered a teardown of artifacts that never existed.
    seedRun("failed");
    const state = resolveRunTenantState(db.db, RUN, frozen());
    expect(state.state).toBe("not-deployed");
    expect(PURGEABLE).not.toContain(state.state);
    // The tenant is still NAMED — the guid was minted and frozen, and the screen says which tenant was
    // never created — it is simply not offered as something to remove.
    expect(state).toEqual({ state: "not-deployed", target: { guid: GUID, subdomain: "acme.example", stage: "prod", clusterId: "cls_1" } });
  });

  it("a run that never reached its precondition at all is NOT-DEPLOYED too", () => {
    // attest-target still `pending`: the run was planned (or died in the executor before its first step).
    seedRun("pending");
    expect(resolveRunTenantState(db.db, RUN, frozen()).state).toBe("not-deployed");
  });

  it("an UNREADABLE precondition falls back to ORPHAN — overstating leftovers beats hiding a live tenant", () => {
    // No step rows for this run at all (nothing seeded): the question "how far did it get" has no answer.
    // A wrong "orphan" costs a purge that reaps nothing; a wrong "not-deployed" hides a deployed tenant
    // no other verb in the product can name — so the unknown falls on the loud side.
    expect(resolveRunTenantState(db.db, RUN, frozen()).state).toBe("orphan");
  });

  it("an OFFBOARDED row says the tenant was already removed, and is NOT re-offered as a purge", () => {
    // Unlike the orphan scan (which treats a settled row as absent, because a live pointer beside it is
    // leftover state), the run screen must TELL the operator the row is settled rather than aim
    // a destructive verb at a tenant that is already gone. A surviving footprint is the scan's job.
    seedRow({ status: "offboarded" });
    seedRun();
    const state = resolveRunTenantState(db.db, RUN, frozen());
    expect(state.state).toBe("offboarded");
    expect(PURGEABLE).not.toContain(state.state);
    expect(state).toMatchObject({ row: { tenantId: "tnt_1", status: "offboarded" } });
  });

  it("a PURGED row is its OWN state — never 'offboarded', and above all never 'live'", () => {
    // Two things would have gone wrong without an arm of its own. The mild one: the
    // screen would print the offboarded copy, which says the tenant's cluster state was deliberately kept
    // and points at the purge that reaps it — for a tenant that has already been deprovisioned. The severe
    // one: with no arm at all the status falls through to the final `return { state: "live" }`, so the
    // screen would announce "The tenant this run created is live — do not remove it" about a tenant whose
    // Tenant CR, Vault path and Mongo databases are gone. The row travels with it so the badge reads
    // "purged" and the link still reaches the tenant page, which is the only place such a tenant is listed.
    seedRow({ status: "purged" });
    seedRun();
    const state = resolveRunTenantState(db.db, RUN, frozen());
    expect(state.state).toBe("purged");
    expect(PURGEABLE).not.toContain(state.state);
    expect(state).toMatchObject({ row: { tenantId: "tnt_1", status: "purged" } });
  });

  it("is stage-scoped: a row for the same guid at another stage does not account for this tenant", () => {
    // guid+stage is the identity the pointer path itself is keyed on (registrations/<guid>/<stage>.yaml),
    // the same key resolveTeardownTarget resolves by — a dev row must not make a prod tenant read as
    // recorded.
    seedRow({ stage: "dev" });
    seedRun("ok");
    expect(resolveRunTenantState(db.db, RUN, frozen()).state).toBe("orphan");
  });

  it("a run that never froze a guid is NONE — it created nothing, so no state is claimed about a tenant", () => {
    const state = resolveRunTenantState(db.db, RUN, { clusterId: "cls_1", subdomain: "acme.example", owner: "team-acme" });
    expect(state.state).toBe("none");
    expect(state).toMatchObject({ reason: expect.stringContaining("created nothing to purge") });
  });
});
