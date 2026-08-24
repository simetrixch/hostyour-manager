import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import type { DbHandle } from "../../db/client.ts";
import { apps, tenants } from "../../db/schema/inventory.ts";
import { CLAIM_RELOCATING_ANNOTATION } from "../../adapters/kube/port.ts";
import { makeMigrateDef, makeTenantMigrateDef } from "./migrate.run.ts";
import { repointStep } from "./relocation-migrate.ts";
import { consumerWorld } from "./relocation-world-consumer.ts";
import {
  openFixtureDb, seedClusters, seedConsumerRow, seedTenantRows, seedConsumerRegistration, seedTenantWorld,
  makeFakes, consumerPorts, tenantPorts, driveSteps, stepCtx, jobNames, missing, GUID, CONSUMER, SUBDOMAIN, SOURCE, TARGET,
} from "./relocation.fixture.ts";

// migrate / tenant-migrate — the whole relocation mechanism in one run. The journeys these tests pin:
// the sequence VERBATIM (close · dump · restore · verify · switch DNS · open · clear source), a
// tenant with Garage object storage moving whole (the bucket jobs ride every phase), an injected
// restore failure leaving the source fully intact (nothing cleared, nothing recorded), and the two
// marks a repoint sets so that the source RELEASES the unit instead of destroying it — the Tenant CR's
// relocating annotation and, on every source namespace, the claim mark that stops the
// service-provisioner from dropping the databases when the repoint prunes the ServiceClaims.

let db: DbHandle;
beforeEach(() => { db = openFixtureDb(); });
afterEach(() => { db.sqlite.close(); });

// close access · dump all members · provide and restore on the target · verify
// completeness · switch DNS · open access · clear the source — each with its measurement beside it.
const STEP_ORDER = [
  "attest-target",
  "quiesce",
  "verify-quiesced",
  "dump",
  "verify-dump",
  "provision-target",
  "repoint",
  "watch",
  "verify-source-released",
  "restore",
  "verify-completeness",
  "switch-dns",
  "smoke",
  "open-access",
  "clear-source",
  "record",
];

