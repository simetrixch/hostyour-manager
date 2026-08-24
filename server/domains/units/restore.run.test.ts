import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { seedQuota } from "../../../shared/unit-size.ts";
import { eq } from "drizzle-orm";
import type { DbHandle } from "../../db/client.ts";
import { apps, tenants, tenantApps } from "../../db/schema/inventory.ts";
import { TenantRegistrationSchema } from "../../../shared/tenant.ts";
import { ConsumerRegistrationSchema } from "../../../shared/consumer.ts";
import { serializePointer } from "./registrations.ts";
import { makeRestoreDef, makeTenantRestoreDef } from "./restore.run.ts";
import {
  openFixtureDb, seedClusters, seedConsumerRow, seedTenantRows, makeFakes, consumerPorts, tenantPorts,
  driveSteps, jobNames, tenantEntry, GUID, CONSUMER, SUBDOMAIN, TARGET,
} from "./relocation.fixture.ts";

// restore / tenant-restore — the second half of the ONE mechanism, on its own: the box folder is the
// blueprint (the dumped registration.yaml) and the source of every byte. The journey both defs must
// satisfy: a restore RECONSTRUCTS AN OFFBOARDED UNIT data-identically — same identity, same
// registration content (repointed at the target), every store replayed — and an injected restore
// failure leaves the source (the folder, the rows) fully intact.

let db: DbHandle;
beforeEach(() => { db = openFixtureDb(); });
afterEach(() => { db.sqlite.close(); });

const STEP_ORDER = ["attest-target", "provision-target", "watch", "restore", "verify-completeness", "switch-dns", "smoke", "open-access", "record"];

/** Script the box folder's registration read: the job on the target answers the dumped bytes. */
function scriptDumpedRegistration(reader: { setJobResult(prefix: string, r: { succeeded: boolean; logs: string }): void }, unit: string, yaml: string): void {
  reader.setJobResult(`reloc-read-reg-${unit}`, { succeeded: true, logs: `REGISTRATION-BEGIN\n${yaml}\nREGISTRATION-END` });
}

describe("tenant-restore", () => {
  it("journey: reconstructs an offboarded tenant from the box folder — provisioned from the dumped registration, restored closed, opened last, recorded active on the target", async () => {
    seedClusters(db);
    seedTenantRows(db, "offboarded"); // the offboard settled the rows; the registration is long gone
    const f = makeFakes();
    const ports = tenantPorts(f);
    const dumped = serializePointer(TenantRegistrationSchema, tenantEntry());
    scriptDumpedRegistration(f.target.reader, GUID, dumped);
    f.target.reader.setSecretValue(`${GUID}-auth`, "hostyour-app-secrets", "AUTH_JWT_PUBLIC_KEY", "-----BEGIN PUBLIC KEY-----");

    const def = makeTenantRestoreDef(ports);
    const plan = await def.plan({ tenantId: "tnt_1", targetClusterId: TARGET.clusterId }, { db: db.db });
    expect(plan.steps.map((s) => s.name)).toEqual(STEP_ORDER);

    const logs: string[] = [];
    const params = { tenantId: "tnt_1", targetClusterId: TARGET.clusterId };
    await driveSteps(db, def.steps(params), params, logs);

    // The registration is BACK, repointed at the target, open (open-access lifted the quiesce it was
    // re-committed under) — and otherwise byte-for-byte the dumped content.
    const restored = await ports.registrations.readTenant("prod", GUID);
    expect(restored?.entry.cluster).toBe(TARGET.cluster);
    expect(restored?.entry.quiesced).toBe(false);
    expect(restored?.entry.subdomain).toBe(SUBDOMAIN);
    expect(restored?.entry.apps.map((a) => a.name)).toEqual(["web"]);
    // Every member's isolation was provisioned on the TARGET (trio + web = 4 AppProjects) + the CR.
    for (const member of ["auth", "jobs", "report", "web"]) {
      expect(f.target.projects.get(TARGET.cluster, `${GUID}-${member}`)).toBeDefined();
    }
    // The stores were replayed on the target, and completeness ran before DNS.
    const names = jobNames(f.target);
    expect(names).toContain(`reloc-restore-mongo-${GUID}`);
    expect(names).toContain(`reloc-restore-bucket-${GUID}`);
    expect(names).toContain(`reloc-verify-mongo-${GUID}`);
    // The one wildcard record points at the target cluster's own address.
    expect(f.dns.record(`*.${SUBDOMAIN}.example.com`, "A")).toBe(TARGET.ip);
    // The rows settled LAST: active, on the target.
    const row = db.db.select().from(tenants).where(eq(tenants.id, "tnt_1")).get();
    expect(row?.status).toBe("active");
    expect(row?.clusterId).toBe(TARGET.clusterId);
    expect(db.db.select().from(tenantApps).where(eq(tenantApps.id, "tna_web")).get()?.status).toBe("active");
  });

  it("journey: an injected restore failure leaves the source fully intact — the folder is never cleared and the rows never settle", async () => {
    seedClusters(db);
    seedTenantRows(db, "offboarded");
    const f = makeFakes();
    const ports = tenantPorts(f);
    scriptDumpedRegistration(f.target.reader, GUID, serializePointer(TenantRegistrationSchema, tenantEntry()));
    f.target.reader.setJobResult(`reloc-restore-mongo-${GUID}`, { succeeded: false, logs: "mongorestore: connection refused" });

    const params = { tenantId: "tnt_1", targetClusterId: TARGET.clusterId };
    await expect(driveSteps(db, makeTenantRestoreDef(ports).steps(params), params, [])).rejects.toThrow(/connection refused/);

    // Nothing cleared the folder or the source, nothing switched DNS, nothing settled the rows.
    expect([...jobNames(f.source), ...jobNames(f.target)].find((n) => n.startsWith("reloc-clear-source"))).toBeUndefined();
    expect(f.dns.record(`*.${SUBDOMAIN}.example.com`, "A")).toBeUndefined();
    expect(db.db.select().from(tenants).where(eq(tenants.id, "tnt_1")).get()?.status).toBe("offboarded");
  });

  it("refuses a box folder without a readable registration — a restore never guesses what the unit was", async () => {
    seedClusters(db);
    seedTenantRows(db, "offboarded");
    const f = makeFakes();
    const ports = tenantPorts(f);
    f.target.reader.setJobResult(`reloc-read-reg-${GUID}`, { succeeded: true, logs: "REGISTRATION-BEGIN\nREGISTRATION-END" });

    const params = { tenantId: "tnt_1", targetClusterId: TARGET.clusterId };
    await expect(driveSteps(db, makeTenantRestoreDef(ports).steps(params), params, [])).rejects.toThrow(/no readable registration/);
  });
});

