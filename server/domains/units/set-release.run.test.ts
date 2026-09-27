import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDb, type DbHandle } from "../../db/client.ts";
import { servers, clusters, apps } from "../../db/schema/inventory.ts";
import { makeSetReleaseDef, readConsumerVersions, type SetReleaseParams, type SetReleasePorts } from "./set-release.run.ts";
import { FakeClusterReader, FakeMasterArgoReader, FakeMasterProjectWriter, FakeClusterKubeResolver } from "../../adapters/kube/testing/fake.ts";
import type { ArgoAppStatus } from "../../adapters/kube/port.ts";
import type { StepCtx } from "../../executor/types.ts";
import type { CredentialStore } from "../../security/store.ts";
import type { Logger } from "../../kernel/logger.ts";
import { FakeGitHubConsumer } from "#unit/server/adapters/github-consumer/testing/fake.ts";
import type { BuildPorts } from "#unit/server/build-chain.ts";
import { seedCredentialRow } from "../../security/store.fixture.ts";

// Putting a release that stands on its stage again (#299): what runs now is read off the
// delivery branch, a release minted before it is a downgrade the plan says, and the delivery is proven
// by the branch standing on the release and the Application synced at its head.

const REPO = "https://github.com/acme-org/acme.git";
const V10 = "0.1.10-stable-20260920100000";
const V11 = "0.1.11-stable-20260925100000";
const V12 = "0.1.12-stable-20260926100000";
const BETA = "0.1.13-beta-20260927100000";
const commit = (c: string): string => c.repeat(40);

let db: DbHandle;
beforeEach(() => {
  db = openDb(":memory:");
  db.db.insert(servers).values({ id: "srv_1", name: "m1", host: "1.2.3.4", sshUser: "root", role: "master", status: "healthy" }).run();
  db.db.insert(clusters).values({ id: "cls_1", serverId: "srv_1", stage: "prod", domain: "s1.example", name: "s1", status: "active" }).run();
  seedCredentialRow(db.db, { id: "cred_pat_acme", kind: "pat", label: "repository PAT (acme-org)", subject: { kind: "owner", id: "acme-org" }, purpose: "repository-pat" });
  db.db.insert(apps).values({ id: "app_1", clusterId: "cls_1", name: "acme", host: "acme", stage: "prod", repoUrl: REPO, chartPath: "deploy/chart", provenance: "manager", status: "active" }).run();
});
afterEach(() => { db.sqlite.close(); });

/** The repository: three stable releases and a beta, the deploy refs and a tag outside the grammar
 *  beside them, and deploy/prod on the pin commit made on top of `running`'s commit. */
function repository(running: string): FakeGitHubConsumer {
  const github = new FakeGitHubConsumer();
  github.seedTags("acme-org", "acme", [
    { name: V10, commit: commit("a") }, { name: V11, commit: commit("b") }, { name: V12, commit: commit("c") }, { name: BETA, commit: commit("d") },
    { name: `deploy/prod/${V12}`, commit: commit("c") }, { name: "v2", commit: commit("e") },
  ]);
  const released = { [V10]: commit("a"), [V11]: commit("b"), [V12]: commit("c") }[running]!;
  github.seedBranch("acme-org", "acme", "deploy/prod", { sha: commit("f"), parents: [released] });
  return github;
}

function ports(github: FakeGitHubConsumer, argo: ArgoAppStatus | null = null): SetReleasePorts {
  const cluster = new FakeClusterReader({ deployState: { domain: "s1.example", stage: "prod", writtenAt: "x", generation: 1 } });
  return {
    resolver: new FakeClusterKubeResolver({ clusterReader: cluster, argoReader: new FakeMasterArgoReader({ status: argo }), projectWriter: new FakeMasterProjectWriter(), argoNamespace: "argocd" }),
    github,
    store: { open: async () => Buffer.from("ghp_owner"), list: async () => [{ id: "cred_pat_acme", kind: "pat", subject: { kind: "owner", id: "acme-org" }, purpose: "repository-pat" }] } as unknown as CredentialStore,
    build: { channelStages: async () => ({ alpha: ["dev"], beta: ["dev", "test"], stable: ["dev", "test", "prod"] }) } as unknown as BuildPorts,
  } as unknown as SetReleasePorts;
}

const planCtx = () => ({ db: db.db, log: () => undefined, signal: new AbortController().signal });

async function plan(github: FakeGitHubConsumer, tag: string) {
  return makeSetReleaseDef(ports(github)).planStream!({ appId: "app_1", tag }, planCtx());
}

