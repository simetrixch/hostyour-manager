// A consumer restore brings back the unit's build parts the offboard of its last stage removed: the
// repository token in the build Vault, the release kit and the build webhook, from the credential
// the repository is reached with. Beside a stage that still stands, all three stood all along and are
// left alone.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { DbHandle } from "../../db/client.ts";
import type { FakeRepoReader, FakeRepoWriter } from "../../adapters/git/testing/fake.ts";
import type { FakeGitHubConsumer } from "#unit/server/adapters/github-consumer/testing/fake.ts";
import { recordBackupFinished, recordBackupStarted } from "../../db/unit-backups.ts";
import { makeRestoreDef } from "./restore.run.ts";
import type { FakeSeeder } from "./onboard.fixture.ts";
import { SHA } from "./onboard.fixture.ts";
import {
  openFixtureDb, seedClusters, seedConsumerRow, seedConsumerRegistration, makeFakes, consumerPorts, restoreBuildPorts,
  stepCtx, CONSUMER, TARGET,
} from "./relocation.fixture.ts";

const GENERATION = "20260927T030000Z";
const PARAMS = { appId: "app_1", targetClusterId: TARGET.clusterId, generation: GENERATION };
const BUILD_STEPS = ["restore-repo-pat", "restore-release-kit", "restore-webhook"];

let db: DbHandle;
beforeEach(() => {
  db = openFixtureDb();
  seedClusters(db);
  seedConsumerRow(db, "offboarded");
  const g = { kind: "consumer" as const, unit: CONSUMER, stage: "prod" as const, generation: GENERATION };
  recordBackupStarted(db.db, { ...g, folder: `box/prod/consumers/${CONSUMER}/${GENERATION}`, trigger: "manual", runId: "run_backup" });
  recordBackupFinished(db.db, g, { state: "ok" });
});
afterEach(() => { db.sqlite.close(); });

function world() {
  const ports = consumerPorts(makeFakes());
  const asked: string[] = [];
  const build = { ...restoreBuildPorts(), resolveBuildPlaneFqdn: async (domain: string) => { asked.push(domain); return "m1.example"; } };
  return {
    ports, build, asked,
    seeder: build.seeder as FakeSeeder,
    github: build.github as FakeGitHubConsumer,
    kit: build.consumerRepo as FakeRepoWriter,
    repo: build.repo as FakeRepoReader,
  };
}

/** The three build steps alone, the way the executor runs them after `record`. */
async function runBuildSteps(w: ReturnType<typeof world>, logs: string[]): Promise<void> {
  const steps = makeRestoreDef(w.ports, w.build).steps(PARAMS).filter((s) => BUILD_STEPS.includes(s.name));
  for (const step of steps) await step.run(stepCtx(db, step.name, PARAMS, logs));
}

describe("consumer-restore: the unit's build parts", () => {
  it("plans the three parts after record and says the restore brings them back, for a unit with no other stage", async () => {
    const w = world();
    const plan = await makeRestoreDef(w.ports, w.build).plan(PARAMS, { db: db.db });
    expect(plan.steps.map((s) => s.name).slice(-4)).toEqual(["record", ...BUILD_STEPS]);
    expect(plan.warnings).toContain(`${CONSUMER} has no other stage, so its offboard removed its repository token, release kit and build webhook; the restore brings all three back after it records the unit, from the credential its repository is reached with`);
  });

  it("does not count the restored stage's own registration, which an aborted earlier restore can leave standing", async () => {
    const w = world();
    await seedConsumerRegistration(w.ports.registrations, { stage: "prod" });
    const plan = await makeRestoreDef(w.ports, w.build).plan(PARAMS, { db: db.db });
    expect(plan.warnings.some((line) => line.startsWith(`${CONSUMER} has no other stage`))).toBe(true);
  });

  it("refuses the plan, naming the owner, where no credential reaches the repository", async () => {
    db.sqlite.prepare("UPDATE credentials SET revoked_at = ? WHERE id = 'cred_pat_x'").run(Date.now());
    const w = world();
    await expect(makeRestoreDef(w.ports, w.build).plan(PARAMS, { db: db.db })).rejects.toThrow(/owner x records no repository PAT/);
  });

  it("seeds the token, commits the kit and sets up the hook at the build plane the target's map names, from the owner's credential", async () => {
    const w = world();
    const logs: string[] = [];
    await runBuildSteps(w, logs);
    expect(w.seeder.buildRepoPats).toEqual([{ consumerName: CONSUMER, pat: "ghp_owner", packages: "", push: "ghp_owner" }]);
    // The packages reader is decided by the .npmrc at the commit the default branch stands at.
    expect(w.repo.clones).toEqual(expect.arrayContaining([
      { repoURL: "https://github.com/x/acme.git", ref: "HEAD", credentialId: "cred_pat_x" },
      { repoURL: "https://github.com/x/acme.git", ref: SHA, credentialId: "cred_pat_x" },
    ]));
    expect(w.kit.commits).toHaveLength(1);
    expect(w.asked).toEqual([TARGET.domain]);
    expect(w.github.created.map((h) => `${h.owner}/${h.repo} ${h.targetUrl}`)).toEqual(["x/acme https://build.m1.example/github"]);
  });

  it("leaves all three alone beside a stage that still stands, and says so in the plan", async () => {
    const w = world();
    await seedConsumerRegistration(w.ports.registrations, { stage: "test" });
    const plan = await makeRestoreDef(w.ports, w.build).plan(PARAMS, { db: db.db });
    expect(plan.warnings).toContain(`${CONSUMER} stays registered at test, so its repository token, release kit and build webhook still stand and stay as they are`);
    const logs: string[] = [];
    await runBuildSteps(w, logs);
    expect(w.seeder.buildRepoPats).toEqual([]);
    expect(w.kit.commits).toEqual([]);
    expect(w.github.created).toEqual([]);
    expect(logs).toContain(`the build webhook for ${CONSUMER} kept — the unit stays registered at test, and there is one per unit, not one per stage; it goes with the unit's last stage`);
  });
});
