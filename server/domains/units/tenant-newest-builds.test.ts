import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDb, type DbHandle } from "../../db/client.ts";
import { servers, clusters } from "../../db/schema/inventory.ts";
import { buildUnitStep } from "./tenant-builds.ts";
import { planNewestUnits } from "./tenant-newest-builds.ts";
import { ports as onboardPorts } from "./onboard.fixture.ts";
import { recordTestOwners } from "./tenant-apps-repo.fixture.ts";
import { testMembers } from "./tenant-members.fixture.ts";
import { FakeRepoReader } from "../../adapters/git/testing/fake.ts";
import { FakeMasterArgoReader } from "../../adapters/kube/testing/fake.ts";
import { FakeBuildPlane } from "../../adapters/build-plane/testing/fake.ts";
import type { ArgoAppStatus } from "../../adapters/kube/port.ts";
import type { StepCtx } from "../../executor/types.ts";
import type { CredentialStore } from "../../security/store.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { FakeGitHubConsumer } from "#unit/server/adapters/github-consumer/testing/fake.ts";

// A tenant's own newest build (#289): which units build for it and at which tag it runs now, and the
// build step in its per-tenant form — skipped at the head the tenant runs, built with target build on
// the chosen channel, approved, and approved again on a resume without a second build.

const SHA = "a".repeat(40);
const GUID = "zsjs023ctne0";
const JOBS_REPO = "https://github.com/acme/example-jobs.git";
const JOBS_MANIFEST_YAML = `
apiVersion: hostyour.cloud/v1
kind: ConsumerManifest
name: example-jobs
owner: platform
envs: [dev, test, prod]
builds:
  - name: example-jobs
    containerfile: Containerfile
`;
const BUILT = "0.1.0-stable-20260926120000-bbbbbbb";

let db: DbHandle;
beforeEach(() => { db = openDb(":memory:"); recordTestOwners(db.db); });
afterEach(() => { db.sqlite.close(); });

function ctx(logs: string[], checkpoint: { value?: unknown } = {}): StepCtx {
  const creds = {
    seal: async () => { throw new Error("no seal"); },
    open: async () => Buffer.from("ghp_test"),
    list: async ({ kind }: { kind?: string } = {}) => [{ id: "cred_app", kind: "github-app", label: "GitHub App (acme)", fingerprint: "sha256:app", subject: { kind: "owner", id: "acme" }, purpose: "repository-identity" }].filter((r) => !kind || r.kind === kind),
  };
  return {
    runId: "run_new", stepName: "newest-build:example-jobs", db: db.db, creds: creds as unknown as CredentialStore, params: {},
    secrets: { get: () => undefined, wipe: () => undefined }, signal: new AbortController().signal, logger: {} as unknown as Logger,
    ssh: () => Promise.reject(new Error("no ssh")), openPasswordSession: () => Promise.reject(new Error("no ssh")),
    closePasswordSession: () => undefined, attest: () => Promise.reject(new Error("no attest")),
    log: (_s, t) => logs.push(t), checkpoint: (d) => { checkpoint.value = d; }, readCheckpoint: <T>() => checkpoint.value as T | undefined, registerCleanup: () => undefined,
  };
}

async function standing(manifest = JOBS_MANIFEST_YAML) {
  db.db.insert(servers).values({ id: "srv_m", name: "m1", host: "5.6.7.8", sshUser: "root", role: "master", status: "healthy" }).run();
  db.db.insert(clusters).values({ id: "cls_m", serverId: "srv_m", stage: "prod", domain: "m1.example", name: "m1", status: "active" }).run();
  const buildPlane = new FakeBuildPlane();
  buildPlane.seedReleaseRun("example-jobs", { runName: "example-jobs-release-3", releaseTag: "0.1.0-stable-20260926120000", imageTag: BUILT, succeeded: true });
  const buildArgo = new FakeMasterArgoReader({ statuses: new Map([["example-jobs-build", {
    syncRevision: null, targetRevision: null, sync: "Synced", health: "Healthy",
    syncSources: [{ repoURL: "https://github.com/x/hostyour-cloud.git", revision: SHA, path: "clusters/inventories/consumer-build", valuesObject: { unit: { name: "example-jobs", buildsJson: JSON.stringify(["example-jobs"]) } } }],
  } as ArgoAppStatus]]) });
  const onboard = onboardPorts({ repo: new FakeRepoReader({ resolvedSha: SHA, files: { "deploy/platform.yaml": manifest } }), buildPlane, buildArgo });
  await onboard.registrations.commitRegistration({
    unit: { name: "example-jobs", repoURL: JOBS_REPO, owner: "team-acme", onboardedAt: "2026-01-01T00:00:00.000Z", suspended: false, quiesced: false },
    builds: ["example-jobs"], runId: "run_old",
  });
  const unit = { unit: "example-jobs", repoURL: JOBS_REPO, images: ["example-jobs"], registered: true, form: "build-only" as const };
  const approved: { tag: string; builds: readonly string[] }[] = [];
  const step = (runningTag: string) => buildUnitStep(() => ({ ports: onboard }), { guid: GUID, owner: "team-acme", stage: "prod" }, unit, {
    channel: "stable", runningTag, approve: async (_ctx, tag, builds) => { approved.push({ tag, builds }); },
  });
  return { onboard, buildPlane, approved, step };
}

