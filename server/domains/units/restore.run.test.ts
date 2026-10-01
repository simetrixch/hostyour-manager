import { clusterMapPath } from "../../../shared/cluster-values.ts";
import { SLAVE_FQDN, SLAVE_MARKING_YAML } from "../runs/cluster-maps.fixture.ts";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { seedQuota } from "#unit/shared/unit-size.ts";
import { eq } from "drizzle-orm";
import type { DbHandle } from "../../db/client.ts";
import { apps, tenants, tenantApps } from "../../db/schema/inventory.ts";
import { TenantRegistrationSchema } from "../../../shared/tenant.ts";
import { ConsumerRegistrationSchema } from "../../../shared/consumer.ts";
import { serializePointer } from "#unit/server/registration-laws.ts";
import { makeRestoreDef, makeTenantRestoreDef } from "./restore.run.ts";
import { recordBackupFinished, recordBackupStarted } from "../../db/unit-backups.ts";
import {
  openFixtureDb, seedClusters, seedConsumerRow, seedTenantRows, makeFakes, consumerPorts, tenantPorts,
  driveSteps, jobNames, tenantEntry, GUID, CONSUMER, SUBDOMAIN, TARGET, INSTALLATION,
} from "./relocation.fixture.ts";

// restore / tenant-restore — the second half of the ONE mechanism, on its own: the picked generation is
// the blueprint (the dumped registration.yaml) and the source of every byte. The journey both defs must
// satisfy: a restore RECONSTRUCTS AN OFFBOARDED UNIT data-identically — same identity, same
// registration content (repointed at the target), every store replayed — and an injected restore
// failure leaves the source (the folder, the rows) fully intact.

let db: DbHandle;
beforeEach(() => { db = openFixtureDb(); });
afterEach(() => { db.sqlite.close(); });

const STEP_ORDER = ["attest-target", "provision-target", "watch", "restore", "verify-completeness", "switch-dns", "smoke", "open-access", "record"];

/** The generation every restore below picks: written and verified by an earlier backup. */
const GENERATION = "20260927T030000Z";
const folderOf = (kind: "tenant" | "consumer", unit: string): string => `${INSTALLATION}/prod/${kind}s/${unit}/${GENERATION}`;
function seedGeneration(db: DbHandle, kind: "tenant" | "consumer", unit: string): void {
  const g = { kind, unit, stage: "prod" as const, generation: GENERATION };
  recordBackupStarted(db.db, { ...g, folder: folderOf(kind, unit), trigger: "manual", runId: "run_backup" });
  recordBackupFinished(db.db, g, { state: "ok" });
}

/** Script the generation's registration read: the job on the target answers the dumped bytes. */
function scriptDumpedRegistration(reader: { setJobResult(prefix: string, r: { succeeded: boolean; logs: string }): void }, unit: string, yaml: string): void {
  reader.setJobResult(`reloc-read-reg-${unit}`, { succeeded: true, logs: `REGISTRATION-BEGIN\n${yaml}\nREGISTRATION-END` });
}

