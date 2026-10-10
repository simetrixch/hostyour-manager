import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { recordTestOwners } from "./tenant-apps-repo.fixture.ts";
import type { DbHandle } from "../../db/client.ts";
import { openUnitDb } from "#unit/server/plugin.fixture.ts";
import { servers, clusters } from "../../db/schema/inventory.ts";
import { makeOnboardDef, OnboardParams, type OnboardPorts } from "./onboard.run.ts";
import { CI_ENTRY_POINT } from "./onboard-ci-only.ts";
import { FakeGateRunner } from "../../adapters/gate-runner/testing/fake.ts";
import { FakeRepoReader, FakeRepoWriter } from "../../adapters/git/testing/fake.ts";
import { FakeMasterArgoReader } from "../../adapters/kube/testing/fake.ts";
import { FakeGitHubConsumer } from "#unit/server/adapters/github-consumer/testing/fake.ts";
import { buildOnlySteps, CiOnlyParams } from "#unit/server/build-chain.ts";
import type { Cleanup, StepCtx } from "../../executor/types.ts";
import type { CredentialStore } from "../../security/store.ts";
import type { Logger } from "../../kernel/logger.ts";
import { SHA, ports, FakeSeeder } from "./onboard.fixture.ts";

let db: DbHandle;
beforeEach(() => {
  db = openUnitDb();
  recordTestOwners(db.db);
  db.db.insert(servers).values({ id: "srv_1", name: "m1", host: "1.2.3.4", sshUser: "root", role: "master", status: "healthy" }).run();
  db.db.insert(clusters).values({ id: "cls_1", serverId: "srv_1", stage: "prod", domain: "m1.example", name: "m1", status: "active" }).run();
});
afterEach(() => { db.sqlite.close(); });

const REPO = "https://github.com/x/acme.git";
const request = { form: "ci-only", consumerName: "acme", repoURL: REPO, repoCredentialId: "cred_pat", owner: "team-acme" };
const streamCtx = () => ({ db: db.db, log: () => undefined, signal: new AbortController().signal });
const withCheckScript = () => ({ repo: new FakeRepoReader({ resolvedSha: SHA, files: { [CI_ENTRY_POINT]: "#!/usr/bin/env bash\n" } }) });

function ctx(stepName: string, over: Partial<StepCtx> = {}): StepCtx {
  return {
    runId: "run_ci", stepName, db: db.db, params: {},
    creds: { open: async () => Buffer.from("github_pat_test"), list: async () => [] } as unknown as CredentialStore,
    secrets: { get: () => undefined, wipe: () => undefined }, signal: new AbortController().signal,
    logger: {} as Logger,
    ssh: () => Promise.reject(new Error("no ssh")), openPasswordSession: () => Promise.reject(new Error("no ssh")),
    closePasswordSession: () => undefined, attest: () => Promise.reject(new Error("no attest")),
    log: () => undefined, checkpoint: () => undefined, readCheckpoint: () => undefined, registerCleanup: () => undefined,
    ...over,
  };
}

async function planned(prt: OnboardPorts) {
  const result = await makeOnboardDef(prt).planStream!(request, streamCtx());
  if (result.outcome !== "planned") throw new Error(`not planned: ${result.summary}`);
  return result;
}

describe("plan of a CI-only onboarding", () => {
  it("plans exactly the six steps of a unit that builds nothing, with no stage, version, release or kit", async () => {
    const prt = ports(withCheckScript());
    const result = await planned(prt);
    // The exact list is the guard: a release step, the kit or the gate check appearing here would run
    // against a repository that has no release and no manifest.
    expect(result.plan.steps.map((s) => s.name)).toEqual([
      "preflight-scopes", "write-registration", "seed-repo-pat", "await-build-namespace", "setup-webhook", "record",
    ]);
    expect(result.params).toMatchObject({ form: "ci-only", consumerName: "acme", repoURL: REPO, builds: [], resolvedSha: SHA, domain: "m1.example" });
    expect(result.params).not.toHaveProperty("stage");
    expect(result.params).not.toHaveProperty("version");
    expect(makeOnboardDef(prt).steps(result.params).map((s) => s.name)).toEqual(result.plan.steps.map((s) => s.name));
    expect(result.plan).toMatchObject({ targetKind: "cluster", targetId: "cls_1", locks: [{ resource: "git-branch", key: prt.registrations.branch }, { resource: "master-kube", key: "m" }] });
  });

  it("runs no gate and reads no release tag, and clones the default branch head once with the sealed credential", async () => {
    const prt = ports(withCheckScript());
    await planned(prt);
    expect((prt.runner as FakeGateRunner).submitted).toEqual([]);
    expect((prt.repo as FakeRepoReader).clones).toEqual([{ repoURL: REPO, ref: "HEAD", credentialId: "cred_pat" }]);
    expect((prt.github as FakeGitHubConsumer).dispatches).toEqual([]);
  });

  it("rejects a repository without scripts/check.sh and plans the same repository once it has one", async () => {
    const without = ports({ repo: new FakeRepoReader({ resolvedSha: SHA, files: { "package.json": "{}" } }) });
    const rejected = await makeOnboardDef(without).planStream!(request, streamCtx());
    expect(rejected).toMatchObject({ outcome: "rejected" });
    expect(rejected.outcome === "rejected" && rejected.summary).toContain(`no ${CI_ENTRY_POINT}`);
    expect((await makeOnboardDef(ports(withCheckScript())).planStream!(request, streamCtx())).outcome).toBe("planned");
  });

  it("refuses a unit that is already registered, and a name its repository does not give", async () => {
    const prt = ports(withCheckScript());
    await prt.registrations.commitRegistration({ unit: { name: "acme", repoURL: REPO, suspended: false, quiesced: false }, builds: ["acme-api"], runId: "run_1" });
    await expect(makeOnboardDef(prt).planStream!(request, streamCtx())).rejects.toThrow(/already registered/);
    await expect(makeOnboardDef(ports(withCheckScript())).planStream!({ ...request, consumerName: "other" }, streamCtx())).rejects.toThrow(/named by its repository/);
  });

  it("sends a request that is not CI-only to the release planner, which asks for a stage", async () => {
    const prt = ports(withCheckScript());
    await expect(makeOnboardDef(prt).planStream!({ consumerName: "acme", repoURL: REPO, owner: "team-acme", repoCredentialId: "cred_pat" }, streamCtx())).rejects.toThrow(/stage/);
  });
});

