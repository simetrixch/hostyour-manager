import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { DbHandle } from "../../db/client.ts";
import { runRelocationJob } from "#unit/server/relocation.ts";
import { tenantDumpJobs } from "./relocation-jobs-tenant.ts";
import { consumerSourceDbListJob } from "./relocation-jobs-consumer.ts";
import { openFixtureDb, seedClusters, makeFakes, tenantPorts, consumerPorts, stepCtx, GUID, CONSUMER, SOURCE } from "./relocation.fixture.ts";

// A job on the shared Mongo dials the Mongo of the cluster it runs on, the one that cluster's
// service-provisioner writes every workload's Secret from — not one composed from the unit's stage.
// The installation's clusters each run one Mongo, at their own stage, and carry units of other stages.

let db: DbHandle;
beforeEach(() => { db = openFixtureDb(); seedClusters(db); });
afterEach(() => { db.sqlite.close(); });

const PROD_MONGO = { name: "MONGO_HOST", value: "rs0/mongodb-prod-headless.mongodb.svc.cluster.local:27017" };

describe("a job on the shared Mongo", () => {
  it("PLANTED DEFECT: a TEST tenant's dump on a cluster of stage prod dials that cluster's Mongo", async () => {
    const f = makeFakes();
    const [dump] = tenantDumpJobs({ guid: GUID, folder: "box/test", stage: "test", apps: ["web"], identityProvider: "auth", image: "dbtools:1", registrationYaml: "guid: x\n" });
    await runRelocationJob(tenantPorts(f), stepCtx(db, "dump", {}, []), SOURCE.clusterId, dump!);
    const ran = f.source.reader.jobs.find((j) => j.spec.name === dump!.spec.name);
    expect(ran?.spec.env).toContainEqual(PROD_MONGO);
    expect(ran?.spec.env?.filter((e) => e.name === "MONGO_HOST")).toHaveLength(1);
  });

  it("PLANTED INNOCENT: a consumer's listing on the shared set dials the same Mongo", async () => {
    const f = makeFakes();
    const list = consumerSourceDbListJob({ name: CONSUMER, stage: "test", databases: ["acme_main"], services: ["mongodb"], mongodb: "shared", image: "dbtools:1" });
    await runRelocationJob(consumerPorts(f), stepCtx(db, "list", {}, []), SOURCE.clusterId, list!);
    expect(f.source.reader.jobs.find((j) => j.spec.name === list!.spec.name)?.spec.env).toContainEqual(PROD_MONGO);
  });

  it("refuses to run on a manager that cannot read the books", async () => {
    const f = makeFakes();
    const ports = { ...tenantPorts(f) };
    delete (ports as { platformAppValues?: unknown }).platformAppValues;
    const [dump] = tenantDumpJobs({ guid: GUID, folder: "box/test", stage: "test", apps: ["web"], identityProvider: "auth", image: "dbtools:1", registrationYaml: "guid: x\n" });
    await expect(runRelocationJob(ports, stepCtx(db, "dump", {}, []), SOURCE.clusterId, dump!)).rejects.toThrow(/books reader/);
    expect(f.source.reader.jobs).toEqual([]);
  });
});
