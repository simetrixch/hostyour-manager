import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { seedUnitSizes } from "./unit-size.ts";
import { openDb, type DbHandle } from "../../db/client.ts";
import { servers, clusters } from "../../db/schema/inventory.ts";
import { makeOnboardDef, type OnboardParams } from "./onboard.run.ts";
import { FakeRepoReader } from "../../adapters/git/testing/fake.ts";
import { FakeGateRunner } from "../../adapters/gate-runner/testing/fake.ts";
import type { StepCtx } from "../../executor/types.ts";
import type { CredentialStore } from "../../security/store.ts";
import type { Logger } from "../../kernel/logger.ts";
import { SHA, MANIFEST, CHART_PINS, passReport, ports } from "./onboard.fixture.ts";

// THE STAGE IS THE UNIT'S, NOT THE CLUSTER'S. Split from onboard.run.test.ts, whose fixtures all
// onboard at the stage the cluster is marked with, so the two laws this file holds stay visible:
// the plan holds the requested stage against the channel's ceiling (the table off the trunk), and a
// unit at test lands on a cluster marked prod with every derived name — namespace, Application,
// registration path — carrying test, and the registration's cluster field naming that cluster.

let db: DbHandle;
beforeEach(() => { db = openDb(":memory:"); seedUnitSizes(db.db); });
afterEach(() => { db.sqlite.close(); });

/** ONE cluster, marked prod. Every test here onboards onto it. */
function seedClusters(): void {
  db.db.insert(servers).values({ id: "srv_1", name: "m1", host: "1.2.3.4", sshUser: "root", role: "master", status: "healthy" }).run();
  db.db.insert(clusters).values({ id: "cls_1", serverId: "srv_1", stage: "prod", domain: "s1.example", status: "active" }).run();
}

const request = (over: Record<string, unknown>): Record<string, unknown> => ({
  consumerName: "acme", repoURL: "https://github.com/x/acme.git", version: "1.0.0", channel: "stable",
  clusterId: "cls_1", owner: "team-acme", chartPath: "deploy/chart", repoCredentialId: "cred_pat", ...over,
});
const planCtx = () => ({ db: db.db, log: () => undefined, signal: new AbortController().signal });

function ctx(p: OnboardParams, stepName: string): StepCtx {
  return {
    runId: "run_onb", stepName, db: db.db, params: p,
    creds: { open: () => Promise.resolve(Buffer.from("github_pat_test", "utf8")) } as unknown as CredentialStore,
    secrets: { get: () => undefined, wipe: () => undefined }, signal: new AbortController().signal,
    logger: {} as unknown as Logger,
    ssh: () => Promise.reject(new Error("no ssh")), openPasswordSession: () => Promise.reject(new Error("no ssh")),
    closePasswordSession: () => undefined, attest: () => Promise.reject(new Error("no attest")),
    log: () => undefined, checkpoint: () => undefined, readCheckpoint: () => undefined, registerCleanup: () => undefined,
  };
}

describe("onboard at the unit's own stage", () => {
  it("holds the stage against the channel's ceiling — alpha reaches dev alone, so alpha at prod is refused before anything is read", async () => {
    seedClusters();
    await expect(makeOnboardDef(ports()).planStream!(request({ channel: "alpha", stage: "prod" }), planCtx())).rejects.toThrow(/alpha channel, which reaches dev/);
  });

  it("puts a unit at test onto a cluster marked prod — the stage is the unit's, and every derived name carries it", async () => {
    seedClusters();
    const prt = ports({
      runner: new FakeGateRunner({ report: passReport({ ...MANIFEST, envs: ["test", "prod"] }) }),
      repo: new FakeRepoReader({ resolvedSha: SHA, files: { "deploy/chart/values-test.yaml": CHART_PINS } }),
    });
    const res = await makeOnboardDef(prt).planStream!(request({ stage: "test" }), planCtx());
    expect(res.outcome).toBe("planned");
    if (res.outcome !== "planned" || res.params.form !== "deployable") return;
    expect(res.params).toMatchObject({ stage: "test", clusterId: "cls_1", cluster: "s1", domain: "s1.example", namespace: "acme-test", argoAppName: "acme-test" });
    expect(res.plan.summary).toContain("s1.example (test)");
    // The registration the run writes is the stage's own file, and its cluster field names the
    // prod-marked cluster — the path carries the stage, the body carries the cluster.
    const write = makeOnboardDef(prt).steps(res.params).find((s) => s.name === "write-registration")!;
    await write.run(ctx(res.params, "write-registration"));
    expect((await prt.registrations.readRegistration("test", "acme"))?.entry.cluster).toBe("s1");
    expect(await prt.registrations.readRegistration("prod", "acme")).toBeNull();
  });
});