describe("params of a CI-only onboarding", () => {
  const ciOnly = { form: "ci-only", consumerName: "acme", repoURL: REPO, repoCredentialId: "cred_pat", owner: "team-acme", resolvedSha: SHA, domain: "m1.example", builds: [] };

  it("accepts the unit with no builds and refuses one that names a build", () => {
    expect(OnboardParams.safeParse(ciOnly).success).toBe(true);
    expect(CiOnlyParams.safeParse({ ...ciOnly, builds: ["acme-api"] }).success).toBe(false);
    expect(OnboardParams.safeParse({ ...ciOnly, builds: ["acme-api"] }).success).toBe(false);
  });
});

describe("execution of a CI-only onboarding", () => {
  async function runAll(prt: OnboardPorts) {
    const result = await planned(prt);
    const armed: Cleanup[] = [];
    for (const step of makeOnboardDef(prt).steps(result.params)) {
      await step.run(ctx(step.name, { params: result.params, registerCleanup: (c) => { armed.push(c); } }));
    }
    return { result, armed };
  }

  it("registers the unit with no builds, seeds its token, sets the push webhook, and releases and writes nothing into the repository", async () => {
    const prt = ports({ ...withCheckScript(), buildArgo: new FakeMasterArgoReader({ everyName: { syncRevision: SHA, targetRevision: null, sync: "Synced", health: "Healthy" } }) });
    const { armed } = await runAll(prt);
    expect((await prt.registrations.readBuildRegistration("acme"))?.entry).toMatchObject({ name: "acme", repoURL: REPO, owner: "team-acme", builds: [] });
    expect(await prt.registrations.readUnitStages("acme")).toEqual([]);
    expect((await prt.registrations.listBuildRegistrations()).find((r) => r.unit === "acme")?.ciOnly).toBe(true);
    expect((prt.seeder as FakeSeeder).buildRepoPats.map((p) => p.consumerName)).toEqual(["acme"]);
    expect((prt.seeder as FakeSeeder).buildRepoPats[0]).not.toHaveProperty("push"); // nothing releases, so nothing pushes
    const github = prt.github as FakeGitHubConsumer;
    expect(github.hooksFor("x", "acme")).toHaveLength(1);
    expect(github.dispatches).toEqual([]);
    expect((prt.consumerRepo as FakeRepoWriter).commits).toEqual([]);
    expect(armed.map((c) => c.name)).toEqual(["remove-build-registration", "remove-consumer-webhook"]);
  });

  it("takes the registration and the webhook back when the run is aborted", async () => {
    const prt = ports({ ...withCheckScript(), buildArgo: new FakeMasterArgoReader({ everyName: { syncRevision: SHA, targetRevision: null, sync: "Synced", health: "Healthy" } }) });
    const { result } = await runAll(prt);
    const github = prt.github as FakeGitHubConsumer;
    expect(github.hooksFor("x", "acme")).toHaveLength(1);
    const cleanups = makeOnboardDef(prt).cleanups!(result.params);
    expect(cleanups.map((c) => c.name)).toEqual(["remove-build-registration", "remove-consumer-webhook"]);
    for (const cleanup of cleanups) await cleanup.run(ctx(cleanup.name, { params: result.params }));
    expect(await prt.registrations.readBuildRegistration("acme")).toBeNull();
    expect(github.hooksFor("x", "acme")).toEqual([]);
  });
});

describe("the forms that release keep their chain", () => {
  it("a build-only unit still injects the release kit and triggers a release", () => {
    const names = buildOnlySteps(ports(), {
      form: "build-only", consumerName: "acme", repoURL: REPO, repoCredentialId: "cred_pat", owner: "team-acme", version: "1.0.0", channel: "stable",
      stage: "prod", resolvedSha: SHA, domain: "m1.example", builds: ["acme-api"], ungated: undefined,
    } as never).map((s) => s.name);
    expect(names).toEqual(expect.arrayContaining(["inject-release-kit", "trigger-release", "watch-release-build"]));
  });
});
