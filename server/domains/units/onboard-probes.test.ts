import { dropCredentialRows } from "../../security/store.fixture.ts";
import { recordTestOwners } from "./tenant-apps-repo.fixture.ts";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDb, type DbHandle } from "../../db/client.ts";
import { clusters, servers } from "../../db/schema/inventory.ts";
import { OnboardParams, type DeployableOnboardParams } from "./onboard.run.ts";
import { probeTarget, probeIdentity, probePackages, probeWebhook, probeDns } from "./onboard-probes.ts";
import { ports, SHA, emptyZone } from "./onboard.fixture.ts";
import { FakeGitHubConsumer } from "../../adapters/github-consumer/testing/fake.ts";
import { FakeRepoReader } from "../../adapters/git/testing/fake.ts";
import { FakeClusterReader, FakeClusterKubeResolver, FakeMasterArgoReader, FakeMasterProjectWriter } from "../../adapters/kube/testing/fake.ts";
import type { ProbeCtx } from "../../executor/probe.ts";

// WHAT THE CONSUMER ONBOARDING MEASURES BEFORE THE APPROVE (#208), each probe against the fakes:
// the finding it answers where the world is right, and the one it answers — hard, by name, with the
// way out — where it is not. A port that is not wired is "not measured", never a failure.

const REPO = "https://github.com/x/acme.git";
let db: DbHandle;
beforeEach(() => { db = openDb(":memory:"); recordTestOwners(db.db); });
afterEach(() => { db.sqlite.close(); });

function params(over: Partial<OnboardParams> = {}): DeployableOnboardParams {
  return OnboardParams.parse({
    form: "deployable", consumerName: "acme", repoURL: REPO, owner: "team-acme",
    version: "1.0.0", channel: "stable", builds: ["acme-api"], repoCredentialId: "cred_pat", resolvedSha: SHA, chartPath: "deploy/chart",
    domain: "s1.example", stage: "prod", clusterId: "cls_1", cluster: "s1", namespace: "acme-prod", unitApex: "example.com", host: "acme",
    report: { contractVersion: "1.5", runnerVersion: "t", repoURL: REPO, requestedRef: SHA, resolvedSha: SHA, startedAt: 1, finishedAt: 2, manifest: null, dependencies: [], gates: [], verdict: "pass", reportHash: "h", sandbox: { mustFailTargets: [], mustFailTargetsDeclaredListening: true, mustFailDenied: true, managerAddrDenied: true, mustPassReached: true } },
    argoAppName: "acme-prod", ...over,
  }) as DeployableOnboardParams;
}

/** A probe context whose credential store opens one PAT (or an App row where `viaApp`), or what `open` answers per id. */
function ctx(o: { token?: string; viaApp?: boolean; open?: (id: string) => string } = {}): ProbeCtx {
  return {
    db: db.db,
    creds: {
      open: async (id: string) => Buffer.from(o.open ? o.open(id) : (o.token ?? "ghp_test")),
      list: async (q?: { kind?: string }) => (o.viaApp && q?.kind === "github-app" ? [{ id: "cred_pat" }] : []),
    } as unknown as ProbeCtx["creds"],
    params: {}, signal: new AbortController().signal, log: () => undefined,
  };
}

describe("probeTarget — the deploy-state of the target", () => {
  it("passes on a fresh deploy-state naming this domain, fails by name on a mismatch or an absence", async () => {
    expect(await probeTarget(ports(), params())).toMatchObject([{ id: "target.deploy-state", status: "pass", detail: "deploy-state generation 3" }]);
    const other = ports({ cluster: new FakeClusterReader({ deployState: { domain: "s9.example", stage: "prod", writtenAt: "2026-01-01T00:00:00Z", generation: 1 }, smoke: { namespaceExists: true, workloads: [], externalSecretsReady: true } }) });
    expect(await probeTarget(other, params())).toMatchObject([{ status: "fail", severity: "hard", detail: "reports s9.example in its deploy-state" }]);
    const none = ports({ resolver: new FakeClusterKubeResolver({ clusterReader: new FakeClusterReader({ deployState: null, smoke: { namespaceExists: true, workloads: [], externalSecretsReady: true } }), argoReader: new FakeMasterArgoReader({ status: { syncRevision: SHA, targetRevision: null, sync: "Synced", health: "Healthy" } }), projectWriter: new FakeMasterProjectWriter(), argoNamespace: "argocd" }) });
    expect(await probeTarget(none, params())).toMatchObject([{ status: "fail", detail: "carries no hostyour-cloud deploy-state" }]);
  });
});

