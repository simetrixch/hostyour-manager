import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { seedQuota } from "#unit/shared/unit-size.ts";
import { recordTestOwners } from "./tenant-apps-repo.fixture.ts";
import type { DbHandle } from "../../db/client.ts";
import { openUnitDb } from "#unit/server/plugin.fixture.ts";
import { servers, clusters } from "../../db/schema/inventory.ts";
import { makeOffboardCiOnlyDef, type OffboardCiOnlyPorts } from "./offboard-ci-only.run.ts";
import { assertGuardsArmed } from "../../executor/guards.ts";
import { FakeMasterArgoReader } from "../../adapters/kube/testing/fake.ts";
import { FakeGitHubConsumer } from "#unit/server/adapters/github-consumer/testing/fake.ts";
import { webhookTargetUrl } from "#unit/server/adapters/github-consumer/port.ts";
import type { ArgoAppStatus } from "../../adapters/kube/port.ts";
import type { AnyRunDefinition, StepCtx } from "../../executor/types.ts";
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
const PARAMS = { consumerName: "acme", repoURL: REPO };
const STATUS = (health: ArgoAppStatus["health"]): ArgoAppStatus => ({ syncRevision: SHA, targetRevision: null, sync: "Synced", health });

/** A master ArgoCD whose watch ends on `health`, and which holds no Application once it is Missing. */
class PrunedArgo extends FakeMasterArgoReader {
  constructor(private readonly health: ArgoAppStatus["health"]) { super({ status: STATUS(health) }); }
  override async getApplication(): Promise<ArgoAppStatus | null> { return this.health === "Missing" ? null : STATUS(this.health); }
}

function offboardPorts(health: ArgoAppStatus["health"] = "Missing"): OffboardCiOnlyPorts & { github: FakeGitHubConsumer; seeder: FakeSeeder } {
  const prt = ports({ buildArgo: new PrunedArgo(health) });
  return { ...prt, github: prt.github as FakeGitHubConsumer, seeder: prt.seeder as FakeSeeder };
}

/** The state a CI-only onboarding leaves: the registration with no builds, and the push webhook. */
async function onboarded(prt: ReturnType<typeof offboardPorts>): Promise<void> {
  await prt.registrations.createBuildRegistration({ unit: { name: "acme", repoURL: REPO, owner: "team-acme", suspended: false, quiesced: false }, builds: [], runId: "run_on" }, () => undefined);
  prt.github.seedHook("x", "acme", webhookTargetUrl(await prt.resolveBuildPlaneFqdn("m1.example"), "build"));
}

function ctx(stepName: string): StepCtx {
  return {
    runId: "run_off", stepName, db: db.db, params: PARAMS,
    creds: { open: async () => Buffer.from("github_pat_test"), list: async () => [] } as unknown as CredentialStore,
    secrets: { get: () => undefined, wipe: () => undefined }, signal: new AbortController().signal,
    logger: {} as Logger,
    ssh: () => Promise.reject(new Error("no ssh")), openPasswordSession: () => Promise.reject(new Error("no ssh")),
    closePasswordSession: () => undefined, attest: () => Promise.reject(new Error("no attest")),
    log: () => undefined, checkpoint: () => undefined, readCheckpoint: () => undefined, registerCleanup: () => undefined,
  };
}

async function runSteps(prt: OffboardCiOnlyPorts, skip: readonly string[] = []): Promise<void> {
  for (const step of makeOffboardCiOnlyDef(prt).steps(PARAMS)) {
    if (!skip.includes(step.name)) await step.run(ctx(step.name));
  }
}