describe("migrate (consumer)", () => {
  it("plans the relocation sequence verbatim and refuses a move onto the unit's own cluster", async () => {
    seedClusters(db);
    seedConsumerRow(db);
    const f = makeFakes();
    const ports = consumerPorts(f);
    await seedConsumerRegistration(ports.registrations);
    const def = makeMigrateDef(ports);
    const plan = await def.plan({ appId: "app_1", targetClusterId: TARGET.clusterId }, { db: db.db });
    expect(plan.steps.map((s) => s.name)).toEqual(STEP_ORDER);
    await expect(def.plan({ appId: "app_1", targetClusterId: SOURCE.clusterId }, { db: db.db })).rejects.toThrow(/DIFFERENT target/);
  });

  it("journey: moves the consumer — repointed registration, one record updated in place, source cleared LAST, row on the target", async () => {
    seedClusters(db);
    seedConsumerRow(db);
    const f = makeFakes();
    const ports = consumerPorts(f);
    await seedConsumerRegistration(ports.registrations);
    // The unit's record already stands (the onboard created it) — the move must UPDATE it, not mint a pair.
    f.dns.seed(`${CONSUMER}.${TARGET.domain}`, "A", SOURCE.ip);
    f.source.reader.setJobResult(`reloc-list-source-${CONSUMER}`, { succeeded: true, logs: "DB acme_db" });

    const params = { appId: "app_1", targetClusterId: TARGET.clusterId };
    await driveSteps(db, makeMigrateDef(ports).steps(params), params, [], {
      // After the repoint the source appset stops generating the Application — model exactly that.
      "verify-source-released": () => f.source.argo.setStatus(missing),
    });

    // The registration points at the target and is open again.
    const reg = await ports.registrations.readRegistration("prod", CONSUMER);
    expect(reg?.entry.cluster).toBe(TARGET.cluster);
    expect(reg?.entry.quiesced).toBe(false);
    // ONE record, updated in place with the target cluster's own address.
    const upsert = f.dns.upserts.find((u) => u.name === `${CONSUMER}.${TARGET.domain}`);
    expect(upsert).toEqual({ name: `${CONSUMER}.${TARGET.domain}`, type: "A", content: TARGET.ip, created: false });
    // Dump ran on the source, restore + completeness on the target, the clear on the source — and
    // the clear came AFTER the target held everything (the job orders on each side say so).
    expect(jobNames(f.source)).toContain(`reloc-dump-mongo-${CONSUMER}`);
    expect(jobNames(f.target)).toContain(`reloc-restore-mongo-${CONSUMER}`);
    const sourceJobs = jobNames(f.source);
    expect(sourceJobs.indexOf(`reloc-clear-source-${CONSUMER}`)).toBeGreaterThan(sourceJobs.indexOf(`reloc-list-source-${CONSUMER}`));
    // The source namespace was marked relocating BEFORE the flip pruned the Application, so the
    // ServiceClaim teardown that the prune sets off kept the databases — which is why the listing in
    // verify-source-released could still find them. The TARGET namespace carries no such mark: the
    // mark means "leaving", and provision-target clears any left over from an earlier move away.
    expect(f.source.reader.namespaceAnnotations.get(CONSUMER)?.[CLAIM_RELOCATING_ANNOTATION]).toBe("true");
    expect(f.target.reader.namespaceAnnotations.get(CONSUMER)?.[CLAIM_RELOCATING_ANNOTATION]).toBeUndefined();
    // The source namespace fell with the clear (the per-consumer PostgreSQL and the PVCs go with it).
    expect(f.source.reader.deletedNamespaces).toContain(CONSUMER);
    // The row settled LAST, onto the target.
    const row = db.db.select().from(apps).where(eq(apps.id, "app_1")).get();
    expect(row?.clusterId).toBe(TARGET.clusterId);
    expect(row?.status).toBe("active");
  });
});

describe("repoint (the claim mark)", () => {
  it("marks the source namespace BEFORE it flips the registration — an unmarkable namespace stops the repoint with the unit still on the source", async () => {
    seedClusters(db);
    seedConsumerRow(db);
    const f = makeFakes();
    const ports = consumerPorts(f);
    await seedConsumerRegistration(ports.registrations);
    // The source namespace is gone (this is the fake's absence model), so the mark cannot be written.
    await f.source.reader.deleteNamespace(CONSUMER);

    await expect(repointStep(consumerWorld(ports, "app_1"), TARGET.clusterId).run(stepCtx(db, "repoint", {}, []))).rejects.toThrow(/nothing to annotate/);

    // The order is the whole safety property: the flip is what deletes the source Application and its
    // ServiceClaims, so it must never happen while the source teardown would still drop the databases.
    const reg = await ports.registrations.readRegistration("prod", CONSUMER);
    expect(reg?.entry.cluster).toBe(SOURCE.cluster);
  });
});