describe("restore (consumer)", () => {
  it("reconstructs an offboarded consumer: registration re-committed at the target from the dumped bytes, stores replayed, row active on the target", async () => {
    seedClusters(db);
    seedConsumerRow(db, "offboarded");
    const f = makeFakes();
    const ports = consumerPorts(f);
    const dumped = serializePointer(ConsumerRegistrationSchema, {
      name: CONSUMER, repoURL: "https://github.com/x/acme.git", suspended: false, quiesced: false,
      chartPath: "deploy/chart", cluster: "s1", databases: ["acme_db"], services: ["mongodb"], size: "medium", mongodb: "shared",
      quota: seedQuota("medium"),
    });
    scriptDumpedRegistration(f.target.reader, CONSUMER, dumped);

    const params = { appId: "app_1", targetClusterId: TARGET.clusterId };
    await driveSteps(db, makeRestoreDef(ports).steps(params), params, []);

    const restored = await ports.registrations.readRegistration("prod", CONSUMER);
    expect(restored?.entry.cluster).toBe(TARGET.cluster);
    expect(restored?.entry.quiesced).toBe(false);
    expect(restored?.entry.databases).toEqual(["acme_db"]);
    // The size travels with the unit: a restore must land it on the instance it ran on, not on
    // whatever the default happens to be at the destination.
    expect(restored?.entry.size).toBe("medium");
    // The namespace ceiling travels with it for the same reason, as FIGURES: a restore onto an
    // installation whose size table has since moved must land the unit on what it ran with, not on
    // what "medium" means there today.
    expect(restored?.entry.quota).toEqual(seedQuota("medium"));
    expect(jobNames(f.target)).toContain(`reloc-restore-mongo-${CONSUMER}`);
    expect(f.dns.record(`${CONSUMER}.${TARGET.domain}`, "A")).toBe(TARGET.ip);
    const row = db.db.select().from(apps).where(eq(apps.id, "app_1")).get();
    expect(row?.status).toBe("active");
    expect(row?.clusterId).toBe(TARGET.clusterId);
  });
});
