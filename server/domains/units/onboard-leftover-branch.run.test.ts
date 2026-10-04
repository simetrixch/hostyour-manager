import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { seedUnitSizes } from "#unit/server/unit-size.ts";
import { openDb, type DbHandle } from "../../db/client.ts";
import { servers, clusters } from "../../db/schema/inventory.ts";
import { makeOnboardDef, type OnboardParams } from "./onboard.run.ts";
import { FakeRepoReader } from "../../adapters/git/testing/fake.ts";
import { FakeGateRunner } from "../../adapters/gate-runner/testing/fake.ts";
import type { StepCtx } from "../../executor/types.ts";
import type { CredentialStore } from "../../security/store.ts";
import type { Logger } from "../../kernel/logger.ts";
import { FakeGitHubConsumer } from "#unit/server/adapters/github-consumer/testing/fake.ts";
import { SHA, MANIFEST, CHART_PINS, passReport, ports } from "./onboard.fixture.ts";

// A DELIVERY BRANCH THAT OUTLIVED ITS STAGE. The stage's Application renders deploy/<stage> the moment
// the registration lands; a branch left from an earlier life of the unit (an old release kit moved it
// onto the 0.0.0 release commit) is rendered before the onboarding's own release places the pin, and
// the first sync hangs on images that do not exist. The onboarding deletes such a branch before the
// registration is written — the bump re-creates it, pinned — and never touches one a registration
// at that stage still stands on.

let db: DbHandle;
beforeEach(() => { db = openDb(":memory:"); seedUnitSizes(db.db); });
afterEach(() => { db.sqlite.close(); });

/** ONE cluster, marked prod. Every test here onboards onto it. */
function seedClusters(): void {
  db.db.insert(servers).values({ id: "srv_1", name: "m1", host: "1.2.3.4", sshUser: "root", role: "master", status: "healthy" }).run();
  db.db.insert(clusters).values({ id: "cls_1", serverId: "srv_1", stage: "prod", domain: "s1.example", name: "s1", status: "active" }).run();
}

const request = (over: Record<string, unknown>): Record<string, unknown> => ({
  consumerName: "acme", repoURL: "https://github.com/x/acme.git", version: "1.0.0", channel: "stable",
  clusterId: "cls_1", owner: "team-acme", chartPath: "deploy/chart", repoCredentialId: "cred_pat", ...over,
});
const planCtx = () => ({ db: db.db, log: () => undefined, signal: new AbortController().signal });

const logged: string[] = [];
function ctx(p: OnboardParams, stepName: string): StepCtx {
  return {
    runId: "run_onb", stepName, db: db.db, params: p,
    creds: { open: () => Promise.resolve(Buffer.from("github_pat_test", "utf8")) } as unknown as CredentialStore,
    secrets: { get: () => undefined, wipe: () => undefined }, signal: new AbortController().signal,
    logger: {} as unknown as Logger,
    ssh: () => Promise.reject(new Error("no ssh")), openPasswordSession: () => Promise.reject(new Error("no ssh")),
    closePasswordSession: () => undefined, attest: () => Promise.reject(new Error("no attest")),
    log: (_k: string, line: string) => { logged.push(line); }, checkpoint: () => undefined, readCheckpoint: () => undefined, registerCleanup: () => undefined,
  };
}

const LEFTOVER = { sha: "ebed5a1".padEnd(40, "0"), parents: [] };

async function planAtTest(github: FakeGitHubConsumer) {
  seedClusters();
  const prt = ports({
    github,
    runner: new FakeGateRunner({ report: passReport({ ...MANIFEST, envs: ["test", "prod"] }) }),
    repo: new FakeRepoReader({ resolvedSha: SHA, files: { "deploy/chart/values-test.yaml": CHART_PINS } }),
  });
  const res = await makeOnboardDef(prt).planStream!(request({ stage: "test" }), planCtx());
  if (res.outcome !== "planned" || res.params.form !== "deployable") throw new Error("not planned");
  const steps = makeOnboardDef(prt).steps(res.params);
  const run = (name: string) => steps.find((s) => s.name === name)!.run(ctx(res.params, name));
  return { prt, steps, run };
}

describe("onboard clears a leftover deploy/<stage> before the registration", () => {
  beforeEach(() => { logged.length = 0; });

  it("deletes the branch a stage with no registration left behind, logs its SHA, runs before write-registration, and leaves the other stages' branches", async () => {
    const github = new FakeGitHubConsumer();
    github.seedBranch("x", "acme", "deploy/test", LEFTOVER);
    github.seedBranch("x", "acme", "deploy/prod", { sha: "b".repeat(40), parents: [] });
    const { steps, run } = await planAtTest(github);
    const names = steps.map((s) => s.name);
    expect(names.indexOf("clear-leftover-branch")).toBeGreaterThan(-1);
    expect(names.indexOf("clear-leftover-branch")).toBeLessThan(names.indexOf("write-registration"));
    await run("clear-leftover-branch");
    expect(github.deletedBranches).toEqual(["x/acme/deploy/test"]);
    expect(await github.readBranchCommit({ owner: "x", repo: "acme", branch: "deploy/test", token: "t" })).toBeNull();
    expect(logged.join("\n")).toContain(LEFTOVER.sha);
    expect(await github.readBranchCommit({ owner: "x", repo: "acme", branch: "deploy/prod", token: "t" })).not.toBeNull();
  });

  it("leaves a stage with no branch alone", async () => {
    const github = new FakeGitHubConsumer();
    const { run } = await planAtTest(github);
    await run("clear-leftover-branch");
    expect(github.deletedBranches).toEqual([]);
  });

  it("refuses, and leaves the branch, where a registration of the unit stands at that stage", async () => {
    const github = new FakeGitHubConsumer();
    github.seedBranch("x", "acme", "deploy/test", LEFTOVER);
    const { run } = await planAtTest(github);
    await run("write-registration");
    await expect(run("clear-leftover-branch")).rejects.toThrow(/registration of acme at test/);
    expect(github.deletedBranches).toEqual([]);
  });
});