describe("tenant-migrate", () => {
  it("journey: a tenant with Garage object storage is moved whole — bucket dumped and restored, source CR released via the relocating annotation, source cleared last", async () => {
    seedClusters(db);
    seedTenantRows(db);
    const f = makeFakes();
    const ports = tenantPorts(f);
    await seedTenantWorld(ports.registrations);
    f.source.reader.setJobResult(`reloc-list-source-${GUID}`, { succeeded: true, logs: `DB ${GUID}_auth_prod\nDB ${GUID}_web_prod` });

    const def = makeTenantMigrateDef(ports);
    const plan = await def.plan({ tenantId: "tnt_1", targetClusterId: TARGET.clusterId }, { db: db.db });
    expect(plan.steps.map((s) => s.name)).toEqual(STEP_ORDER);

    f.target.reader.setSecretValue(`${GUID}-auth`, "hostyour-app-secrets", "AUTH_JWT_PUBLIC_KEY", "-----BEGIN PUBLIC KEY-----");
    const params = { tenantId: "tnt_1", targetClusterId: TARGET.clusterId };
    await driveSteps(db, def.steps(params), params, [], {
      // After the repoint the source appset stops matching this registration and ArgoCD prunes every
      // member Application — model exactly that, which is what the release IS for a tenant.
      "verify-source-released": () => f.source.argo.setStatuses(new Map()),
    });

    // The bracket moved under its unchanged guid: registration on the target, open.
    const reg = await ports.registrations.readTenant("prod", GUID);
    expect(reg?.entry.cluster).toBe(TARGET.cluster);
    expect(reg?.entry.quiesced).toBe(false);
    // The source CR was annotated relocating BEFORE its delete — the release, not a deprovision.
    // And every source MEMBER namespace was marked too: each member chart renders its own ServiceClaim,
    // so the CR release alone would not have saved the member databases from the prune's claim cascade.
    for (const member of ["auth", "jobs", "report", "web"]) {
      expect(f.source.reader.namespaceAnnotations.get(`${GUID}-${member}`)?.[CLAIM_RELOCATING_ANNOTATION]).toBe("true");
    }
    // The target got the whole isolation: every member AppProject + the CR.
    for (const member of ["auth", "jobs", "report", "web"]) {
      expect(f.target.projects.get(TARGET.cluster, `${GUID}-${member}`)).toBeDefined();
    }
    // The GARAGE bucket rode every phase: dumped on the source, restored + counted on the target.
    expect(jobNames(f.source)).toContain(`reloc-dump-bucket-${GUID}`);
    expect(jobNames(f.target)).toContain(`reloc-restore-bucket-${GUID}`);
    expect(jobNames(f.target)).toContain(`reloc-verify-bucket-${GUID}`);
    // ONE wildcard record now carries the target's address.
    expect(f.dns.record(`*.${SUBDOMAIN}.example.com`, "A")).toBe(TARGET.ip);
    // The source fell LAST: databases dropped + folder purged (the clear job), namespaces reaped.
    expect(jobNames(f.source)).toContain(`reloc-clear-source-${GUID}`);
    for (const member of ["auth", "jobs", "report", "web"]) {
      expect(f.source.reader.deletedNamespaces).toContain(`${GUID}-${member}`);
    }
    // The row settled LAST, onto the target.
    const row = db.db.select().from(tenants).where(eq(tenants.id, "tnt_1")).get();
    expect(row?.clusterId).toBe(TARGET.clusterId);
    expect(row?.status).toBe("active");
  });

  it("journey: an injected restore failure leaves the source fully intact — nothing cleared, nothing recorded, the folder survives", async () => {
    seedClusters(db);
    seedTenantRows(db);
    const f = makeFakes();
    const ports = tenantPorts(f);
    await seedTenantWorld(ports.registrations);
    f.source.reader.setJobResult(`reloc-list-source-${GUID}`, { succeeded: true, logs: `DB ${GUID}_auth_prod` });
    f.target.reader.setJobResult(`reloc-restore-mongo-${GUID}`, { succeeded: false, logs: "mongorestore: disk full" });

    const params = { tenantId: "tnt_1", targetClusterId: TARGET.clusterId };
    await expect(
      driveSteps(db, makeTenantMigrateDef(ports).steps(params), params, [], {
        "verify-source-released": () => f.source.argo.setStatuses(new Map()),
      }),
    ).rejects.toThrow(/disk full/);

    // clear-source never ran: the source databases and the box folder are untouched, no source
    // namespace fell, and the inventory still names the source cluster.
    expect(jobNames(f.source).find((n) => n.startsWith("reloc-clear-source"))).toBeUndefined();
    expect(f.source.reader.deletedNamespaces).toEqual([]);
    const row = db.db.select().from(tenants).where(eq(tenants.id, "tnt_1")).get();
    expect(row?.clusterId).toBe(SOURCE.clusterId);
  });
});
