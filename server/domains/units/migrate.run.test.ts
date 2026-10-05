import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import type { DbHandle } from "../../db/client.ts";
import { apps, tenants } from "../../db/schema/inventory.ts";
import { CLAIM_RELOCATING_ANNOTATION } from "../../adapters/kube/port.ts";
import { makeMigrateDef, makeTenantMigrateDef } from "./migrate.run.ts";
import { repointStep } from "#unit/server/relocation-migrate.ts";
import { consumerWorld } from "./relocation-world-consumer.ts";
import { listBackups } from "../../db/unit-backups.ts";
import type { RoleManifest, RoleBindingManifest } from "../../adapters/kube/port.ts";
import { renderTenantArgoSync } from "#unit/server/build-rbac.ts";
import { publishIssuerRecord, tenantIssuerRecord } from "#unit/server/unit-dns.ts";
import {
  openFixtureDb, seedClusters, seedMaster, seedConsumerRow, seedTenantRows, seedConsumerRegistration, seedTenantWorld,
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
    seedMaster(db);
    seedClusters(db);
    seedConsumerRow(db);
    const f = makeFakes();
    const ports = consumerPorts(f);
    await seedConsumerRegistration(ports.registrations);
    // The unit's record already stands (the onboard created it) — the move must UPDATE it, not mint a pair.
    f.dns.seed(`${CONSUMER}.${TARGET.domain}`, "CNAME", SOURCE.domain);
    f.source.reader.setJobResult(`reloc-list-source-${CONSUMER}`, { succeeded: true, logs: "DB acme_db" });

    const params = { appId: "app_1", targetClusterId: TARGET.clusterId };
    let leavingAtRelease: string | undefined;
    await driveSteps(db, f, makeMigrateDef(ports).steps(params), params, [], {
      // After the repoint the source appset stops generating the Application — model exactly that.
      // The registration still NAMES the source in `leaving` here: the source's fences stand until
      // the Application is gone (hostyour-cloud#214).
      "verify-source-released": async () => {
        leavingAtRelease = (await ports.registrations.readRegistration("prod", CONSUMER))?.entry.leaving;
        f.source.argo.setStatus(missing);
      },
    });
    expect(leavingAtRelease).toBe(SOURCE.cluster);

    // The registration points at the target, is open again, and names no source any more — clear-source
    // took the name off, which is what prunes the source's fences.
    const reg = await ports.registrations.readRegistration("prod", CONSUMER);
    expect(reg?.entry.cluster).toBe(TARGET.cluster);
    expect(reg?.entry.quiesced).toBe(false);
    expect(reg?.entry.leaving).toBeUndefined();
    // ONE record, repointed in place onto the target cluster's name.
    const upsert = f.dns.upserts.find((u) => u.name === `${CONSUMER}.${TARGET.domain}`);
    expect(upsert).toEqual({ name: `${CONSUMER}.${TARGET.domain}`, type: "CNAME", content: TARGET.domain, created: false });
    // Dump ran on the source, restore + completeness on the target, the clear on the source — and
    // the clear came AFTER the target held everything (the job orders on each side say so).
    expect(jobNames(f.source)).toContain(`reloc-dump-mongo-${CONSUMER}`);
    expect(jobNames(f.target)).toContain(`reloc-restore-mongo-${CONSUMER}`);
    // The restore read the generation THIS move took, and that generation stays on the box as the
    // backup of the moment before the move: nothing of the clear reaches the box.
    const [taken, ...more] = listBackups(db.db, { kind: "consumer", unit: CONSUMER, stage: "prod" });
    expect(more).toEqual([]);
    expect(taken).toMatchObject({ trigger: "move", state: "ok", runId: "run_reloc" });
    expect(f.target.reader.jobs.find((j) => j.spec.name === `reloc-restore-mongo-${CONSUMER}`)?.spec.script).toContain(`box:${taken!.folder}/mongo/`);
    expect(f.source.reader.jobs.find((j) => j.spec.name === `reloc-clear-source-${CONSUMER}`)?.spec.script).not.toContain("box:");
    const sourceJobs = jobNames(f.source);
    expect(sourceJobs.indexOf(`reloc-clear-source-${CONSUMER}`)).toBeGreaterThan(sourceJobs.indexOf(`reloc-list-source-${CONSUMER}`));
    // The source namespace was marked relocating BEFORE the flip pruned the Application, so the
    // ServiceClaim teardown that the prune sets off kept the databases — which is why the listing in
    // verify-source-released could still find them. The TARGET namespace carries no such mark: the
    // mark means "leaving", and provision-target clears any left over from an earlier move away.
    expect(f.source.reader.namespaceAnnotations.get(`${CONSUMER}-prod`)?.[CLAIM_RELOCATING_ANNOTATION]).toBe("true");
    expect(f.target.reader.namespaceAnnotations.get(`${CONSUMER}-prod`)?.[CLAIM_RELOCATING_ANNOTATION]).toBeUndefined();
    // The source namespace fell with the clear (the per-consumer PostgreSQL and the PVCs go with it).
    expect(f.source.reader.deletedNamespaces).toContain(`${CONSUMER}-prod`);
    // The row settled LAST, onto the target.
    const row = db.db.select().from(apps).where(eq(apps.id, "app_1")).get();
    expect(row?.clusterId).toBe(TARGET.clusterId);
    expect(row?.status).toBe("active");
  });

  it("journey: a consumer with its own MongoDB and an empty databases[] moves whole — dumped from its own instance while it runs, restored on the target, the source cleared last", async () => {
    seedMaster(db);
    seedClusters(db);
    seedConsumerRow(db);
    const f = makeFakes();
    const ports = consumerPorts(f);
    await seedConsumerRegistration(ports.registrations, { mongodb: "replicaset", databases: [], services: [] });
    // The application asks for zero replicas; the own set keeps running, which the dump needs.
    f.source.reader.setSmoke({
      namespaceExists: true, externalSecretsReady: true,
      workloads: [{ kind: "Deployment", name: `${CONSUMER}-api`, available: true, desired: 0, ready: 0 }, { kind: "StatefulSet", name: "mongodb", available: true, desired: 3, ready: 3 }],
    });
    const params = { appId: "app_1", targetClusterId: TARGET.clusterId };
    let atClear: { restored: boolean; sourceStanding: boolean } | undefined;
    await driveSteps(db, f, makeMigrateDef(ports).steps(params), params, [], {
      "verify-source-released": async () => { f.source.argo.setStatus(missing); },
      "clear-source": async () => {
        atClear = { restored: jobNames(f.target).includes(`reloc-restore-mongo-${CONSUMER}`), sourceStanding: !f.source.reader.deletedNamespaces.includes(`${CONSUMER}-prod`) };
      },
    });
    const dump = f.source.reader.jobs.find((j) => j.spec.name === `reloc-dump-mongo-${CONSUMER}`);
    expect(dump?.namespace).toBe(`${CONSUMER}-prod`);
    expect(dump?.spec.script).toContain("listDatabases");
    expect(f.target.reader.jobs.find((j) => j.spec.name === `reloc-restore-mongo-${CONSUMER}`)?.namespace).toBe(`${CONSUMER}-prod`);
    expect(jobNames(f.target)).toContain(`reloc-verify-mongo-${CONSUMER}`);
    // Nothing touches the shared set: neither a listing nor a drop.
    expect(f.source.reader.jobs.filter((j) => j.namespace === "mongodb")).toEqual([]);
    expect(atClear).toEqual({ restored: true, sourceStanding: true });
    expect(f.source.reader.deletedNamespaces).toContain(`${CONSUMER}-prod`);
  });

  it("journey: a consumer with its own Redis moves whole — snapshot dumped while it runs, restored on the target by replication", async () => {
    seedMaster(db);
    seedClusters(db);
    seedConsumerRow(db);
    const f = makeFakes();
    const ports = consumerPorts(f);
    await seedConsumerRegistration(ports.registrations, { redis: "standalone", databases: [], services: ["redis"] });
    // The application asks for zero replicas; the own server and its exporter keep running, which the dump needs.
    f.source.reader.setSmoke({
      namespaceExists: true, externalSecretsReady: true,
      workloads: [
        { kind: "Deployment", name: `${CONSUMER}-api`, available: true, desired: 0, ready: 0 },
        { kind: "Deployment", name: "redis", available: true, desired: 1, ready: 1 },
        { kind: "Deployment", name: "redis-exporter", available: true, desired: 1, ready: 1 },
      ],
    });
    const params = { appId: "app_1", targetClusterId: TARGET.clusterId };
    await driveSteps(db, f, makeMigrateDef(ports).steps(params), params, [], {
      "verify-source-released": async () => { f.source.argo.setStatus(missing); },
    });
    const dump = f.source.reader.jobs.find((j) => j.spec.name === `reloc-dump-redis-${CONSUMER}`);
    expect([dump?.namespace, dump?.spec.script.includes("--rdb")]).toEqual([`${CONSUMER}-prod`, true]);
    const restore = f.target.reader.jobs.find((j) => j.spec.name === `reloc-restore-redis-${CONSUMER}`);
    expect([restore?.namespace, restore?.spec.script.includes("REPLICAOF")]).toEqual([`${CONSUMER}-prod`, true]);
  });
});