describe("planNewestUnits — the units that build what this tenant's members pin", () => {
  it("takes the tenant's approval over the stage pin, and names every unit it does not build", async () => {
    const members = testMembers(["erp"]);
    const r = await planNewestUnits({
      buildRepos: [
        { repo: JOBS_REPO, builds: ["example-jobs"] },
        { repo: "https://github.com/acme/example-platform.git", builds: ["example-engine"] },
        { repo: "https://github.com/acme/example-post.git", builds: ["example-post"] },
        { repo: "https://github.com/acme/example-web.git", builds: ["example-web"] },
      ],
      members,
      approved: { erp: { "example-engine": "0.4.1-stable-20260901000000-ccccccc" } },
      pinned: async (chart) => (chart === "charts/example-engine"
        ? [{ name: "example-engine", image: "example-engine", tag: "0.4.0-stable-20260801000000-ddddddd" }, { name: "example-jobs", image: "example-jobs", tag: "0.1.0-stable-20260801000000-eeeeeee" }, { name: "example-post", image: "example-post", tag: "1" }]
        : []),
      registration: async (unit) => (unit === "example-post" ? { form: "deployable" } : unit === "example-jobs" || unit === "example-platform" ? { form: "build-only" } : null),
    });
    expect(r.units.map((u) => [u.unit, u.runningTag])).toEqual([
      ["example-jobs", "0.1.0-stable-20260801000000-eeeeeee"],
      ["example-platform", "0.4.1-stable-20260901000000-ccccccc"],
    ]);
    expect(r.skipped).toEqual(["example-post: registered as deployable, released from its Consumers page", "example-web: no member of the tenant pins its builds"]);
  });
});

describe("buildUnitStep for one tenant", () => {
  it("builds nothing where the tenant already runs the unit's default branch head", async () => {
    const { buildPlane, approved, step } = await standing();
    const logs: string[] = [];
    await step(`0.1.0-stable-20260801000000-${SHA.slice(0, 7)}`).run(ctx(logs));
    expect(buildPlane.releaseWatches).toEqual([]);
    expect(approved).toEqual([]);
    expect(logs.some((l) => l.includes("nothing to build"))).toBe(true);
  });

  it("builds a unit whose manifest also deploys its own chart: a build for one tenant pins nothing either way", async () => {
    const { buildPlane, approved, step } = await standing(`${JOBS_MANIFEST_YAML}chart:
  path: deploy/chart
`);
    await step("0.1.0-stable-20260801000000-eeeeeee").run(ctx([]));
    expect(buildPlane.releaseWatches).toHaveLength(1);
    expect(approved).toEqual([{ tag: BUILT, builds: ["example-jobs"] }]);
  });

  it("builds on the chosen channel with target build, approves the built tag, and approves it again on a resume without a second build", async () => {
    const { onboard, buildPlane, approved, step } = await standing();
    const checkpoint: { value?: unknown } = {};
    await step("0.1.0-stable-20260801000000-eeeeeee").run(ctx([], checkpoint));
    const github = onboard.github as FakeGitHubConsumer;
    expect(github.dispatches.at(-1)?.inputs).toMatchObject({ channel: "stable", stage: "prod", target: "build" });
    expect(approved).toEqual([{ tag: BUILT, builds: ["example-jobs"] }]);
    expect(buildPlane.releaseWatches).toHaveLength(1);
    await step("0.1.0-stable-20260801000000-eeeeeee").run(ctx([], checkpoint));
    expect(buildPlane.releaseWatches).toHaveLength(1);
    expect(approved).toHaveLength(2);
  });
});