describe("set-release — the plan", () => {
  it("plans a release minted before the running one as a downgrade, with what the steps act with", async () => {
    const out = await plan(repository(V12), V10);
    if (out.outcome !== "planned") throw new Error(`rejected: ${out.summary}`);
    expect(out.plan.summary).toContain(`"acme" on prod (s1.example), where ${V12} runs now`);
    expect(out.plan.summary).toContain(`Downgrade: ${V10} is older than ${V12}.`);
    expect(out.plan.warnings).toEqual([`downgrade: "acme" goes back from ${V12} to ${V10} — only the release moves back; a database the newer release migrated stays migrated, and the older release must run on it`]);
    expect(out.plan.steps.map((s) => s.name)).toEqual(["attest-target", "inject-release-kit", "put-release", "watch-delivery"]);
    expect(out.params).toMatchObject({ consumerName: "acme", version: "0.1.10", channel: "stable", stage: "prod", releaseCommit: commit("a"), repoCredentialId: "cred_pat_acme" });
  });

  it("THE INNOCENT NEIGHBOUR: a release minted after the running one is no downgrade", async () => {
    const out = await plan(repository(V11), V12);
    if (out.outcome !== "planned") throw new Error(`rejected: ${out.summary}`);
    expect(out.plan.summary).toContain(`where ${V11} runs now`);
    expect(out.plan.summary).not.toContain("Downgrade");
    expect(out.plan.warnings).toEqual([]);
  });

  it("refuses a tag the repository does not carry, the release that already runs, and a channel that does not reach the stage", async () => {
    const summary = async (tag: string): Promise<string> => {
      const out = await plan(repository(V12), tag);
      if (out.outcome !== "rejected") throw new Error(`planned ${tag}`);
      return out.summary;
    };
    expect(await summary("0.1.9-stable-20260910100000")).toMatch(/carries no release tag 0\.1\.9-stable-20260910100000/);
    expect(await summary(V12)).toMatch(/it runs 0\.1\.12-stable-20260926100000 already/);
    expect(await summary(BETA)).toMatch(/the beta channel reaches dev, test \(global\.channelStages\)/);
  });

  it("offers the repository as one part: its releases newest first, the running one and every older one marked, nothing outside the grammar and no channel the stage does not take", async () => {
    const channelStages = async () => ({ alpha: ["dev" as const], beta: ["dev" as const, "test" as const], stable: ["dev" as const, "test" as const, "prod" as const] });
    const offer = await readConsumerVersions({ ...ports(repository(V11)), channelStages }, db.db, "app_1");
    expect(offer).toEqual({
      stage: "prod",
      parts: [{ name: "acme", builds: [], running: [V11], versions: [{ tag: V12, older: false }, { tag: V11, older: false }, { tag: V10, older: true }] }],
    });
  });
});

describe("set-release — watch-delivery", () => {
  const params = (releaseCommit: string): SetReleaseParams => ({
    appId: "app_1", tag: V10, consumerName: "acme", repoURL: REPO, repoCredentialId: "cred_pat_acme",
    version: "0.1.10", channel: "stable", stage: "prod", releaseCommit,
  });
  const ctx = (logs: string[]): StepCtx => ({
    runId: "run_rel", stepName: "watch-delivery", db: db.db, params: {},
    creds: { open: async () => Buffer.from("ghp_owner") } as unknown as CredentialStore,
    secrets: { get: () => undefined, wipe: () => undefined }, signal: new AbortController().signal, logger: {} as unknown as Logger,
    ssh: () => Promise.reject(new Error("no ssh")), openPasswordSession: () => Promise.reject(new Error("no ssh")),
    closePasswordSession: () => undefined, attest: () => Promise.reject(new Error("no attest")),
    log: (_s, t) => logs.push(t), checkpoint: () => undefined, readCheckpoint: () => undefined, registerCleanup: () => undefined,
  });
  const synced: ArgoAppStatus = { syncRevision: commit("f"), targetRevision: null, sync: "Synced", health: "Healthy" };
  const watch = (github: FakeGitHubConsumer, releaseCommit: string, argo: ArgoAppStatus) =>
    makeSetReleaseDef(ports(github, argo)).steps(params(releaseCommit)).find((s) => s.name === "watch-delivery")!;

  it("takes the delivery once deploy/<stage> stands on the release and the Application is Synced at its head", async () => {
    const logs: string[] = [];
    await watch(repository(V10), commit("a"), synced).run(ctx(logs));
    expect(logs.some((l) => l.includes(`is Synced at ffffff`) && l.includes(`runs ${V10}`))).toBe(true);
  });

  it("PLANTED DEFECT: refuses a branch that stands on another release, however Synced the Application is", async () => {
    await expect(watch(repository(V12), commit("a"), synced).run(ctx([]))).rejects.toThrow(/deploy\/prod of .* stands on fffffff, not on 0\.1\.10-stable/);
  });
});