describe("probeIdentity — a PAT's scopes, or the App", () => {
  it("passes on a classic PAT with every scope, fails naming the missing ones, and names a fine-grained token", async () => {
    const github = new FakeGitHubConsumer();
    expect(await probeIdentity(ports({ github }), params(), ctx())).toMatchObject([{ id: "identity", status: "pass" }]);
    github.tokenScopes = { classic: true, scopes: ["repo"] };
    expect(await probeIdentity(ports({ github }), params(), ctx())).toMatchObject([{ status: "fail", severity: "hard", detail: "the PAT lacks workflow, admin:repo_hook" }]);
    github.tokenScopes = { classic: false, scopes: [] };
    expect((await probeIdentity(ports({ github }), params(), ctx()))[0]?.detail).toContain("fine-grained");
  });
  it("passes on the App, whose token the store minted a moment ago; says not measured where no client is wired", async () => {
    expect(await probeIdentity(ports(), params(), ctx({ viaApp: true }))).toMatchObject([{ status: "pass", detail: "the platform's GitHub App reaches it and minted a token" }]);
    const { github: _unwired, ...withoutGitHub } = ports();
    expect(await probeIdentity(withoutGitHub, params(), ctx())).toMatchObject([{ status: "warn", severity: "soft", detail: "not measured: no GitHub client is wired on this manager" }]);
  });
});

describe("probePackages — one private package per scope the repository routes to GitHub Packages", () => {
  const NPMRC = "@acme:registry=https://npm.pkg.github.com\n//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}\n";
  const LOCK = "packages:\n  '@acme/components@0.1.0':\n    resolution: {integrity: sha512-x}\n";
  const repo = () => new FakeRepoReader({ resolvedSha: SHA, files: { ".npmrc": NPMRC, "pnpm-lock.yaml": LOCK } });

  // The token that reads is the owner's packages reader (#220), opened by the id the
  // owner record names for the owner of the repository — never the unit's own credential.
  it("passes where the owner's packages reader reads the package, fails by name where it cannot, and refuses an owner without one", async () => {
    const github = new FakeGitHubConsumer();
    github.packages.set("@acme/components", ["ghp_packages_x"]);
    const opened: string[] = [];
    const c = ctx({ open: (id) => { opened.push(id); return id === "cred_pkg_x" ? "ghp_packages_x" : "ghp_test"; } });
    expect(await probePackages(ports({ github, repo: repo() }), params(), c)).toMatchObject([{ id: "packages.acme", status: "pass", detail: "@acme/components is readable with the packages reader of x" }]);
    expect(opened).toEqual(["cred_pkg_x"]);
    github.packages.set("@acme/components", ["ghp_other"]);
    expect(await probePackages(ports({ github, repo: repo() }), params(), c))
      .toMatchObject([{ status: "fail", severity: "hard", detail: "@acme/components is not readable with the packages reader of x", hint: "record a packages reader of x that also reads @acme in the consumer wizard" }]);
    dropCredentialRows(db.db, { kind: "owner", id: "x" });
    expect(await probePackages(ports({ github, repo: repo() }), params(), c)).toMatchObject([{ id: "packages", status: "fail", detail: expect.stringContaining("owner x records no packages reader, and x/acme installs private npm packages of @acme") }]);
  });
  it("warns where the package is not published, and passes softly where no scope is routed there", async () => {
    const github = new FakeGitHubConsumer();
    expect(await probePackages(ports({ github, repo: repo() }), params(), ctx())).toMatchObject([{ status: "warn", detail: "@acme/components is not published there" }]);
    expect(await probePackages(ports({ github }), params(), ctx())).toMatchObject([{ id: "packages", status: "pass", severity: "soft", detail: "the repository routes no scope to GitHub Packages — no packages reader needed" }]);
    // ... and no reader is asked for either (#221).
    dropCredentialRows(db.db, { kind: "owner", id: "x" });
    expect(await probePackages(ports({ github }), params(), ctx())).toMatchObject([{ id: "packages", status: "pass", severity: "soft" }]);
  });
});

