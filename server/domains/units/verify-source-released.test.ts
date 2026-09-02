import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { DbHandle } from "../../db/client.ts";
import { tenantWorld } from "./relocation-world-tenant.ts";
import { verifySourceReleasedStep } from "./verify-source-released.ts";
import { makeTenantMigrateDef } from "./migrate.run.ts";
import { consumerWorld } from "./relocation-world-consumer.ts";
import {
  openFixtureDb, seedClusters, seedTenantRows, seedConsumerRow, seedTenantWorld, seedConsumerRegistration,
  makeFakes, tenantPorts, consumerPorts, driveSteps, stepCtx, jobNames, missing, GUID, TARGET,
} from "./relocation.fixture.ts";

// verify-source-released — the safety property of the whole step, measured LIVE with a REAL failure
// mode on each half: (a) a source handle still standing aborts (two live copies must never both
// serve), and (b) missing source data aborts BEFORE restore and BEFORE clear-source (the release
// destroyed instead of releasing — for a tenant, the relocating annotation did not make the operator
// skip its delete branch — and the box folder is now the only copy). The counter-probe below is the
// step-11 proof fixture: with the operator's skip effectively DISABLED, the run must stop exactly
// here, restore still pending.

let db: DbHandle;
beforeEach(() => { db = openFixtureDb(); });
afterEach(() => { db.sqlite.close(); });

describe("verify-source-released (step level)", () => {
  it("passes when the source fan-out is pruned AND the source still lists the tenant databases", async () => {
    seedClusters(db);
    seedTenantRows(db);
    const f = makeFakes();
    const ports = tenantPorts(f);
    await seedTenantWorld(ports.registrations);
    // The repoint pruned the source fan-out — the release, for a tenant. An empty script makes every
    // expected name read Missing, which is what a pruned set looks like to the watch.
    f.source.argo.setStatuses(new Map());
    f.source.reader.setJobResult(`reloc-list-source-${GUID}`, { succeeded: true, logs: `DB ${GUID}_auth_prod\nDB ${GUID}_web_prod` });
    // The CR was deleted (the fake's watch observes gone unless wedged) — the released state.
    const logs: string[] = [];
    await verifySourceReleasedStep(ports, tenantWorld(ports, "tnt_1")).run(stepCtx(db, "verify-source-released", {}, logs));
    expect(logs.some((l) => l.includes("still holds 2 database(s)"))).toBe(true);
  });

  it("aborts when the source still GENERATES the tenant — a member Application that did not prune", async () => {
    // The tenant handle is its fan-out: the repoint flips the registration's cluster field, the source
    // appset stops matching, and ArgoCD prunes one Application per member. A member still standing is a
    // source that has not let go, and continuing would put two live copies of one tenant on two
    // clusters. Watching the source Tenant CR instead rests on an object nothing holds, so such a
    // check always passes.
    seedClusters(db);
    seedTenantRows(db);
    const f = makeFakes();
    const ports = tenantPorts(f);
    await seedTenantWorld(ports.registrations);
    f.source.argo.setStatuses(new Map([[`${GUID}-auth-prod`, { syncRevision: null, targetRevision: null, sync: "Synced" as const, health: "Healthy" as const }]]));
    await expect(verifySourceReleasedStep(ports, tenantWorld(ports, "tnt_1")).run(stepCtx(db, "verify-source-released", {}, []))).rejects.toThrow(/has not released/);
  });

  it("COUNTER-PROBE: with the relocating skip disabled (the operator deprovisioned the source), the migrate aborts BEFORE restore because the source databases are missing", async () => {
    seedClusters(db);
    seedTenantRows(db);
    const f = makeFakes();
    const ports = tenantPorts(f);
    await seedTenantWorld(ports.registrations);
    // The fixture: the operator ran its delete branch anyway — the source lists NO <guid>_* database.
    // (The list job's default answer is an empty log, which is exactly that observation.)
    f.target.reader.setSecretValue(`${GUID}-auth`, "hostyour-app-secrets", "AUTH_JWT_PUBLIC_KEY", "-----BEGIN PUBLIC KEY-----");

    const params = { tenantId: "tnt_1", targetClusterId: TARGET.clusterId };
    await expect(
      // The source fan-out is pruned only AT the verify step: the steps BEFORE it watch that same set
      // converge on the source, so clearing it at setup would fail the run earlier and for the wrong
      // reason. That is the real order too — the prune follows the repoint.
      driveSteps(db, makeTenantMigrateDef(ports).steps(params), params, [], {
        "verify-source-released": () => f.source.argo.setStatuses(new Map()),
      }),
    ).rejects.toThrow(/relocating annotation/);

    // The abort came BEFORE restore and BEFORE clear-source: nothing was replayed onto the target,
    // nothing was dropped or purged on the source — the box folder is the surviving copy.
    expect(jobNames(f.target).find((n) => n.startsWith("reloc-restore"))).toBeUndefined();
    expect(jobNames(f.source).find((n) => n.startsWith("reloc-clear-source"))).toBeUndefined();
  });

  it("the Vault half deliberately does not exist — the step asks the fan-out and the databases, nothing else", async () => {
    // One shared KV mount serves every cluster and a move never touches it, so a Vault check could
    // never fail and would measure nothing. The step's whole surface is the two halves above: this
    // pins that no port beyond the resolver + the listing job is reached on the happy path.
    seedClusters(db);
    seedTenantRows(db);
    const f = makeFakes();
    const ports = tenantPorts(f);
    await seedTenantWorld(ports.registrations);
    // The repoint pruned the source fan-out — the release, for a tenant. An empty script makes every
    // expected name read Missing, which is what a pruned set looks like to the watch.
    f.source.argo.setStatuses(new Map());
    f.source.reader.setJobResult(`reloc-list-source-${GUID}`, { succeeded: true, logs: `DB ${GUID}_auth_prod` });
    await verifySourceReleasedStep(ports, tenantWorld(ports, "tnt_1")).run(stepCtx(db, "verify-source-released", {}, []));
    // The only job the step ran is the source listing.
    expect(jobNames(f.source)).toEqual([`reloc-list-source-${GUID}`]);
    expect(jobNames(f.target)).toEqual([]);
  });
});

