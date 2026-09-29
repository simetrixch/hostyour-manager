import { describe, it, expect, beforeEach, afterEach } from "vitest";
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
  consumerDumpJobs, consumerRestoreJobs, consumerVerifyCompletenessJobs, consumerClearSourceJobs, consumerSourceDbListJob, claimsIdentity,
} from "./relocation-jobs-consumer.ts";
import type { ConsumerService } from "../../../shared/consumer.ts";
import { openFixtureDb, makeFakes, consumerPorts, stepCtx, SOURCE } from "./relocation.fixture.ts";

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
  const consumer = { name: CONSUMER, folder: CONSUMER_FOLDER, stage: "prod" as const, namespace: `${CONSUMER}-prod`, databases: ["acme_main"], services: ALL_SERVICES, pvcs: ["data"], image: IMAGE };
  return [
    ...tenantDumpJobs({ ...tenant, registrationYaml: "guid: zsjs023ctne0\n" }),
    ...tenantRestoreJobs(tenant),
    ...tenantVerifyCompletenessJobs(tenant),
    ...tenantClearSourceJobs({ guid: GUID, stage: "prod", image: IMAGE }),
    tenantSourceDbListJob({ guid: GUID, stage: "prod", image: IMAGE }),
    ...consumerDumpJobs({ ...consumer, registrationYaml: "name: acme\n" }),
    ...consumerRestoreJobs(consumer),
    ...consumerVerifyCompletenessJobs(consumer),
    ...consumerClearSourceJobs({ name: CONSUMER, stage: "prod", databases: consumer.databases, services: ALL_SERVICES, image: IMAGE }),
    consumerSourceDbListJob({ name: CONSUMER, stage: "prod", databases: consumer.databases, services: ALL_SERVICES, image: IMAGE })!,
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
    const jobs = [...tenantClearSourceJobs({ guid: GUID, stage: "prod", image: IMAGE }), ...consumerClearSourceJobs({ name: CONSUMER, stage: "prod", databases: ["acme_main"], services: ALL_SERVICES, image: IMAGE })];
    expect(jobs).toHaveLength(2);
    for (const job of jobs) {
      expect(job.spec.script).not.toContain("box:");
      expect(jobReadsBoxSecret(job.spec)).toBe(false);
    }
    // A consumer without a Mongo database has nothing a job must drop.
    expect(consumerClearSourceJobs({ name: CONSUMER, stage: "prod", databases: [], services: ["postgresql"], image: IMAGE })).toEqual([]);
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
    const f = makeFakes();
    const ports = consumerPorts(f);
    const listing = tenantSourceDbListJob({ guid: GUID, stage: "prod", image: IMAGE });
    await runRelocationJob(ports, stepCtx(db, "verify-source-released", {}, []), SOURCE.clusterId, listing);

    expect(f.source.reader.secretWrites).toEqual([]);
    expect(f.source.reader.jobs[0]?.secretsAtRun.size).toBe(0);
  });
});

describe("the nightly backup under pod security restricted (hostyour-manager#333)", () => {
  const consumer = { name: CONSUMER, folder: CONSUMER_FOLDER, stage: "prod" as const, namespace: `${CONSUMER}-prod`, databases: ["acme_main"], services: ALL_SERVICES, pvcs: ["data"], image: IMAGE };
  const pvcJob = (jobs: RelocationJob[]): RelocationJob => jobs.find((j) => j.spec.name.startsWith("reloc-dump-pvc"))!;

  it("a claim is dumped as the user of the pod that mounts it", () => {
    // queue-digita-post-mta-0 is mounted by a pod running as 1000, postgres-data of swissbookai by one
    // running as 999; a job running as anyone else cannot read what only they may read.
    const identity = claimsIdentity(`${CONSUMER}-prod`, ["data"], [{ claim: "data", user: 999, group: 999 }]);
    expect(identity).toEqual({ user: 999, group: 999 });
    expect(pvcJob(consumerDumpJobs({ ...consumer, pvcUser: identity, registrationYaml: "name: acme\n" })).spec.runAs).toEqual({ user: 999, group: 999 });
  });

  it("a claim no running pod mounts is refused by name", () => {
    expect(() => claimsIdentity(`${CONSUMER}-prod`, ["data"], [{ claim: "other", user: 1000, group: 1000 }])).toThrow(/claim data in .* is mounted by no running pod/);
  });

  it("claims used as two different users are refused, because one job reads as one user", () => {
    const users = [{ claim: "a", user: 1000, group: 1000 }, { claim: "b", user: 999, group: 999 }];
    expect(() => claimsIdentity(`${CONSUMER}-prod`, ["a", "b"], users)).toThrow(/1000:1000 and 999:999/);
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
    expect(tenantMongo.spec.script).toContain('echo "FAILED mongodump $db, exit $s"; exit $s;');
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
