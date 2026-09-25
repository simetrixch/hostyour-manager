// The `refresh-repo-pat` step (plugins/unit/server/seed-repo-pat.ts): the unit's build repo-pat is rewritten,
// its three build Secrets are deleted behind the rewrite, and the step holds until ESO has
// materialized them again — read off the ExternalSecrets' refreshTime — before the release is
// dispatched. Kept apart from onboard.run.test.ts like the other per-step files; the step is built
// against the shared fixture's port set with only the build plane's cluster reader varied.
import { dropCredentialRows } from "../../security/store.fixture.ts";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDb, type DbHandle } from "../../db/client.ts";
import { recordTestOwners } from "./tenant-apps-repo.fixture.ts";
import { refreshRepoPatStep, seedRepoPatStep } from "#unit/server/seed-repo-pat.ts";
import { type OnboardPorts } from "./onboard.run.ts";
import { BuildOnlyParams } from "#unit/server/build-chain.ts";
import { BUILD_TARGET_SECRETS } from "#unit/server/app-token-refresh.ts";
import { ports, buildSecretRows, FakeBuildPlaneClusterReader, FakeSeeder, BUILD_SECRETS_MATERIALIZED_AT } from "./onboard.fixture.ts";
import { FakeClusterReader } from "../../adapters/kube/testing/fake.ts";
import { FakeRepoReader } from "../../adapters/git/testing/fake.ts";
import type { StepCtx } from "../../executor/types.ts";
import type { Logger } from "../../kernel/logger.ts";

const SHA = "a".repeat(40);
const NS = "acme-build";

let db: DbHandle;
beforeEach(() => { db = openDb(":memory:"); recordTestOwners(db.db); });
afterEach(() => { db.sqlite.close(); });
const DELETES = BUILD_TARGET_SECRETS.map((name) => ({ op: "delete" as const, namespace: NS, name }));

function params(): BuildOnlyParams {
  return BuildOnlyParams.parse({
    form: "build-only", consumerName: "acme", repoURL: "https://github.com/x/acme.git", owner: "team-acme",
    version: "1.0.0", channel: "stable", builds: ["acme-api"], repoCredentialId: "cred_app", resolvedSha: SHA,
    domain: "m1.example", stage: "prod",
    report: { contractVersion: "1.5", runnerVersion: "t", repoURL: "https://github.com/x/acme.git", requestedRef: SHA, resolvedSha: SHA, startedAt: 1, finishedAt: 2, manifest: null, dependencies: [], gates: [], verdict: "pass", reportHash: "h", sandbox: { mustFailTargets: [], mustFailTargetsDeclaredListening: true, mustFailDenied: true, managerAddrDenied: true, mustPassReached: true } },
  });
}

/** A store whose one credential opens to the token of the moment. */
function ctx(logs: string[], token = "ghs_minted_now"): StepCtx {
  const opened: string[] = [];
  return {
    runId: "run_onb", stepName: "refresh-repo-pat", db: db.db,
    // The one credential opens to the token of the moment; the owner's packages reader to its own.
    creds: { open: async (id: string) => { opened.push(id); return Buffer.from(id === "cred_pkg_x" ? "ghp_packages_x" : token, "utf8"); } } as unknown as StepCtx["creds"],
    params: params(), secrets: { get: () => undefined, wipe: () => undefined }, signal: new AbortController().signal, logger: {} as unknown as Logger,
    ssh: () => Promise.reject(new Error("no ssh")), openPasswordSession: () => Promise.reject(new Error("no ssh")),
    closePasswordSession: () => undefined, attest: () => Promise.reject(new Error("no attest")),
    log: (_s, t) => logs.push(t), checkpoint: () => undefined, readCheckpoint: () => undefined, registerCleanup: () => undefined,
  };
}

function step(over: Partial<OnboardPorts> = {}): { run: (c: StepCtx) => Promise<void>; seeder: FakeSeeder; prt: OnboardPorts } {
  const prt = ports(over);
  return { run: (c) => refreshRepoPatStep(prt, params()).run(c), seeder: prt.seeder as FakeSeeder, prt };
}

