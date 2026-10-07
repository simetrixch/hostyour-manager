import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { DbHandle } from "../../db/client.ts";
import { runRelocationJob, takeOnlineGeneration } from "#unit/server/relocation.ts";
import { verifyDumpJob } from "#unit/server/relocation-jobs.ts";
import { openFixtureDb, makeFakes, consumerPorts, stepCtx, jobNames, seedClusters, seedConsumerRow, seedConsumerRegistration, seedMaster, SOURCE, CONSUMER } from "./relocation.fixture.ts";
import { consumerWorld } from "./relocation-world-consumer.ts";
import { listBackups } from "../../db/unit-backups.ts";

// A cancel ends the watch on a relocation job, not the job: the run is told the job was interrupted,
// never that it did not succeed, whatever the watch saw last (on 2026-10-07 a job that had Completed
// with exit code 0 was reported as failed that way).

let db: DbHandle;
beforeEach(() => { db = openFixtureDb(); });
afterEach(() => { db.sqlite.close(); });

const job = verifyDumpJob({ unit: CONSUMER, folder: `master.example/prod/consumers/${CONSUMER}/20260928T030000Z`, namespace: CONSUMER, expected: ["registration.yaml"], image: "registrations.example/dbtools:1.0.0" });

describe("runRelocationJob under a cancel", () => {
  it("says the job was interrupted, as an abort, and never that it did not succeed", async () => {
    const f = makeFakes();
    f.source.reader.setJobResult(job.spec.name, { succeeded: false, logs: "" });
    const cancel = new AbortController();
    cancel.abort();
    const err = await runRelocationJob(consumerPorts(f), { ...stepCtx(db, "verify-dump", {}, []), signal: cancel.signal }, SOURCE.clusterId, job).then(() => null, (e: unknown) => e as Error);
    expect(err?.name).toBe("AbortError");
    expect(err?.message).toMatch(/was interrupted — the run was cancelled while it ran/);
    expect(err?.message).not.toMatch(/did not succeed/);
    expect(f.source.reader.secrets.size).toBe(0);
  });

  it("PLANTED INNOCENT: a job that finished before the cancel came is reported as it ended", async () => {
    const f = makeFakes();
    f.source.reader.setJobResult(job.spec.name, { succeeded: true, logs: "sha256 ok" });
    const cancel = new AbortController();
    cancel.abort();
    await expect(runRelocationJob(consumerPorts(f), { ...stepCtx(db, "verify-dump", {}, []), signal: cancel.signal }, SOURCE.clusterId, job)).resolves.toContain("sha256 ok");
  });

  it("PLANTED INNOCENT: without a cancel a failed job still reports that it did not succeed", async () => {
    const f = makeFakes();
    f.source.reader.setJobResult(job.spec.name, { succeeded: false, logs: "MISSING registration.yaml" });
    await expect(runRelocationJob(consumerPorts(f), stepCtx(db, "verify-dump", {}, []), SOURCE.clusterId, job)).rejects.toThrow(/did not succeed — its last lines: MISSING registration.yaml/);
  });
});

describe("an online generation a cancel cuts off", () => {
  it("is booked as interrupted, naming its folder and the cleanup that deletes it, and no purge runs under the cancel", async () => {
    seedMaster(db);
    seedClusters(db);
    seedConsumerRow(db);
    const f = makeFakes();
    const ports = consumerPorts(f);
    await seedConsumerRegistration(ports.registrations);
    f.source.reader.setJobResult(`reloc-dump-reg-${CONSUMER}`, { succeeded: false, logs: "" });
    const cancel = new AbortController();
    cancel.abort();
    const ctx = { ...stepCtx(db, "back-up", {}, []), signal: cancel.signal };
    await expect(takeOnlineGeneration(ports, ctx, await consumerWorld(ports, "app_1")(ctx), "nightly")).rejects.toThrow(/was interrupted/);
    const [g] = listBackups(db.db, { kind: "consumer", unit: CONSUMER, stage: "prod" });
    expect(g?.state).toBe("failed");
    expect(g?.detail).toBe(`interrupted by a cancel during the dump — the folder ${g?.folder}/ stays on the box until the run's Abort (cleanup) deletes it`);
    expect(jobNames(f.source).some((n) => n.startsWith("reloc-purge-generation"))).toBe(false);
  });
});