// The consumer half of (a): the source Application must be pruned. Exercised through the consumer
// migrate journey (migrate.run.test.ts flips the source Application to Missing before this step);
// here the REFUSAL: a source that still generates the Application stops the run.
describe("verify-source-released (consumer handle)", () => {
  it("aborts while the source still generates the Application", async () => {
    seedClusters(db);
    seedConsumerRow(db);
    const f = makeFakes();
    const ports = consumerPorts(f);
    await seedConsumerRegistration(ports.registrations);
    // The source argo still reports the app Synced/Healthy — the handle was NOT released.
    await expect(verifySourceReleasedStep(ports, consumerWorld(ports, "app_1")).run(stepCtx(db, "verify-source-released", {}, []))).rejects.toThrow(/still generates/);
  });

  it("COUNTER-PROBE: a released handle with NO source databases left aborts, naming the claim mark that should have kept them", async () => {
    seedClusters(db);
    seedConsumerRow(db);
    const f = makeFakes();
    const ports = consumerPorts(f);
    await seedConsumerRegistration(ports.registrations);
    // The handle IS released — the source appset stopped generating the Application — but the listing
    // finds nothing. That is exactly the state the ServiceClaim cascade leaves behind when the source
    // namespace was not marked: the prune took the claim, and the provisioner dropped the databases
    // with it. A consumer has no CR, so this mark is its ONLY release, and the refusal must say so.
    f.source.argo.setStatus(missing);
    await expect(verifySourceReleasedStep(ports, consumerWorld(ports, "app_1")).run(stepCtx(db, "verify-source-released", {}, [])))
      .rejects.toThrow(/platform\.hostyour\.cloud\/relocating/);
  });

  // The data half only has an answer where the ServiceClaim cascade could have taken something. Two
  // consumers have nothing it could take, and for both an empty listing would be read as "the release
  // DESTROYED the source data" — an accusation that is false, raised AFTER the repoint, on a unit that
  // never held such a database. Both must pass on the handle alone.
  it("a consumer with no Mongo databases passes on the released handle alone — no listing job, no false accusation", async () => {
    seedClusters(db);
    seedConsumerRow(db);
    const f = makeFakes();
    const ports = consumerPorts(f);
    // `databases: []` is what the registration carries for a consumer that requests none, and
    // registry-pull is a claim with no database at all.
    await seedConsumerRegistration(ports.registrations, { services: ["registry-pull"], databases: [] });
    f.source.argo.setStatus(missing);

    const logs: string[] = [];
    await verifySourceReleasedStep(ports, consumerWorld(ports, "app_1")).run(stepCtx(db, "verify-source-released", {}, logs));
    expect(jobNames(f.source)).toEqual([]);
    expect(logs.some((l) => l.includes("holds no database the ServiceClaim cascade could have dropped"))).toBe(true);
  });

  it("a PostgreSQL consumer runs NO listing job — the repoint pruned the instance the old branch dialled", async () => {
    seedClusters(db);
    seedConsumerRow(db);
    const f = makeFakes();
    const ports = consumerPorts(f);
    // The per-consumer PostgreSQL is a source of the SAME Application the repoint prunes, so by this
    // step its Deployment and its postgresql-credentials Secret are gone; and the claim cascade never
    // drops its data anyway (deprovision_postgresql is a no-op, the PVC carries Delete=false).
    await seedConsumerRegistration(ports.registrations, { services: ["postgresql"], databases: ["acme_db"] });
    f.source.argo.setStatus(missing);

    await verifySourceReleasedStep(ports, consumerWorld(ports, "app_1")).run(stepCtx(db, "verify-source-released", {}, []));
    expect(jobNames(f.source)).toEqual([]);
  });
});