describe("plan of a CI-only offboard", () => {
  it("plans the seven steps, the first being the attestation every mutating run starts with", async () => {
    const prt = offboardPorts();
    await onboarded(prt);
    const def = makeOffboardCiOnlyDef(prt);
    const plan = await def.plan(PARAMS, { db: db.db } as never);
    expect(plan.steps.map((s) => s.name)).toEqual(["attest-target", "remove-webhook", "remove-registration", "watch-removal", "remove-repo-pat", "assert-no-orphans", "record-offboard"]);
    expect(plan).toMatchObject({ kind: "consumer-offboard-ci-only", targetKind: "cluster", targetId: "cls_1" });
    expect(() => assertGuardsArmed(new Map<string, AnyRunDefinition>([[def.kind, def as AnyRunDefinition]]))).not.toThrow();
  });

  it("refuses a unit that deploys, a unit that builds, a unit that is not registered, and another repository", async () => {
    const plan = (prt: OffboardCiOnlyPorts) => makeOffboardCiOnlyDef(prt).plan(PARAMS, { db: db.db } as never);
    const unit = { name: "acme", repoURL: REPO, suspended: false, quiesced: false };

    const deploys = offboardPorts();
    await deploys.registrations.commitRegistration({
      unit, builds: [], runId: "run_1",
      deploy: { stage: "prod", chartPath: "deploy/chart", cluster: "s1", host: "acme", databases: [], keyPatterns: [], channelPatterns: [], services: [], size: "small", mongodb: "shared", quota: seedQuota("small") },
    });
    await expect(plan(deploys)).rejects.toThrow(/not a CI-only unit \(it stands at prod\)/);

    const builds = offboardPorts();
    await builds.registrations.commitRegistration({ unit, builds: ["acme-api"], runId: "run_2" });
    await expect(plan(builds)).rejects.toThrow(/not a CI-only unit \(it builds acme-api\)/);

    await expect(plan(offboardPorts())).rejects.toThrow(/build registration of acme/);

    const other = offboardPorts();
    await other.registrations.createBuildRegistration({ unit: { ...unit, repoURL: "https://github.com/other/acme.git" }, builds: [], runId: "run_3" }, () => undefined);
    await expect(plan(other)).rejects.toThrow(/registered for https:\/\/github.com\/other\/acme.git, not/);
  });
});

describe("execution of a CI-only offboard", () => {
  it("removes the webhook, the registration and the token, and nothing else", async () => {
    const prt = offboardPorts();
    await onboarded(prt);
    await runSteps(prt);
    expect(prt.github.hooksFor("x", "acme")).toEqual([]);
    expect(await prt.registrations.readBuildRegistration("acme")).toBeNull();
    expect(prt.seeder.deletedBuildRepoPats).toEqual([{ consumerName: "acme" }]);
    expect(prt.seeder.deletedApp).toEqual([]);
  });

  it("leaves the webhook standing when its removal fails soft, and assert-no-orphans names it instead of recording success", async () => {
    const prt = offboardPorts();
    await onboarded(prt);
    // The planted defect: remove-webhook did nothing, as it does when the identity cannot open the repository.
    await expect(runSteps(prt, ["remove-webhook"])).rejects.toThrow(/left 1 object\(s\) standing: push webhook https:\/\/build\./);
    expect(prt.github.hooksFor("x", "acme")).toHaveLength(1);
  });

  it("does not count a hook of another address as a leftover", async () => {
    const prt = offboardPorts();
    await onboarded(prt);
    prt.github.seedHook("x", "acme", "https://ci.example.org/other-service");
    await runSteps(prt);
    expect(prt.github.hooksFor("x", "acme").map((h) => h.targetUrl)).toEqual(["https://ci.example.org/other-service"]);
  });

  it("fails at watch-removal while ArgoCD still holds the build Application, and passes once it is pruned", async () => {
    const lingering = offboardPorts("Healthy");
    await onboarded(lingering);
    await expect(runSteps(lingering)).rejects.toThrow(/was not pruned/);
    expect(lingering.seeder.deletedBuildRepoPats).toEqual([]);
  });

  it("is idempotent: the steps after the attestation run again over a finished offboard without failing", async () => {
    const prt = offboardPorts();
    await onboarded(prt);
    await runSteps(prt);
    await runSteps(prt, ["attest-target"]);
    expect(await prt.registrations.readBuildRegistration("acme")).toBeNull();
  });

  it("does not touch the registration of a unit that releases when its attestation refuses", async () => {
    const prt = offboardPorts();
    await prt.registrations.commitRegistration({ unit: { name: "acme", repoURL: REPO, suspended: false, quiesced: false }, builds: ["acme-api"], runId: "run_2" });
    await expect(runSteps(prt)).rejects.toThrow(/not a CI-only unit/);
    expect((await prt.registrations.readBuildRegistration("acme"))?.entry.builds).toEqual(["acme-api"]);
  });
});