describe("verify-quiesced (consumer)", () => {
  // What a quiesced consumer that brings PostgreSQL runs: the store's chart keeps the database and its
  // metrics exporter, whose Deployment the upstream chart names after the Helm release, which is the
  // consumer's Application; the application itself asks for zero replicas.
  const deployment = (name: string, desired: number) => ({ kind: "Deployment", name, available: true, desired, ready: desired });
  const store = [deployment("postgres", 1), deployment(`${CONSUMER}-prod-prometheus-postgres-exporter`, 1)];

  async function verifyQuiesced(application: ReturnType<typeof deployment>[]): Promise<void> {
    seedMaster(db);
    seedClusters(db);
    seedConsumerRow(db);
    const f = makeFakes();
    const ports = consumerPorts(f);
    await seedConsumerRegistration(ports.registrations);
    f.source.reader.setSmoke({ namespaceExists: true, externalSecretsReady: true, workloads: [...store, ...application] });
    const params = { appId: "app_1", targetClusterId: TARGET.clusterId };
    const steps = makeMigrateDef(ports).steps(params);
    await driveSteps(db, f, steps.filter((s) => s.name === "quiesce" || s.name === "verify-quiesced"), params, []);
  }

  it("lets the store and its exporter run while the application asks for zero replicas", async () => {
    await expect(verifyQuiesced([deployment(`${CONSUMER}-api`, 0)])).resolves.toBeUndefined();
  });

  it("refuses an application workload that still runs", async () => {
    await expect(verifyQuiesced([deployment(`${CONSUMER}-api`, 1)])).rejects.toThrow(`still runs Deployment/${CONSUMER}-api (1/1)`);
  });

  it("refuses an application workload whose name only starts like the store's", async () => {
    await expect(verifyQuiesced([deployment("postgres-admin", 1)])).rejects.toThrow("still runs Deployment/postgres-admin (1/1)");
  });
});

