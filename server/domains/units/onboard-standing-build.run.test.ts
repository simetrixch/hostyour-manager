import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { seedUnitSizes } from "#unit/server/unit-size.ts";
import { recordTestOwners } from "./tenant-apps-repo.fixture.ts";
import { openDb, type DbHandle } from "../../db/client.ts";
import { servers, clusters } from "../../db/schema/inventory.ts";
import { makeOnboardDef, type OnboardParams, type OnboardPorts } from "./onboard.run.ts";
import { FakeGateRunner } from "../../adapters/gate-runner/testing/fake.ts";
import { FakeMasterArgoReader } from "../../adapters/kube/testing/fake.ts";
import { FakeGitHubConsumer } from "#unit/server/adapters/github-consumer/testing/fake.ts";
import type { StepCtx } from "../../executor/types.ts";
import type { CredentialStore } from "../../security/store.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { ConsumerManifest } from "../../../shared/consumer.ts";
import { SHA, BUILD_ONLY_MANIFEST, passReport, ports, FakeSeeder } from "./onboard.fixture.ts";

let db: DbHandle;
beforeEach(() => { db = openDb(":memory:"); recordTestOwners(db.db); seedUnitSizes(db.db); });
afterEach(() => { db.sqlite.close(); });
const BASE = { repoURL: "https://github.com/x/acme.git" };
function seedClusters(): void {
  db.db.insert(servers).values({ id: "srv_1", name: "m1", host: "1.2.3.4", sshUser: "root", role: "master", status: "healthy" }).run();
  db.db.insert(clusters).values({ id: "cls_1", serverId: "srv_1", stage: "prod", domain: "s1.example", name: "s1", status: "active" }).run();
}
function ctx(p: OnboardParams, stepName: string, logs: string[]): StepCtx {
  return {
    runId: "run_repeat", stepName, db: db.db, params: p,
    creds: { open: async () => Buffer.from("github_pat_test"), list: async () => [] } as unknown as CredentialStore,
    secrets: { get: () => undefined, wipe: () => undefined }, signal: new AbortController().signal,
    logger: {} as Logger,
    ssh: () => Promise.reject(new Error("no ssh")), openPasswordSession: () => Promise.reject(new Error("no ssh")),
    closePasswordSession: () => undefined, attest: () => Promise.reject(new Error("no attest")),
    log: (_s, text) => logs.push(text), checkpoint: () => undefined, readCheckpoint: () => undefined, registerCleanup: () => undefined,
  };
}

describe("repeat a standing build-only onboarding", () => {
    const manifest: ConsumerManifest = { ...BUILD_ONLY_MANIFEST, builds: [
      ...BUILD_ONLY_MANIFEST.builds, { name: "acme-ui", containerfile: "frontend/Containerfile" },
    ] };
    const request = { consumerName: "acme", repoURL: BASE.repoURL, repoCredentialId: "cred_pat", owner: "team-acme", version: "1.0.0", channel: "stable", stage: "prod" };
    async function standing(repoURL = BASE.repoURL, rendered = ["acme-api", "acme-ui"]) {
      seedClusters();
      const prt = ports({
        runner: new FakeGateRunner({ report: passReport(manifest) }),
        buildArgo: new FakeMasterArgoReader({ everyName: {
          syncRevision: SHA, targetRevision: null, sync: "Synced", health: "Healthy",
          syncSources: [{ repoURL: "https://github.com/x/cloud.git", revision: SHA, valuesObject: { unit: { buildsJson: JSON.stringify(rendered) } } }],
        } }),
      });
      await prt.registrations.commitRegistration({
        unit: { name: "acme", repoURL, owner: "original-owner", onboardedAt: "2026-01-01T00:00:00.000Z", suspended: false, quiesced: false },
        builds: ["acme-api"], runId: "run_original",
      });
      return prt;
    }
    const streamCtx = () => ({ db: db.db, log: () => undefined, signal: new AbortController().signal });
    async function plan(prt: OnboardPorts) {
      const result = await makeOnboardDef(prt).planStream!(request, streamCtx());
      expect(result.outcome).toBe("planned");
      if (result.outcome !== "planned") throw new Error("standing onboarding was not planned");
      return result;
    }

    it("plans only gated re-attestation and the existing release chain", async () => {
      const prt = await standing();
      const result = await plan(prt);
      expect(result.plan.steps.map((s) => s.name)).toEqual([
        "preflight-scopes", "check", "re-attest-builds", "inject-release-kit", "trigger-release", "watch-release-build", "record",
      ]);
      expect(makeOnboardDef(prt).steps(result.params).map((s) => s.name)).toEqual(result.plan.steps.map((s) => s.name));
      expect(makeOnboardDef(prt).cleanups!(result.params)).toEqual([]);
    });

    it("keeps standing metadata, secrets and the hook, and arms no creation inverse", async () => {
      const prt = await standing();
      const github = prt.github as FakeGitHubConsumer;
      github.seedHook("x", "acme", "https://existing-build.example/github");
      const hook = github.hooksFor("x", "acme");
      const result = await plan(prt);
      const armed: string[] = [];
      for (const step of makeOnboardDef(prt).steps(result.params)) {
        await step.run({ ...ctx(result.params, step.name, []), registerCleanup: (cleanup) => { armed.push(cleanup.name); } });
      }
      expect((await prt.registrations.readBuildRegistration("acme"))?.entry).toMatchObject({
        owner: "original-owner", onboardedAt: "2026-01-01T00:00:00.000Z", suspended: false, quiesced: false, builds: ["acme-api", "acme-ui"],
      });
      expect((prt.seeder as FakeSeeder).buildRepoPats).toEqual([]);
      expect(github.hooksFor("x", "acme")).toEqual(hook);
      expect(armed).toEqual([]);
      expect(github.dispatches).toHaveLength(1);
    });

    it("refuses a different repository rather than replacing the standing identity", async () => {
      const prt = await standing("https://github.com/other/acme.git");
      await expect(makeOnboardDef(prt).planStream!(request, streamCtx())).rejects.toThrow(/repository.*match|match.*repository/);
      expect((await prt.registrations.readBuildRegistration("acme"))?.entry.repoURL).toBe("https://github.com/other/acme.git");
    });

    it("waits for the exact rendered producer set before dispatching, including on retry", async () => {
      const prt = await standing(BASE.repoURL, ["acme-api"]);
      const result = await plan(prt);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const reattest = makeOnboardDef(prt).steps(result.params).find((s) => s.name === "re-attest-builds");
        expect(reattest).toBeDefined();
        await expect(reattest!.run(ctx(result.params, reattest!.name, []))).rejects.toThrow(/does not render the builds/);
      }
      expect((prt.github as FakeGitHubConsumer).dispatches).toEqual([]);
      expect((await prt.registrations.readBuildRegistration("acme"))?.entry.builds).toEqual(["acme-api", "acme-ui"]);
      expect(makeOnboardDef(prt).cleanups!(result.params)).toEqual([]);
    });
});