describe("tenant-restore", () => {
  it("journey: reconstructs an offboarded tenant from the box folder — provisioned from the dumped registration, restored closed, opened last, recorded active on the target", async () => {
    seedClusters(db);
    seedTenantRows(db, "offboarded"); // the offboard settled the rows; the registration is long gone
    seedGeneration(db, "tenant", GUID);
    const f = makeFakes();
    const ports = tenantPorts(f);
    const dumped = serializePointer(TenantRegistrationSchema, tenantEntry());
    scriptDumpedRegistration(f.target.reader, GUID, dumped);
    f.target.reader.setSecretValue(`${GUID}-auth-prod`, "hostyour-app-secrets", "AUTH_JWT_PUBLIC_KEY", "-----BEGIN PUBLIC KEY-----");

    const def = makeTenantRestoreDef(ports);
    const plan = await def.plan({ tenantId: "tnt_1", targetClusterId: TARGET.clusterId, generation: GENERATION }, { db: db.db });
    expect(plan.steps.map((s) => s.name)).toEqual(STEP_ORDER);

    const logs: string[] = [];
    const params = { tenantId: "tnt_1", targetClusterId: TARGET.clusterId, generation: GENERATION };
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
      expect(f.target.projects.get(TARGET.cluster, `${GUID}-${member}-prod`)).toBeDefined();
    }
    // The stores were replayed on the target out of the PICKED generation, and completeness ran before DNS.
    const names = jobNames(f.target);
    expect(names).toContain(`reloc-restore-mongo-${GUID}`);
    expect(f.target.reader.jobs.find((j) => j.spec.name === `reloc-restore-mongo-${GUID}`)?.spec.script).toContain(`box:${folderOf("tenant", GUID)}/mongo/`);
    expect(f.target.reader.jobs.find((j) => j.spec.name === `reloc-read-reg-${GUID}`)?.spec.script).toContain(`box:${folderOf("tenant", GUID)}/registration.yaml`);
    expect(names).toContain(`reloc-restore-bucket-${GUID}`);
    expect(names).toContain(`reloc-verify-mongo-${GUID}`);
    // The one wildcard record points at the target cluster.
    expect(f.dns.record(`*.${SUBDOMAIN}.example.com`, "CNAME")).toBe(TARGET.domain);
    // The rows settled LAST: active, on the target.
    const row = db.db.select().from(tenants).where(eq(tenants.id, "tnt_1")).get();
    expect(row?.status).toBe("active");
    expect(row?.clusterId).toBe(TARGET.clusterId);
    expect(db.db.select().from(tenantApps).where(eq(tenantApps.id, "tna_web")).get()?.status).toBe("active");
  });

  it("journey: an injected restore failure leaves the source fully intact — the folder is never cleared and the rows never settle", async () => {
    seedClusters(db);
    seedTenantRows(db, "offboarded");
    seedGeneration(db, "tenant", GUID);
    const f = makeFakes();
    const ports = tenantPorts(f);
    scriptDumpedRegistration(f.target.reader, GUID, serializePointer(TenantRegistrationSchema, tenantEntry()));
    f.target.reader.setJobResult(`reloc-restore-mongo-${GUID}`, { succeeded: false, logs: "mongorestore: connection refused" });

    const params = { tenantId: "tnt_1", targetClusterId: TARGET.clusterId, generation: GENERATION };
    await expect(driveSteps(db, makeTenantRestoreDef(ports).steps(params), params, [])).rejects.toThrow(/connection refused/);

    // Nothing cleared the folder or the source, nothing switched DNS, nothing settled the rows.
    expect([...jobNames(f.source), ...jobNames(f.target)].find((n) => n.startsWith("reloc-clear-source"))).toBeUndefined();
    expect(f.dns.record(`*.${SUBDOMAIN}.example.com`, "A")).toBeUndefined();
    expect(db.db.select().from(tenants).where(eq(tenants.id, "tnt_1")).get()?.status).toBe("offboarded");
  });

  it("refuses at plan a generation that is unknown or not verified — only a written and verified one is restored", async () => {
    seedClusters(db);
    seedTenantRows(db, "offboarded");
    const ports = tenantPorts(makeFakes());
    const plan = (generation: string) => makeTenantRestoreDef(ports).plan({ tenantId: "tnt_1", targetClusterId: TARGET.clusterId, generation }, { db: db.db });
    await expect(plan("20260101T000000Z")).rejects.toThrow(/has no backup generation 20260101T000000Z/);
    recordBackupStarted(db.db, { kind: "tenant", unit: GUID, stage: "prod", generation: "20260928T030000Z", folder: "x", trigger: "nightly", runId: "run_nightly" });
    await expect(plan("20260928T030000Z")).rejects.toThrow(/is taking — only a written and verified generation is restored/);
  });

  it("refuses a generation without a readable registration — a restore never guesses what the unit was", async () => {
    seedClusters(db);
    seedTenantRows(db, "offboarded");
    seedGeneration(db, "tenant", GUID);
    const f = makeFakes();
    const ports = tenantPorts(f);
    f.target.reader.setJobResult(`reloc-read-reg-${GUID}`, { succeeded: true, logs: "REGISTRATION-BEGIN\nREGISTRATION-END" });

    const params = { tenantId: "tnt_1", targetClusterId: TARGET.clusterId, generation: GENERATION };
    await expect(driveSteps(db, makeTenantRestoreDef(ports).steps(params), params, [])).rejects.toThrow(/no readable registration/);
  });
});

/** A consumer registration as a generation holds it, with `services` as the unit claimed them. */
function dumpedConsumer(services: ("mongodb" | "postgresql")[]): string {
  return serializePointer(ConsumerRegistrationSchema, {
    name: CONSUMER, repoURL: "https://github.com/x/acme.git", suspended: false, quiesced: false, removing: false,
    chartPath: "deploy/chart", host: "acme", cluster: "s1", databases: ["acme_db"], services, size: "medium", mongodb: "shared",
    quota: seedQuota("medium"),
  });
}