describe("the consumer dump (hostyour-manager#333)", () => {
  it("dumps the claims as the user of the workload that mounts them", async () => {
    seedMaster(db);
    seedClusters(db);
    seedConsumerRow(db);
    const f = makeFakes();
    const ports = consumerPorts(f);
    await seedConsumerRegistration(ports.registrations);
    f.source.reader.setClaims(`${CONSUMER}-prod`, ["queue-mta-0"], [{ claim: "queue-mta", ordinals: true, user: 1000, group: 1000 }]);

    const ctx = stepCtx(db, "dump", {}, []);
    const jobs = await (await consumerWorld(ports, "app_1")(ctx)).dumpJobs("gen", "name: acme\n", ctx);
    expect(jobs.find((j) => j.spec.name.startsWith("reloc-dump-pvc"))?.spec.runAs).toEqual({ user: 1000, group: 1000 });
  });

  it("re-commits a dumped registration with each data part's size and volume pin, so the restored claims are the size they came from", async () => {
    seedMaster(db);
    seedClusters(db);
    seedConsumerRow(db);
    const f = makeFakes();
    const ports = consumerPorts(f);
    await seedConsumerRegistration(ports.registrations);
    const dumped = { ...(await ports.registrations.readRegistration("prod", CONSUMER))!.entry, services: ["postgresql" as const], mongodb: "standalone" as const, sizes: { postgresql: "large" as const, mongodb: "medium" as const }, volumes: { postgresql: "5Gi", mongodb: "40Gi" } };

    const ctx = stepCtx(db, "restore", {}, []);
    // JSON is YAML: the dump's registration file, as the restore reads it back.
    await (await consumerWorld(ports, "app_1")(ctx)).writeRegistrationFromDump(ctx, JSON.stringify(dumped), TARGET);
    const entry = (await ports.registrations.readRegistration("prod", CONSUMER))?.entry;
    expect([entry?.cluster, entry?.sizes, entry?.volumes]).toEqual([TARGET.cluster, dumped.sizes, dumped.volumes]);
  });

  it("refuses the dump of a claim no workload mounts, before any job runs", async () => {
    seedMaster(db);
    seedClusters(db);
    seedConsumerRow(db);
    const f = makeFakes();
    const ports = consumerPorts(f);
    await seedConsumerRegistration(ports.registrations);
    f.source.reader.setClaims(`${CONSUMER}-prod`, ["orphan"], []);

    const ctx = stepCtx(db, "dump", {}, []);
    await expect((await consumerWorld(ports, "app_1")(ctx)).dumpJobs("gen", "name: acme\n", ctx)).rejects.toThrow(/claim orphan .* is mounted by no workload/);
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
    await f.source.reader.deleteNamespace(`${CONSUMER}-prod`);

    await expect(repointStep(consumerWorld(ports, "app_1"), TARGET.clusterId).run(stepCtx(db, "repoint", {}, []))).rejects.toThrow(/nothing to annotate/);

    // The order is the whole safety property: the flip is what deletes the source Application and its
    // ServiceClaims, so it must never happen while the source teardown would still drop the databases.
    const reg = await ports.registrations.readRegistration("prod", CONSUMER);
    expect(reg?.entry.cluster).toBe(SOURCE.cluster);
  });
});

