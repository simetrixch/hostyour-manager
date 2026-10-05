import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DbHandle } from "../../db/client.ts";
import { runRelocationJob } from "#unit/server/relocation.ts";
import {
  boxSecretName, jobReadsBoxSecret,
  verifyDumpJob, readRegistrationJob, writeManifestJob, purgeGenerationJob,
  generationId, generationFolder, generationManifest, hashLine, parseSha256Lines,
  type RelocationJob,
} from "#unit/server/relocation-jobs.ts";
import {
  tenantDumpJobs, tenantRestoreJobs, tenantVerifyCompletenessJobs, tenantClearSourceJobs, tenantSourceDbListJob,
} from "./relocation-jobs-tenant.ts";
import {
  consumerDumpJobs, consumerRestoreJobs, consumerVerifyCompletenessJobs, consumerClearSourceJobs, consumerSourceDbListJob, claimsIdentity, consumerExpectedDumpEntries, extractClaimLine,
} from "./relocation-jobs-consumer.ts";
import type { ConsumerService } from "../../../shared/consumer.ts";
import { openFixtureDb, seedClusters, makeFakes, consumerPorts, stepCtx, SOURCE } from "./relocation.fixture.ts";

// The credential shape of the relocation Jobs. A relocation job needs the Storage Box, and the box
// credential is the ONE credential that does not already stand on the cluster — it comes from the
// Manager's own env. It must still never be written onto the jobSpec: the Job object and the pod it
// renders live in a unit's OWN namespace, readable to anything holding `get jobs` / `get pods` there,
// and the Job outlasts its run by its TTL. So every job references a Secret in its own namespace and
// runRelocationJob is what places that Secret and takes it away again.

let db: DbHandle;
beforeEach(() => { db = openFixtureDb(); });
afterEach(() => { db.sqlite.close(); });

const IMAGE = "registrations.example/dbtools:1.0.0";
const GUID = "zsjs023ctne0";
const CONSUMER = "acme";
const TENANT_FOLDER = `master.example/prod/tenants/${GUID}/20260928T030000Z`;
const CONSUMER_FOLDER = `master.example/prod/consumers/${CONSUMER}/20260928T030000Z`;
const ALL_SERVICES: ConsumerService[] = ["mongodb", "postgresql"];

/** Every job every relocation phase builds, both kinds of unit, with each optional store PRESENT —
 *  a tenant with an app member (so the bucket phase renders) and a consumer claiming every store it
 *  can. A job hidden behind an absent claim carries no credential, so the maximal shape is the one
 *  worth asserting over. */
function everyJob(): RelocationJob[] {
  const tenant = { guid: GUID, folder: TENANT_FOLDER, stage: "prod" as const, apps: ["web"], image: IMAGE , identityProvider: "auth" };
  const consumer = { name: CONSUMER, folder: CONSUMER_FOLDER, stage: "prod" as const, namespace: `${CONSUMER}-prod`, databases: ["acme_main"], services: ALL_SERVICES, mongodb: "shared" as const, pvcs: ["data"], image: IMAGE };
  return [
    ...tenantDumpJobs({ ...tenant, registrationYaml: "guid: zsjs023ctne0\n" }),
    ...tenantRestoreJobs(tenant),
    ...tenantVerifyCompletenessJobs(tenant),
    ...tenantClearSourceJobs({ guid: GUID, stage: "prod", image: IMAGE }),
    tenantSourceDbListJob({ guid: GUID, stage: "prod", image: IMAGE }),
    ...consumerDumpJobs({ ...consumer, registrationYaml: "name: acme\n" }),
    ...consumerRestoreJobs(consumer),
    ...consumerVerifyCompletenessJobs(consumer),
    ...consumerClearSourceJobs({ name: CONSUMER, stage: "prod", databases: consumer.databases, services: ALL_SERVICES, mongodb: "shared", image: IMAGE }),
    consumerSourceDbListJob({ name: CONSUMER, stage: "prod", databases: consumer.databases, services: ALL_SERVICES, mongodb: "shared", image: IMAGE })!,
    verifyDumpJob({ unit: CONSUMER, folder: CONSUMER_FOLDER, namespace: CONSUMER, expected: ["registration.yaml"], image: IMAGE }),
    readRegistrationJob({ unit: CONSUMER, folder: CONSUMER_FOLDER, namespace: "mongodb", image: IMAGE }),
    writeManifestJob({ unit: CONSUMER, folder: CONSUMER_FOLDER, namespace: CONSUMER, manifest: "UNIT=acme", image: IMAGE }),
    purgeGenerationJob({ unit: CONSUMER, folder: CONSUMER_FOLDER, namespace: "mongodb", image: IMAGE }),
  ];
}