describe("restore (consumer)", () => {
  it("reconstructs an offboarded consumer: registration re-committed at the target from the dumped bytes, stores replayed, row active on the target", async () => {
    seedClusters(db);
    seedConsumerRow(db, "offboarded");
    seedGeneration(db, "consumer", CONSUMER);
    const f = makeFakes();
    const ports = consumerPorts(f);
    const dumped = serializePointer(ConsumerRegistrationSchema, {
      name: CONSUMER, repoURL: "https://github.com/x/acme.git", suspended: false, quiesced: false, removing: false,
      chartPath: "deploy/chart", host: "acme", cluster: "s1", databases: ["acme_db"], services: ["mongodb"], size: "medium", mongodb: "shared",
      quota: seedQuota("medium"),
    });
    scriptDumpedRegistration(f.target.reader, CONSUMER, dumped);

    const params = { appId: "app_1", targetClusterId: TARGET.clusterId, generation: GENERATION };
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
    expect(f.dns.record(`${CONSUMER}.${TARGET.domain}`, "CNAME")).toBe(TARGET.domain);
    const row = db.db.select().from(apps).where(eq(apps.id, "app_1")).get();
    expect(row?.status).toBe("active");
    expect(row?.clusterId).toBe(TARGET.clusterId);
  });

  it("restores a claim as the user the TARGET's workloads run as, not the one the old cluster used", async () => {
    seedClusters(db);
    seedConsumerRow(db, "offboarded");
    seedGeneration(db, "consumer", CONSUMER);
    const f = makeFakes();
    scriptDumpedRegistration(f.target.reader, CONSUMER, dumpedConsumer(["mongodb", "postgresql"]));
    // The offboard deleted the namespace on the old cluster, and that cluster may be gone for good: the
    // restore reads the claims off the generation and the target alone. This older generation still
    // carries the per-consumer PostgreSQL's tar, which restore-pg replaces and so is never extracted.
    f.source.reader.listPersistentVolumeClaims = async () => { throw new Error("the old cluster answers nothing"); };
    f.target.reader.setJobResult(`reloc-list-pvc-${CONSUMER}`, { succeeded: true, logs: "CLAIM postgres-data\nCLAIM queue-mta-0\nCLAIMS 2" });
    // The chart moved its MTA from 2000 to 1000: the target renders the new user, quiesced, before any
    // data is back. The target has no postgres-data claim yet, and the generation's tar of it is no
    // claim to put back, so it refuses nothing. cache-0 is newer than the generation, which holds no tar
    // of it, so nothing is extracted into it.
    f.target.reader.setClaims(`${CONSUMER}-prod`, ["queue-mta-0", "cache-0"], [{ claim: "queue-mta", ordinals: true, user: 1000, group: 1000 }, { claim: "cache", ordinals: true, user: 3000, group: 3000 }]);
    const params = { appId: "app_1", targetClusterId: TARGET.clusterId, generation: GENERATION };
    await driveSteps(db, makeRestoreDef(consumerPorts(f)).steps(params), params, []);
    const restore = f.target.reader.jobs.find((j) => j.spec.name === `reloc-restore-pvc-${CONSUMER}`);
    expect(restore?.spec.runAs).toEqual({ user: 1000, group: 1000 });
    expect(restore?.spec.pvcMounts?.map((m) => m.claimName)).toEqual(["queue-mta-0"]);
  });

  it("REFUSES, by name and before any store is written, a claim the generation holds and the restore has nowhere to write", async () => {
    seedClusters(db);
    seedConsumerRow(db, "offboarded");
    seedGeneration(db, "consumer", CONSUMER);
    const f = makeFakes();
    scriptDumpedRegistration(f.target.reader, CONSUMER, dumpedConsumer(["mongodb"]));
    // The offboard deleted the namespace on the old cluster, so no claim stands there, while the
    // generation still holds the claim's tar.
    f.target.reader.setJobResult(`reloc-list-pvc-${CONSUMER}`, { succeeded: true, logs: "CLAIM queue-mta-0\nCLAIMS 1" });
    const params = { appId: "app_1", targetClusterId: TARGET.clusterId, generation: GENERATION };
    await expect(driveSteps(db, makeRestoreDef(consumerPorts(f)).steps(params), params, [])).rejects.toThrow(/holds queue-mta-0, and no claim of that name stands in acme-prod on s2, so the restore stops/);
    expect(jobNames(f.target).filter((n) => n.startsWith("reloc-restore-"))).toEqual([]);
  });

  it("carries the attested fqdn and the SMTP entry of the dump into the re-committed registration", async () => {
    seedClusters(db);
    seedConsumerRow(db, "offboarded");
    seedGeneration(db, "consumer", CONSUMER);
    const f = makeFakes();
    const ports = consumerPorts(f);
    const smtpEntry = { service: "acme-mta", port: 2525 };
    // The relay target follows the sender onto the target cluster's tailnet address, read off its map.
    f.platformRepo.seed(f.platformRepo.booksBranch, clusterMapPath(TARGET.domain), SLAVE_MARKING_YAML.replace(`domain: ${SLAVE_FQDN}`, `domain: ${TARGET.domain}`).replace("clusterName: s1", `clusterName: ${TARGET.cluster}`).replace("apiHost: 100.64.0.11", "apiHost: 100.64.0.12"));
    const dumped = serializePointer(ConsumerRegistrationSchema, {
      name: CONSUMER, repoURL: "https://github.com/x/acme.git", suspended: false, quiesced: false, removing: false,
      chartPath: "deploy/chart", host: "acme", cluster: "s1", databases: ["acme_db"], services: ["mongodb"], size: "small", mongodb: "shared",
      quota: seedQuota("small"), fqdn: "shop.customer.test", smtpEntry,
    });
    scriptDumpedRegistration(f.target.reader, CONSUMER, dumped);
    const params = { appId: "app_1", targetClusterId: TARGET.clusterId, generation: GENERATION };
    await driveSteps(db, makeRestoreDef(ports).steps(params), params, []);
    const restored = await ports.registrations.readRegistration("prod", CONSUMER);
    expect(restored?.entry.fqdn).toBe("shop.customer.test");
    expect(restored?.entry.smtpEntry).toEqual(smtpEntry);
    expect(await ports.registrations.listSmtpSenders("prod")).toEqual([{ unit: CONSUMER, cluster: TARGET.cluster, entry: smtpEntry }]);
    expect(f.platformRepo.read(f.platformRepo.booksBranch, "installation/values/postfix-prod.yaml")).toContain("RELAYHOST: \"[100.64.0.12]:2525\"");
  });

  it("REFUSES a restore whose fqdn or mail sender another unit took while it was gone", async () => {
    const setup = async (other: { fqdn?: string; smtpEntry?: { service: string; port: number } }) => {
      seedClusters(db);
      seedConsumerRow(db, "offboarded");
      seedGeneration(db, "consumer", CONSUMER);
      const f = makeFakes();
      const ports = consumerPorts(f);
      f.platformRepo.seed(f.platformRepo.booksBranch, clusterMapPath(TARGET.domain), SLAVE_MARKING_YAML.replace(`domain: ${SLAVE_FQDN}`, `domain: ${TARGET.domain}`).replace("clusterName: s1", `clusterName: ${TARGET.cluster}`).replace("apiHost: 100.64.0.11", "apiHost: 100.64.0.12"));
      await ports.registrations.commitRegistration({
        unit: { name: "other", repoURL: "https://github.com/x/other.git", suspended: false, quiesced: false }, builds: [],
        deploy: { stage: "prod", chartPath: "deploy/chart", cluster: TARGET.cluster, host: "other", databases: [], keyPatterns: [], channelPatterns: [], services: [], size: "small", mongodb: "shared", quota: seedQuota("small"), ...other },
        runId: "run_other",
      });
      scriptDumpedRegistration(f.target.reader, CONSUMER, serializePointer(ConsumerRegistrationSchema, {
        name: CONSUMER, repoURL: "https://github.com/x/acme.git", suspended: false, quiesced: false, removing: false,
        chartPath: "deploy/chart", host: "acme", cluster: "s1", databases: ["acme_db"], services: ["mongodb"], size: "small", mongodb: "shared",
        quota: seedQuota("small"), fqdn: "shop.customer.test", smtpEntry: { service: "acme-mta", port: 2525 },
      }));
      const params = { appId: "app_1", targetClusterId: TARGET.clusterId, generation: GENERATION };
      return driveSteps(db, makeRestoreDef(ports).steps(params), params, []);
    };
    await expect(setup({ fqdn: "shop.customer.test" })).rejects.toThrow(/other now attests at prod/);
    db.sqlite.close();
    db = openFixtureDb();
    await expect(setup({ smtpEntry: { service: "other-mta", port: 2525 } })).rejects.toThrow(/which other is now/);
  });
});