describe("onboard refresh-repo-pat step", () => {
  it("rewrites the entry, THEN deletes the three target Secrets by name in <unit>-build, and holds until their ExternalSecrets materialized them again", async () => {
    const kube = new FakeBuildPlaneClusterReader("acme");
    const { run, seeder } = step({ buildClusterReader: kube });
    const logs: string[] = [];
    await run(ctx(logs));
    expect(seeder.refreshedRepoPats).toEqual([{ consumerName: "acme", pat: "ghs_minted_now", packages: "ghp_packages_x" }]);
    expect(kube.secretWrites).toEqual(DELETES);
    // The order is the mechanism: a Secret deleted BEFORE the rewrite would make ESO materialize the
    // dead value, so the rewrite is logged first and the deletion after it.
    expect(logs.findIndex((l) => l.includes("rewritten (properties pat, packages)"))).toBeLessThan(logs.findIndex((l) => l.includes("deleted in acme-build")));
    expect(logs.at(-1)).toContain("build-git-https, bump-git-https, build-npmrc stand again in acme-build");
    // Read before the deletion and again after it — never off the Ready bit.
    expect(kube.listedExternalSecrets.length).toBeGreaterThanOrEqual(2);
    for (const l of logs) expect(l).not.toContain("ghs_minted_now");
  });

  it("polls: the Secrets are absent at first and present later, and the step proceeds only once every one of the three moved", async () => {
    // A plain reader with ESO scripted by hand: the rows keep their old refreshTime for a while after
    // the deletion, then two of the three move, then the third — the step must wait for the third.
    const kube = new FakeClusterReader({ externalSecretsByNamespace: { [NS]: buildSecretRows() } });
    const { run } = step({ buildClusterReader: kube, releasePollIntervalMs: 1, buildSecretsMaterializeMs: 5_000 });
    const later = "2026-01-01T00:00:05Z";
    setTimeout(() => kube.setExternalSecrets(NS, buildSecretRows().map((r) => (r.targetSecret === "build-npmrc" ? r : { ...r, refreshTime: later }))), 10);
    setTimeout(() => kube.setExternalSecrets(NS, buildSecretRows(later)), 25);
    const logs: string[] = [];
    await run(ctx(logs));
    // One read before the deletion, then more than one poll after it: the wait was a wait.
    expect(kube.listedExternalSecrets.length).toBeGreaterThan(3);
    expect(logs.at(-1)).toContain("stand again");
  });

  it("refuses BY NAME when the Secrets do not materialize again within the bound, naming the ones still missing and the namespace", async () => {
    // ESO never comes back: the rows keep the refreshTime read before the deletion.
    const kube = new FakeClusterReader({ externalSecretsByNamespace: { [NS]: buildSecretRows() } });
    const { run, seeder } = step({ buildClusterReader: kube, releasePollIntervalMs: 1, buildSecretsMaterializeMs: 20 });
    await expect(run(ctx([]))).rejects.toThrow(/build-git-https, bump-git-https, build-npmrc in acme-build did not materialize again within 0s of their deletion/);
    // The rewrite and the deletion did happen — what did not is the return, and the release was not dispatched.
    expect(seeder.refreshedRepoPats).toHaveLength(1);
    expect(kube.secretWrites).toEqual(DELETES);
  });

  it("names only the Secret still missing when two of the three came back", async () => {
    const kube = new FakeClusterReader({ externalSecretsByNamespace: { [NS]: buildSecretRows() } });
    const { run } = step({ buildClusterReader: kube, releasePollIntervalMs: 1, buildSecretsMaterializeMs: 20 });
    setTimeout(() => kube.setExternalSecrets(NS, buildSecretRows().map((r) => (r.targetSecret === "bump-git-https" ? r : { ...r, refreshTime: "2026-01-01T00:00:09Z" }))), 2);
    await expect(run(ctx([]))).rejects.toThrow(/^bump-git-https in acme-build did not materialize/);
  });

  it("an ExternalSecret that never materialized (no refreshTime at all) is still missing after the deletion, even though nothing moved", async () => {
    const kube = new FakeClusterReader({ externalSecretsByNamespace: { [NS]: buildSecretRows("") } });
    const { run } = step({ buildClusterReader: kube, releasePollIntervalMs: 1, buildSecretsMaterializeMs: 20 });
    await expect(run(ctx([]))).rejects.toThrow(/build-git-https, bump-git-https, build-npmrc in acme-build did not materialize/);
  });

  it("refuses by name, and writes NOTHING, when no build plane cluster reader is wired — a rewrite whose Secrets are not deleted is a release on the old token", async () => {
    const prt = ports();
    delete prt.buildClusterReader;
    await expect(refreshRepoPatStep(prt, params()).run(ctx([]))).rejects.toThrow(/requires the build plane's cluster reader/);
    expect((prt.seeder as FakeSeeder).refreshedRepoPats).toEqual([]);
  });

  it("the fixture's build plane reader models ESO's OnChange: a deletion moves the targeting row's refreshTime and nothing else", async () => {
    const kube = new FakeBuildPlaneClusterReader("acme");
    const before = await kube.listExternalSecrets(NS);
    expect(before.map((r) => r.refreshTime)).toEqual([BUILD_SECRETS_MATERIALIZED_AT, BUILD_SECRETS_MATERIALIZED_AT, BUILD_SECRETS_MATERIALIZED_AT]);
    await kube.deleteSecret(NS, "bump-git-https");
    const after = await kube.listExternalSecrets(NS);
    expect(after.find((r) => r.targetSecret === "bump-git-https")?.refreshTime).not.toBe(BUILD_SECRETS_MATERIALIZED_AT);
    expect(after.filter((r) => r.targetSecret !== "bump-git-https").map((r) => r.refreshTime)).toEqual([BUILD_SECRETS_MATERIALIZED_AT, BUILD_SECRETS_MATERIALIZED_AT]);
    expect(after.every((r) => r.ready)).toBe(true);
  });
});

// The packages reader is the build's business (#221): where the owner records none, the
// repository's .npmrc decides — no scope routed to GitHub Packages seeds an empty packages value,
// a routed scope refuses naming the owner and the scopes.
describe("onboard seed-repo-pat step — the packages reader where a scope is routed", () => {
  it("seeds an empty packages value for a repository routing no scope, and refuses one routing a scope where the owner records no reader", async () => {
    dropCredentialRows(db.db, { kind: "owner", id: "x" });
    const prt = ports();
    const logs: string[] = [];
    await seedRepoPatStep(prt, params()).run(ctx(logs, "ghs_repo"));
    expect((prt.seeder as FakeSeeder).buildRepoPats).toEqual([{ consumerName: "acme", pat: "ghs_repo", packages: "" }]);
    expect(logs.some((l) => l.includes("routes no scope to GitHub Packages — no packages reader needed"))).toBe(true);
    const routed = ports({ repo: new FakeRepoReader({ resolvedSha: SHA, files: { ".npmrc": "@x:registry=https://npm.pkg.github.com\n" } }) });
    await expect(seedRepoPatStep(routed, params()).run(ctx([], "ghs_repo")))
      .rejects.toThrow(/owner x records no packages reader, and x\/acme installs private npm packages of @x from GitHub Packages .* consumer wizard/);
  });
});
