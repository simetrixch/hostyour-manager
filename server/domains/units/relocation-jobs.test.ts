import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { DbHandle } from "../../db/client.ts";
import { runRelocationJob } from "./relocation.ts";
import {
  boxSecretName, jobReadsBoxSecret,
  tenantDumpJobs, tenantRestoreJobs, tenantVerifyCompletenessJobs, tenantClearSourceJobs, tenantSourceDbListJob,
  verifyDumpJob, readRegistrationJob,
  type RelocationJob,
} from "./relocation-jobs.ts";
import {
  consumerDumpJobs, consumerRestoreJobs, consumerVerifyCompletenessJobs, consumerClearSourceJobs, consumerSourceDbListJob,
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
const ALL_SERVICES: ConsumerService[] = ["mongodb", "postgresql"];

/** Every job every relocation phase builds, both kinds of unit, with each optional store PRESENT —
 *  a tenant with an app member (so the bucket phase renders) and a consumer claiming every store it
 *  can. A job hidden behind an absent claim carries no credential, so the maximal shape is the one
 *  worth asserting over. */
function everyJob(): RelocationJob[] {
  const tenant = { guid: GUID, stage: "prod" as const, apps: ["web"], image: IMAGE , identityProvider: "auth" };
  const consumer = { name: CONSUMER, stage: "prod" as const, databases: ["acme_main"], services: ALL_SERVICES, pvcs: ["data"], image: IMAGE };
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
    verifyDumpJob({ unit: CONSUMER, namespace: CONSUMER, expected: ["registration.yaml"], image: IMAGE }),
    readRegistrationJob({ unit: CONSUMER, namespace: "mongodb", image: IMAGE }),
  ];
}

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
    // All but the two source LISTINGS reach the box; those only read a database.
    expect(boxJobs.length).toBe(everyJob().length - 2);
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
    const mine = tenantClearSourceJobs({ guid: GUID, stage: "prod", image: IMAGE })[0]!;
    const theirs = tenantClearSourceJobs({ guid: "other0000000", stage: "prod", image: IMAGE })[0]!;
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
    const job = verifyDumpJob({ unit: CONSUMER, namespace: CONSUMER, expected: ["registration.yaml"], image: IMAGE });
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
    const job = verifyDumpJob({ unit: CONSUMER, namespace: CONSUMER, expected: ["registration.yaml"], image: IMAGE });
    f.source.reader.setJobResult(job.spec.name, { succeeded: false, logs: "MISSING registration.yaml" });

    await expect(runRelocationJob(ports, stepCtx(db, "verify-dump", {}, []), SOURCE.clusterId, job)).rejects.toThrow(/did not succeed/);
    expect(f.source.reader.secrets.size).toBe(0);
  });

  it("an unwired Storage Box stops the job BEFORE it is created, rather than starting a pod that cannot resolve its Secret", async () => {
    const f = makeFakes();
    const ports = consumerPorts(f);
    delete (ports as { storageBox?: unknown }).storageBox;
    const job = verifyDumpJob({ unit: CONSUMER, namespace: CONSUMER, expected: ["registration.yaml"], image: IMAGE });

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