describe("tenant-migrate", () => {
  it("PLANTED DEFECT: provisions release access for current members and exact image builders, keeping the source grant", async () => {
    seedMaster(db);
    seedClusters(db);
    seedTenantRows(db);
    const f = makeFakes();
    const ports = tenantPorts(f);
    await seedTenantWorld(ports.registrations);
    const tag = "0.4.001-stable-20261004000000-abcdef1";
    f.platformRepo.seed(f.platformRepo.booksBranch, "charts/example-auth/pins-prod.yaml", `builds:\n  - {name: auth-backend, image: auth-backend, tag: ${tag}}\n`);
    f.platformRepo.seed(f.platformRepo.booksBranch, "charts/example-engine/pins-prod.yaml", `builds:\n  - {name: engine, image: engine, tag: ${tag}}\n`);
    await ports.registrations.setTenantAppsRepo("prod", GUID, { appsRepo: "https://github.com/acme/bundle.git", appsImage: "bundle", appsImageTag: tag }, "run_bundle");
    ports.attestedBuilds = async () => [{ unit: "auth", build: "auth-backend" }, { unit: "platform", build: "engine" }, { unit: "bundle", build: "bundle" }, { unit: "unrelated", build: "another-image" }];
    const resolver = ports.resolver;
    ports.resolver = { resolve: async (id) => ({ ...await resolver.resolve(id), argoNamespace: id === SOURCE.clusterId ? "source-argo" : "target-argo" }) };
    const apps = ["auth", "jobs", "report", "web"].map((m) => `${GUID}-${m}-prod`);
    await f.buildRbac.applyBuildRbac([renderTenantArgoSync({ stage: "prod", guid: GUID, applications: apps, argoNamespace: "source-argo", units: ["auth", "platform", "bundle"] })]);
    const sourceBinding = f.buildRbac.get("RoleBinding", "source-argo", `${GUID}-argo-sync`);
    const p = { tenantId: "tnt_1", stage: "prod" as const, sourceClusterId: SOURCE.clusterId, targetClusterId: TARGET.clusterId };
    const step = makeTenantMigrateDef(ports).steps(p).find((s) => s.name === "provision-target")!;
    await step.run(stepCtx(db, step.name, p, []));
    const role = f.buildRbac.get("Role", "target-argo", `${GUID}-argo-sync`) as RoleManifest;
    const binding = f.buildRbac.get("RoleBinding", "target-argo", `${GUID}-argo-sync`) as RoleBindingManifest;
    expect(role.rules[0]?.resourceNames).toEqual(apps);
    expect(binding.subjects.map((s) => s.namespace)).toEqual(["auth-build", "bundle-build", "platform-build"]);
    expect(f.buildRbac.get("RoleBinding", "source-argo", `${GUID}-argo-sync`)).toEqual(sourceBinding);
  });

  it("switch-dns repoints the identity provider's issuer host beside the wildcard, where the tenant has a host-routed mark", async () => {
    seedMaster(db);
    seedClusters(db);
    seedTenantRows(db);
    const f = makeFakes();
    const ports = tenantPorts(f);
    await seedTenantWorld(ports.registrations);
    const params = { tenantId: "tnt_1", stage: "prod" as const, sourceClusterId: SOURCE.clusterId, targetClusterId: TARGET.clusterId };
    const switchDns = makeTenantMigrateDef(ports).steps(params).find((s) => s.name === "switch-dns")!;
    const issuerHost = `auth.${SUBDOMAIN}.example.com`;

    // PLANTED INNOCENT: a tenant without a mark gets no record at the issuer host.
    await switchDns.run(stepCtx(db, switchDns.name, params, []));
    expect(f.dns.record(issuerHost, "CNAME")).toBeUndefined();

    const mark = tenantIssuerRecord("_digita-idp", "host", "auth", "prod", SUBDOMAIN, "example.com");
    await publishIssuerRecord(stepCtx(db, "provision-dns", {}, []), { dns: f.dns, guid: GUID, stage: "prod", record: mark, clusterFqdn: SOURCE.domain, runKind: "tenant-create" });
    expect(f.dns.record(issuerHost, "CNAME")).toBe(SOURCE.domain);
    await switchDns.run(stepCtx(db, switchDns.name, params, []));
    expect(f.dns.record(`*.${SUBDOMAIN}.example.com`, "CNAME")).toBe(TARGET.domain);
    expect(f.dns.record(issuerHost, "CNAME")).toBe(TARGET.domain);
  });

  it("journey: a tenant with Garage object storage is moved whole — bucket dumped and restored, source CR released via the relocating annotation, source cleared last", async () => {
    seedMaster(db);
    seedClusters(db);
    seedTenantRows(db);
    const f = makeFakes();
    const ports = tenantPorts(f);
    await seedTenantWorld(ports.registrations);
    f.source.reader.setJobResult(`reloc-list-source-${GUID}`, { succeeded: true, logs: `DB ${GUID}_auth_prod\nDB ${GUID}_web_prod` });

    const def = makeTenantMigrateDef(ports);
    const plan = await def.plan({ tenantId: "tnt_1", stage: "prod" as const, sourceClusterId: SOURCE.clusterId, targetClusterId: TARGET.clusterId }, { db: db.db });
    expect(plan.steps.map((s) => s.name)).toEqual(STEP_ORDER);

    f.target.reader.setSecretValue(`${GUID}-auth-prod`, "hostyour-app-secrets", "AUTH_JWT_PUBLIC_KEY", "-----BEGIN PUBLIC KEY-----");
    const params = { tenantId: "tnt_1", stage: "prod" as const, sourceClusterId: SOURCE.clusterId, targetClusterId: TARGET.clusterId };
    await driveSteps(db, f, def.steps(params), params, [], {
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
      expect(f.source.reader.namespaceAnnotations.get(`${GUID}-${member}-prod`)?.[CLAIM_RELOCATING_ANNOTATION]).toBe("true");
    }
    // The target got the whole isolation: every member AppProject + the CR.
    for (const member of ["auth", "jobs", "report", "web"]) {
      expect(f.target.projects.get(TARGET.cluster, `${GUID}-${member}-prod`)).toBeDefined();
    }
    // The GARAGE bucket rode every phase: dumped on the source, restored + counted on the target.
    expect(jobNames(f.source)).toContain(`reloc-dump-bucket-${GUID}`);
    expect(jobNames(f.target)).toContain(`reloc-restore-bucket-${GUID}`);
    expect(jobNames(f.target)).toContain(`reloc-verify-bucket-${GUID}`);
    // ONE wildcard record now points at the target.
    expect(f.dns.record(`*.${SUBDOMAIN}.example.com`, "CNAME")).toBe(TARGET.domain);
    // The source fell LAST: databases dropped (the clear job), namespaces reaped. The generation the
    // move took stays on the box.
    expect(jobNames(f.source)).toContain(`reloc-clear-source-${GUID}`);
    expect(listBackups(db.db, { kind: "tenant", unit: GUID, stage: "prod" }).map((b) => [b.trigger, b.state])).toEqual([["move", "ok"]]);
    for (const member of ["auth", "jobs", "report", "web"]) {
      expect(f.source.reader.deletedNamespaces).toContain(`${GUID}-${member}-prod`);
    }
    // The row settled LAST, onto the target.
    const row = db.db.select().from(tenants).where(eq(tenants.id, "tnt_1")).get();
    expect(row?.clusterId).toBe(TARGET.clusterId);
    expect(row?.status).toBe("active");
  });

  it("journey: an injected restore failure leaves the source fully intact — nothing cleared, nothing recorded, the generation survives", async () => {
    seedMaster(db);
    seedClusters(db);
    seedTenantRows(db);
    const f = makeFakes();
    const ports = tenantPorts(f);
    await seedTenantWorld(ports.registrations);
    f.source.reader.setJobResult(`reloc-list-source-${GUID}`, { succeeded: true, logs: `DB ${GUID}_auth_prod` });
    f.target.reader.setJobResult(`reloc-restore-mongo-${GUID}`, { succeeded: false, logs: "mongorestore: disk full" });

    const params = { tenantId: "tnt_1", stage: "prod" as const, sourceClusterId: SOURCE.clusterId, targetClusterId: TARGET.clusterId };
    await expect(
      driveSteps(db, f, makeTenantMigrateDef(ports).steps(params), params, [], {
        "verify-source-released": () => f.source.argo.setStatuses(new Map()),
      }),
    ).rejects.toThrow(/disk full/);

    // clear-source never ran: the source databases are untouched, no source namespace fell, and the
    // inventory still names the source cluster. The verified generation stays a backup.
    expect(jobNames(f.source).find((n) => n.startsWith("reloc-clear-source"))).toBeUndefined();
    expect(f.source.reader.deletedNamespaces).toEqual([]);
    const row = db.db.select().from(tenants).where(eq(tenants.id, "tnt_1")).get();
    expect(row?.clusterId).toBe(SOURCE.clusterId);
    expect(listBackups(db.db, { kind: "tenant", unit: GUID, stage: "prod" }).map((b) => b.state)).toEqual(["ok"]);
  });
});