describe("backup generations (hostyour-cloud#254)", () => {
  it("names a generation by its UTC moment and places it under the installation, the stage and the kind", () => {
    const generation = generationId(new Date("2026-09-28T03:00:07.412Z"));
    expect(generation).toBe("20260928T030007Z");
    expect(generationFolder({ installation: "master.example", stage: "prod", kind: "tenant", unit: GUID, generation })).toBe(`master.example/prod/tenants/${GUID}/20260928T030007Z`);
    expect(generationFolder({ installation: "master.example", stage: "test", kind: "consumer", unit: CONSUMER, generation })).toBe(`master.example/test/consumers/${CONSUMER}/20260928T030007Z`);
  });

  it("every box path a job names lies inside its own generation, so no job can touch another generation", () => {
    for (const job of everyJob()) {
      for (const path of job.spec.script.match(/box:[^"\s]*/g) ?? []) {
        expect([`box:${TENANT_FOLDER}`, `box:${CONSUMER_FOLDER}`].some((f) => path.startsWith(f)), `${job.spec.name} names ${path}`).toBe(true);
      }
    }
  });

  it("carries a hashed file's checksum from the job log into the manifest, in the form sha256sum -c reads", () => {
    const hash = "a".repeat(64);
    expect(hashLine("/tmp/$db.archive", "mongo/$db.archive")).toContain(`sha256sum "/tmp/$db.archive"`);
    const sums = parseSha256Lines(`DB acme_main\nSHA256 ${hash}  mongo/acme_main.archive\nSHA256 not-a-hash  x\n`);
    expect(sums).toEqual([`${hash}  mongo/acme_main.archive`]);
    const manifest = generationManifest({ unit: CONSUMER, kind: "consumer", stage: "prod", generation: "20260928T030000Z", trigger: "manual", runId: "run_1", installation: "master.example", stores: ["registration.yaml", "mongo"] }, sums);
    expect(manifest.split("\n")).toEqual([
      "INSTALLATION=master.example", "KIND=consumer", "UNIT=acme", "STAGE=prod", "GENERATION=20260928T030000Z", "TRIGGER=manual", "RUN=run_1", "STORES=registration.yaml,mongo",
      `${hash}  mongo/acme_main.archive`,
    ]);
  });

  it("a move's clear-source drops the source databases and leaves the box alone", () => {
    const jobs = [...tenantClearSourceJobs({ guid: GUID, stage: "prod", image: IMAGE }), ...consumerClearSourceJobs({ name: CONSUMER, stage: "prod", databases: ["acme_main"], services: ALL_SERVICES, mongodb: "shared", image: IMAGE })];
    expect(jobs).toHaveLength(2);
    for (const job of jobs) {
      expect(job.spec.script).not.toContain("box:");
      expect(jobReadsBoxSecret(job.spec)).toBe(false);
    }
    // A consumer without a Mongo database has nothing a job must drop.
    expect(consumerClearSourceJobs({ name: CONSUMER, stage: "prod", databases: [], services: ["postgresql"], mongodb: "shared", image: IMAGE })).toEqual([]);
  });
});

describe("relocation job credentials", () => {
  it("no jobSpec of any phase carries a literal credential value — every env value is a name or a coordinate", () => {
    // The allow-list is what a manifest reader may see: the platform's own service coordinates. Any
    // OTHER literal env value on a relocation job is a credential leak by construction, because the
    // only other things these jobs need are passwords and keys.
    const openCoordinates = ["MONGO_HOST", "S3_ENDPOINT"];
    for (const job of everyJob()) {
      for (const env of job.spec.env ?? []) {
        if (env.value === undefined) continue;
        expect(openCoordinates, `${job.spec.name} carries a literal ${env.name}`).toContain(env.name);
      }
    }
  });

  it("every job that reaches the box reads the three box variables off a Secret named after that job", () => {
    const boxJobs = everyJob().filter((j) => jobReadsBoxSecret(j.spec));
    // All but the two source LISTINGS and the two clear-source drops reach the box; those only touch
    // a database.
    expect(boxJobs.length).toBe(everyJob().length - 4);
    for (const job of boxJobs) {
      const refs = (job.spec.env ?? []).filter((e) => e.name.startsWith("STORAGE_BOX_"));
      expect(refs.map((e) => e.name).sort()).toEqual(["STORAGE_BOX_HOST", "STORAGE_BOX_PASSWORD", "STORAGE_BOX_USER"]);
      for (const ref of refs) {
        expect(ref.value).toBeUndefined();
        expect(ref.secretKeyRef).toEqual({ name: boxSecretName(job.spec.name), key: ref.name });
      }
    }
  });

  it("the box Secret is named per JOB, so two units relocating at once in the shared mongodb namespace cannot reap each other's", () => {
    const dumpOf = (guid: string) => tenantDumpJobs({ guid, folder: `master.example/prod/tenants/${guid}/20260928T030000Z`, stage: "prod", apps: [], image: IMAGE, identityProvider: "auth", registrationYaml: "" })[0]!;
    const mine = dumpOf(GUID);
    const theirs = dumpOf("other0000000");
    expect(mine.namespace).toBe(theirs.namespace);
    expect(boxSecretName(mine.spec.name)).not.toBe(boxSecretName(theirs.spec.name));
  });

  it("a job whose env names no box Secret is left alone — the listings get no credential placed in their namespace", () => {
    const listing = tenantSourceDbListJob({ guid: GUID, stage: "prod", image: IMAGE });
    expect(jobReadsBoxSecret(listing.spec)).toBe(false);
  });
});

describe("runRelocationJob places and reaps the box credential", () => {
  it("the credential STANDS while the job runs and is gone afterwards", async () => {
    const f = makeFakes();
    const ports = consumerPorts(f);
    const job = verifyDumpJob({ unit: CONSUMER, folder: CONSUMER_FOLDER, namespace: CONSUMER, expected: ["registration.yaml"], image: IMAGE });
    await runRelocationJob(ports, stepCtx(db, "verify-dump", {}, []), SOURCE.clusterId, job);

    const secret = boxSecretName(job.spec.name);
    // Resolvable AT RUN TIME with the credential the Manager carries...
    expect(f.source.reader.jobs[0]?.secretsAtRun.get(`${CONSUMER}/${secret}`)).toEqual({
      STORAGE_BOX_HOST: "box.example",
      STORAGE_BOX_USER: "u100",
      STORAGE_BOX_PASSWORD: "box-secret",
    });
    // ...and gone once the job settled: the window is the run, not the Job's TTL.
    expect(f.source.reader.secrets.has(`${CONSUMER}/${secret}`)).toBe(false);
    expect(f.source.reader.secretWrites).toEqual([
      { op: "apply", namespace: CONSUMER, name: secret },
      { op: "delete", namespace: CONSUMER, name: secret },
    ]);
  });

  it("the credential is reaped even when the job FAILS — the run's error is what surfaces, not a leftover", async () => {
    const f = makeFakes();
    const ports = consumerPorts(f);
    const job = verifyDumpJob({ unit: CONSUMER, folder: CONSUMER_FOLDER, namespace: CONSUMER, expected: ["registration.yaml"], image: IMAGE });
    f.source.reader.setJobResult(job.spec.name, { succeeded: false, logs: "MISSING registration.yaml" });

    await expect(runRelocationJob(ports, stepCtx(db, "verify-dump", {}, []), SOURCE.clusterId, job)).rejects.toThrow(/did not succeed/);
    expect(f.source.reader.secrets.size).toBe(0);
  });

  it("an unwired Storage Box stops the job BEFORE it is created, rather than starting a pod that cannot resolve its Secret", async () => {
    const f = makeFakes();
    const ports = consumerPorts(f);
    delete (ports as { storageBox?: unknown }).storageBox;
    const job = verifyDumpJob({ unit: CONSUMER, folder: CONSUMER_FOLDER, namespace: CONSUMER, expected: ["registration.yaml"], image: IMAGE });

    await expect(runRelocationJob(ports, stepCtx(db, "verify-dump", {}, []), SOURCE.clusterId, job)).rejects.toThrow(/requires the Hetzner Storage Box/);
    expect(f.source.reader.jobs).toEqual([]);
    expect(f.source.reader.secrets.size).toBe(0);
  });

  it("a job that needs no box credential has none placed in its namespace", async () => {
    // The listing dials the cluster's shared Mongo, which runRelocationJob reads off that cluster's row.
    seedClusters(db);
    const f = makeFakes();
    const ports = consumerPorts(f);
    const listing = tenantSourceDbListJob({ guid: GUID, stage: "prod", image: IMAGE });
    await runRelocationJob(ports, stepCtx(db, "verify-source-released", {}, []), SOURCE.clusterId, listing);

    expect(f.source.reader.secretWrites).toEqual([]);
    expect(f.source.reader.jobs[0]?.secretsAtRun.size).toBe(0);
  });
});

describe("the nightly backup under pod security restricted (hostyour-manager#333)", () => {
  const consumer = { name: CONSUMER, folder: CONSUMER_FOLDER, stage: "prod" as const, namespace: `${CONSUMER}-prod`, databases: ["acme_main"], services: ALL_SERVICES, mongodb: "shared" as const, pvcs: ["data"], image: IMAGE };
  const pvcJob = (jobs: RelocationJob[]): RelocationJob => jobs.find((j) => j.spec.name.startsWith("reloc-dump-pvc"))!;

  it("a claim is dumped as the user of the pod that mounts it", () => {
    // queue-digita-post-mta-0 is mounted by a pod running as 1000, postgres-data of swissbookai by one
    // running as 999; a job running as anyone else cannot read what only they may read.
    const identity = claimsIdentity(`${CONSUMER}-prod`, ["data"], [{ claim: "data", ordinals: false, user: 999, group: 999 }]);
    expect(identity).toEqual({ user: 999, group: 999 });
    expect(pvcJob(consumerDumpJobs({ ...consumer, pvcUser: identity, registrationYaml: "name: acme\n" })).spec.runAs).toEqual({ user: 999, group: 999 });
  });

  it("a claim no running pod mounts is refused by name", () => {
    expect(() => claimsIdentity(`${CONSUMER}-prod`, ["data"], [{ claim: "other", ordinals: false, user: 1000, group: 1000 }])).toThrow(/claim data in .* is mounted by no workload/);
  });

  it("claims used as two different users are refused, because one job reads as one user", () => {
    const users = [{ claim: "a", ordinals: false, user: 1000, group: 1000 }, { claim: "b", ordinals: false, user: 999, group: 999 }];
    expect(() => claimsIdentity(`${CONSUMER}-prod`, ["a", "b"], users)).toThrow(/1000:1000 and 999:999/);
  });

  it("a StatefulSet pod's claim is matched by its ordinal, and a look-alike name is not", () => {
    const stem = [{ claim: "queue-digita-post-mta", ordinals: true, user: 1000, group: 1000 }];
    expect(claimsIdentity("ns", ["queue-digita-post-mta-0"], stem)).toEqual({ user: 1000, group: 1000 });
    expect(() => claimsIdentity("ns", ["queue-digita-post-mta-old"], stem)).toThrow(/mounted by no workload/);
  });

  it("a live claim that changed while tar read it is reported, and any other tar failure still fails", () => {
    const script = pvcJob(consumerDumpJobs({ ...consumer, pvcUser: { user: 999, group: 999 }, registrationYaml: "name: acme\n" })).spec.script;
    expect(script).toContain('|| { s=$?; [ "$s" -eq 1 ] || exit "$s"; echo "CHANGED pvc/data: files changed while tar read them"; }');
  });

  it("THE INNOCENT NEIGHBOUR: the other dump jobs keep the runner's default identity", () => {
    const jobs = consumerDumpJobs({ ...consumer, pvcUser: { user: 999, group: 999 }, registrationYaml: "name: acme\n" });
    expect(jobs.filter((j) => j !== pvcJob(jobs)).every((j) => j.spec.runAs === undefined)).toBe(true);
  });

  it("the Mongo dump names each database before it dumps it, and a failed dump leaves its exit code", () => {
    // A dump that stopped after 20 of 37 databases left no line saying which one it stopped on.
    const tenantMongo = tenantDumpJobs({ guid: GUID, folder: TENANT_FOLDER, stage: "prod", apps: ["web"], image: IMAGE, identityProvider: "auth", registrationYaml: "guid: x\n" })
      .find((j) => j.spec.name.startsWith("reloc-dump-mongo"))!;
    expect(tenantMongo.spec.script).toContain('echo "DUMP $db"');
    expect(tenantMongo.spec.script).toContain('echo "FAILED mongodump $db, exit $s"');
    expect(tenantMongo.spec.script).toContain('exit "$s"');
  });

  it("a failed job's error names why its pod ended", async () => {
    const f = makeFakes();
    const ports = consumerPorts(f);
    const job = verifyDumpJob({ unit: CONSUMER, folder: CONSUMER_FOLDER, namespace: CONSUMER, expected: ["registration.yaml"], image: IMAGE });
    f.source.reader.setJobResult(job.spec.name, { succeeded: false, logs: "", ended: "no pod was created for the Job — violates PodSecurity" });

    await expect(runRelocationJob(ports, stepCtx(db, "verify-dump", {}, []), SOURCE.clusterId, job)).rejects.toThrow(
      /did not succeed: no pod was created for the Job — violates PodSecurity \(no log collected\)/,
    );
  });
});

/** Whether `path` is a directory root owns that every user may write, like the root a hostpath volume
 *  hands a pod, and this process is not root: the state the restore meets. */
function rootOwnedAndWritable(path: string): boolean {
  try {
    const st = statSync(path);
    return st.isDirectory() && st.uid === 0 && (st.mode & 0o777) === 0o777 && process.getuid?.() !== 0;
  } catch {
    return false;
  }
}

describe("restoring a consumer's claims", () => {
  const consumer = { name: CONSUMER, folder: CONSUMER_FOLDER, stage: "prod" as const, namespace: `${CONSUMER}-prod`, databases: ["acme_main"], services: ALL_SERVICES, mongodb: "shared" as const, pvcs: ["data"], image: IMAGE };
  const named = (jobs: RelocationJob[], prefix: string): RelocationJob | undefined => jobs.find((j) => j.spec.name.startsWith(prefix));

  it("leaves the per-consumer PostgreSQL's own claim out of the tars, because pg_dumpall takes its databases whole", () => {
    const withPg = { ...consumer, pvcs: ["postgres-data", "queue-mta-0"], pvcUser: { user: 1000, group: 1000 } };
    expect(ALL_SERVICES).toContain("postgresql");
    expect(named(consumerDumpJobs({ ...withPg, registrationYaml: "name: acme\n" }), "reloc-dump-pvc")?.spec.pvcMounts?.map((m) => m.claimName)).toEqual(["queue-mta-0"]);
    expect(named(consumerRestoreJobs(withPg), "reloc-restore-pvc")?.spec.pvcMounts?.map((m) => m.claimName)).toEqual(["queue-mta-0"]);
    // Its claim alone: no tar is taken, and no pvc entry is demanded of the generation.
    const onlyPg = { ...consumer, pvcs: ["postgres-data"] };
    expect(named(consumerDumpJobs({ ...onlyPg, registrationYaml: "name: acme\n" }), "reloc-dump-pvc")).toBeUndefined();
    expect(named(consumerRestoreJobs(onlyPg), "reloc-restore-pvc")).toBeUndefined();
    expect(consumerExpectedDumpEntries(onlyPg)).not.toContain("pvc");
  });

  it("PLANTED INNOCENT: a unit without the per-consumer PostgreSQL tars a claim of that name like any other", () => {
    const own = { ...consumer, services: ALL_SERVICES.filter((s) => s !== "postgresql"), pvcs: ["postgres-data"] };
    expect(named(consumerDumpJobs({ ...own, registrationYaml: "name: acme\n" }), "reloc-dump-pvc")?.spec.pvcMounts?.map((m) => m.claimName)).toEqual(["postgres-data"]);
    expect(consumerExpectedDumpEntries(own)).toContain("pvc");
  });

  it("restores a claim as the user it is handed, and leaves the claim root as the volume made it", () => {
    const restore = named(consumerRestoreJobs({ ...consumer, pvcs: ["queue-mta-0"], pvcUser: { user: 1000, group: 1000 } }), "reloc-restore-pvc")!;
    expect(restore.spec.runAs).toEqual({ user: 1000, group: 1000 });
    expect(restore.spec.script).toContain(extractClaimLine("/tmp/queue-mta-0.tar.gz", "/pvc/queue-mta-0"));
    expect(extractClaimLine("/tmp/a.tar.gz", "/pvc/a")).toBe('tar xzf "/tmp/a.tar.gz" -C "/pvc/a" --no-overwrite-dir --preserve-permissions');
  });

  // Root keeps an archive's modes by default; the restore job never runs as root.
  it.skipIf(process.getuid?.() === 0)("keeps the archive's modes as the running user, where the umask takes group write and setgid without the flag", () => {
    const source = mkdtempSync(join(tmpdir(), "claim-src-"));
    const box = mkdtempSync(join(tmpdir(), "claim-box-"));
    try {
      mkdirSync(join(source, "spool"));
      chmodSync(join(source, "spool"), 0o2770);
      writeFileSync(join(source, "spool", "queued"), "a mail\n");
      chmodSync(join(source, "spool", "queued"), 0o660);
      const archive = join(box, "claim.tar.gz");
      execFileSync("tar", ["czf", archive, "-C", source, "."]);
      const modesAfter = (line: (root: string) => string): string[] => {
        const root = mkdtempSync(join(tmpdir(), "claim-root-"));
        try {
          execFileSync("sh", ["-c", `umask 022; ${line(root)}`], { stdio: "pipe" });
          return [join(root, "spool"), join(root, "spool", "queued")].map((path) => (statSync(path).mode & 0o7777).toString(8));
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      };
      expect(modesAfter((root) => `tar xzf "${archive}" -C "${root}" --no-overwrite-dir`)).not.toEqual(["2770", "660"]);
      expect(modesAfter((root) => extractClaimLine(archive, root))).toEqual(["2770", "660"]);
    } finally {
      rmSync(source, { recursive: true, force: true });
      rmSync(box, { recursive: true, force: true });
    }
  });

  it.skipIf(!rootOwnedAndWritable("/tmp"))("extracts into an existing root-owned claim root as the running user, where the extract without the flag fails", () => {
    const source = mkdtempSync(join(tmpdir(), "claim-src-"));
    const box = mkdtempSync(join(tmpdir(), "claim-box-"));
    const name = `claim-probe-${process.pid}-${Date.now()}.txt`;
    try {
      writeFileSync(join(source, name), "a row\n");
      const archive = join(box, "claim.tar.gz");
      execFileSync("tar", ["czf", archive, "-C", source, "."]);
      // The line as it stood: tar sets the mode and the time of the root it extracts into, and as a
      // user that is not root's it may not.
      expect(() => execFileSync("sh", ["-c", `tar xzf "${archive}" -C /tmp`], { stdio: "pipe" })).toThrow(/Cannot (utime|change mode)/);
      rmSync(join("/tmp", name), { force: true });
      execFileSync("sh", ["-c", extractClaimLine(archive, "/tmp")], { stdio: "pipe" });
      expect(statSync(join("/tmp", name)).uid).toBe(process.getuid?.());
    } finally {
      rmSync(join("/tmp", name), { force: true });
      rmSync(source, { recursive: true, force: true });
      rmSync(box, { recursive: true, force: true });
    }
  });
});

describe("a consumer's own MongoDB", () => {
  const base = { name: CONSUMER, folder: CONSUMER_FOLDER, stage: "prod" as const, namespace: `${CONSUMER}-prod`, databases: ["acme_main"], services: ["mongodb"] as ConsumerService[], pvcs: ["data-mongodb-0", "data-mongodb-1", "data-mongodb-2", "uploads"], image: IMAGE };
  const own = { ...base, mongodb: "replicaset" as const };
  const shared = { ...base, mongodb: "shared" as const };
  const mongoJobs = (i: typeof own | typeof shared): RelocationJob[] =>
    [...consumerDumpJobs({ ...i, registrationYaml: "name: acme\n" }), ...consumerRestoreJobs(i), ...consumerVerifyCompletenessJobs(i)].filter((j) => /^reloc-(dump|restore|verify)-mongo/.test(j.spec.name));
  const host = (j: RelocationJob): string | undefined => j.spec.env?.find((e) => e.name === "MONGO_HOST")?.value;

  it("dumps, restores and verifies against the set in the consumer's own namespace", () => {
    const jobs = mongoJobs(own);
    expect(jobs.map((j) => j.spec.name.split("-").slice(0, 3).join("-"))).toEqual(["reloc-dump-mongo", "reloc-restore-mongo", "reloc-verify-mongo"]);
    for (const j of jobs) {
      expect(j.namespace).toBe(`${CONSUMER}-prod`);
      expect(host(j)).toBe(`rs0/mongodb-headless.${CONSUMER}-prod.svc.cluster.local:27017`);
    }
  });

  it("PLANTED INNOCENT: a consumer on the shared set keeps every Mongo job in the platform namespace, its host left to the cluster it runs on", () => {
    for (const j of mongoJobs(shared)) {
      expect(j.namespace).toBe("mongodb");
      expect(j.sharedMongo).toBe(true);
      expect(host(j)).toBeUndefined();
    }
    for (const j of mongoJobs(own)) expect(j.sharedMongo).toBeUndefined();
  });

  it("restores only once the own instance answers as a writable primary, and fails with that reason when it never does", () => {
    const script = consumerRestoreJobs(own).find((j) => j.spec.name.startsWith("reloc-restore-mongo"))!.spec.script;
    expect(script.indexOf("isWritablePrimary")).toBeGreaterThan(-1);
    expect(script.indexOf("isWritablePrimary")).toBeLessThan(script.indexOf("mongorestore"));
    expect(script).toContain("NO PRIMARY");
    expect(consumerRestoreJobs(shared).find((j) => j.spec.name.startsWith("reloc-restore-mongo"))!.spec.script).not.toContain("isWritablePrimary");
  });

  it("keeps the own instance's data directories out of the claim tar, and out of the generation's expected entries", () => {
    expect(consumerDumpJobs({ ...own, registrationYaml: "name: acme\n" }).find((j) => j.spec.name.startsWith("reloc-dump-pvc"))?.spec.pvcMounts?.map((m) => m.claimName)).toEqual(["uploads"]);
    expect(consumerExpectedDumpEntries({ ...own, pvcs: ["data-mongodb-0"] })).toEqual(["registration.yaml", "mongo"]);
    expect(consumerExpectedDumpEntries({ ...shared, pvcs: ["data-mongodb-0"] })).toEqual(["registration.yaml", "mongo", "pvc"]);
  });

  it("takes the WHOLE own instance, whatever databases[] and services say: an empty list is no empty instance", () => {
    for (const i of [{ ...own, databases: [] }, { ...own, services: [] as ConsumerService[], databases: [] }]) {
      const jobs = mongoJobs(i);
      expect(jobs.map((j) => j.spec.name.split("-").slice(0, 3).join("-"))).toEqual(["reloc-dump-mongo", "reloc-restore-mongo", "reloc-verify-mongo"]);
      const dump = jobs[0]!.spec.script;
      expect(dump).toContain("listDatabases");
      expect(dump).toContain("grep -vx -e admin -e local -e config");
      expect(dump).toContain(`"box:${CONSUMER_FOLDER}/mongo/databases.txt"`);
      expect(consumerExpectedDumpEntries({ ...i, pvcs: [] })).toEqual(["registration.yaml", "mongo"]);
    }
    // The restore and the verify read the archives alone, never the list beside them.
    for (const j of mongoJobs({ ...own, databases: [] }).slice(1)) expect(j.spec.script).toContain(`--include '*.archive'`);
  });

  it("PLANTED INNOCENT: a shared-set consumer with an empty databases[] still dumps nothing from Mongo", () => {
    expect(mongoJobs({ ...shared, databases: [] })).toEqual([]);
    expect(consumerExpectedDumpEntries({ ...shared, databases: [], pvcs: [] })).toEqual(["registration.yaml"]);
  });

  it("lists and clears nothing on the source: the own instance falls with the namespace, as the per-consumer PostgreSQL does", () => {
    expect(consumerSourceDbListJob(own)).toBeNull();
    expect(consumerClearSourceJobs(own)).toEqual([]);
    expect(consumerSourceDbListJob(shared)?.namespace).toBe("mongodb");
    expect(consumerClearSourceJobs(shared).map((j) => j.namespace)).toEqual(["mongodb"]);
  });
});