describe("probeWebhook — the hooks readable with the identity", () => {
  it("passes whether a hook already stands at the build plane or not, and fails by name without admin:repo_hook", async () => {
    const github = new FakeGitHubConsumer();
    const prt = ports({ github });
    expect(await probeWebhook(prt, params(), ctx())).toMatchObject([{ id: "webhook", status: "pass", detail: "the hooks are readable; the run creates one at https://build.m1.example/github" }]);
    await github.ensureHook({ owner: "x", repo: "acme", token: "t", targetUrl: "https://build.m1.example/github", secret: "s", events: ["push"], contentType: "json" });
    expect((await probeWebhook(prt, params(), ctx()))[0]?.detail).toContain("already stands");
    github.scopeError = true;
    expect(await probeWebhook(prt, params(), ctx())).toMatchObject([{ status: "fail", severity: "hard", hint: "provide a PAT with admin:repo_hook" }]);
  });

  it("names the account and its right where a PAT without admin is refused, and whose PAT to record (#252)", async () => {
    const github = new FakeGitHubConsumer();
    github.scopeError = true;
    github.tokenAccess = { login: "kartalbas", ownerKind: "User", repoPermission: "push" };
    const [finding] = await probeWebhook(ports({ github }), params(), ctx());
    expect(finding).toMatchObject({ status: "fail", severity: "hard" });
    expect(finding?.detail).toContain("the PAT acts as kartalbas, which holds push but not admin on x/acme, and a build webhook needs admin");
    expect(finding?.hint).toContain("replace the repository PAT of x under Settings with one x created");
    expect(await probeWebhook(ports({ github }), params(), ctx({ viaApp: true }))).toMatchObject([{ status: "fail", hint: "provide a PAT with admin:repo_hook" }]);
  });
});

describe("probeDns — the unit's record, judged as the step judges it", () => {
  it("free passes, ours passes, a leftover warns, and a host pointing at another cluster fails by name", async () => {
    const dns = emptyZone();
    const prt = ports({ dns });
    expect(await probeDns(prt, params(), ctx())).toMatchObject([{ id: "dns.record", status: "pass", detail: "is free; the run creates it" }]);
    dns.seed("acme.example.com", "CNAME", "s1.example");
    expect((await probeDns(prt, params(), ctx()))[0]?.detail).toContain("already points at s1.example");
    dns.seed("acme.example.com", "CNAME", "apps4.gone.example");
    expect(await probeDns(prt, params(), ctx())).toMatchObject([{ status: "warn", detail: "stands as CNAME apps4.gone.example, which points at no cluster of this installation; the run replaces it" }]);
    db.db.insert(servers).values({ id: "srv_2", name: "s2", host: "203.0.113.20", sshUser: "root", role: "slave", status: "healthy" }).run();
    db.db.insert(clusters).values({ id: "cls_2", serverId: "srv_2", stage: "prod", domain: "s2.example", name: "s2", status: "active", slaveId: 2 }).run();
    dns.seed("acme.example.com", "CNAME", "s2.example");
    expect(await probeDns(prt, params(), ctx())).toMatchObject([{ status: "fail", severity: "hard", detail: "points at s2.example, a cluster of this installation", hint: "offboard the unit there first" }]);
  });
});
