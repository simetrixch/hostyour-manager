import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { DbHandle } from "../../db/client.ts";
import { runRelocationJob } from "#unit/server/relocation.ts";
import { verifyDumpJob } from "#unit/server/relocation-jobs.ts";
import { openFixtureDb, makeFakes, consumerPorts, stepCtx, SOURCE, CONSUMER } from "./relocation.fixture.ts";

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

  it("PLANTED INNOCENT: without a cancel a failed job still reports that it did not succeed", async () => {
    const f = makeFakes();
    f.source.reader.setJobResult(job.spec.name, { succeeded: false, logs: "MISSING registration.yaml" });
    await expect(runRelocationJob(consumerPorts(f), stepCtx(db, "verify-dump", {}, []), SOURCE.clusterId, job)).rejects.toThrow(/did not succeed — its last lines: MISSING registration.yaml/);
  });
});
