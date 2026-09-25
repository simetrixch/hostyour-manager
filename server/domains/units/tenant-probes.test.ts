import { seedCredentialRow, dropCredentialRows } from "../../security/store.fixture.ts";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDb, type DbHandle } from "../../db/client.ts";
import { clusters, servers } from "../../db/schema/inventory.ts";
import type { TenantOnboardPorts, CreateTenantParams } from "./create-tenant.run.ts";
import type { BuildUnit, TenantBuildDeps } from "./tenant-builds.ts";
import { TenantRegistrations } from "./tenant-registrations.ts";
import { probeTenantTarget, probeCatalog, probeAppsRepository, probeBuildUnit, probeTenantDns } from "./tenant-probes.ts";
import { FakePlatformRepo } from "../../adapters/git/testing/fake.ts";
import { FakeGitHubApp } from "../../adapters/github-app/testing/fake.ts";
import { FakeGitHubConsumer } from "#unit/server/adapters/github-consumer/testing/fake.ts";
import { FakeClusterReader, FakeClusterKubeResolver, FakeMasterArgoReader, FakeMasterProjectWriter } from "../../adapters/kube/testing/fake.ts";
import { FakeDnsProvider } from "../../adapters/dns/testing/fake.ts";
import type { ProbeCtx } from "../../executor/probe.ts";

// WHAT THE TENANT ONBOARDING MEASURES BEFORE THE APPROVE (#209), each probe against the fakes and
// against exactly the ports it reads: the finding where the world is right, and the one — hard, by
// name, with the way out — where it is not. A unit whose PAT comes at approve is "not measured".

let db: DbHandle;
beforeEach(() => { db = openDb(":memory:"); });
afterEach(() => { db.sqlite.close(); });

const p = (over: Partial<CreateTenantParams> = {}): CreateTenantParams =>
  ({ guid: "acme1234abcd", subdomain: "acme", stage: "prod", clusterId: "cls_1", domain: "s1.example", replaces: [], ...over }) as unknown as CreateTenantParams;
const ports = (over: Partial<TenantOnboardPorts>): TenantOnboardPorts => over as TenantOnboardPorts;
const ctx = (): ProbeCtx => ({
  db: db.db, creds: { open: async () => Buffer.from("ghp_stored"), list: async () => [] } as unknown as ProbeCtx["creds"],
  params: {}, signal: new AbortController().signal, log: () => undefined,
});
const resolverWith = (deployState: { domain: string } | null): FakeClusterKubeResolver => new FakeClusterKubeResolver({
  clusterReader: new FakeClusterReader({ deployState: deployState ? { ...deployState, stage: "prod", writtenAt: "x", generation: 2 } : null }),
  argoReader: new FakeMasterArgoReader({}), projectWriter: new FakeMasterProjectWriter(), argoNamespace: "argocd",
});

describe("probeTenantTarget", () => {
  it("passes on the deploy-state naming this domain; fails by name on a mismatch and on an absence", async () => {
    expect(await probeTenantTarget(ports({ resolver: resolverWith({ domain: "s1.example" }) }), p())).toMatchObject([{ status: "pass", detail: "deploy-state generation 2" }]);
    expect(await probeTenantTarget(ports({ resolver: resolverWith({ domain: "s9.example" }) }), p())).toMatchObject([{ status: "fail", severity: "hard", detail: "reports s9.example in its deploy-state" }]);
    expect(await probeTenantTarget(ports({ resolver: resolverWith(null) }), p())).toMatchObject([{ status: "fail", detail: "carries no hostyour-cloud deploy-state" }]);
  });
});

describe("probeCatalog", () => {
  it("passes where the registrations read the catalog, fails by name where the read throws", async () => {
    const good = ports({ catalogRepoUrl: "https://github.com/acme/acme-catalog.git", registrations: new TenantRegistrations(new FakePlatformRepo()) });
    expect(await probeCatalog(good, p())).toMatchObject([{ id: "catalog.read", status: "pass", detail: "readable; 0 tenant(s) registered at prod" }]);
    const bad = ports({ catalogRepoUrl: "https://github.com/acme/acme-catalog.git", registrations: { listTenantGuids: async () => { throw new Error("401 from the catalog"); } } as unknown as TenantRegistrations });
    expect(await probeCatalog(bad, p())).toMatchObject([{ status: "fail", severity: "hard", detail: "cannot be read: 401 from the catalog", hint: "the manager's catalog credential or CATALOG_REPO is wrong" }]);
  });
});

describe("probeAppsRepository", () => {
  const unit = { org: "example-org", templateRepoURL: "https://github.com/example-org/example-apps.git", bundle: "example-apps", subdomain: "acme" };
  it("passes where the App is installed in the apps owner and reaches the template; fails by name otherwise", async () => {
    const githubApp = new FakeGitHubApp();
    expect(await probeAppsRepository(ports({ githubApp }), unit, ctx())).toMatchObject([
      { id: "apps.org", status: "pass", detail: "the platform's GitHub App is installed in example-org" },
      { id: "apps.template", status: "pass" },
    ]);
    githubApp.reachable.set("example-org/example-apps", false);
    expect((await probeAppsRepository(ports({ githubApp }), unit, ctx()))[1]).toMatchObject({ status: "fail", hint: "install the App on the template's repository" });
    expect((await probeAppsRepository(ports({ githubApp }), { ...unit, org: "other-org" }, ctx()))[0]).toMatchObject({ status: "fail", detail: "the platform's GitHub App is installed in example-org, not in other-org" });
    expect(await probeAppsRepository(ports({}), unit, ctx())).toMatchObject([{ status: "fail", detail: "no GitHub App is configured on this manager" }]);
  });
});

describe("probeBuildUnit", () => {
  const base = { unit: "example-jobs", repoURL: "https://github.com/example-org/example-jobs.git", images: ["example-jobs"], registered: false };
  // The owner's identity, judged (#220): the App where it reaches, the owner's
  // repository PAT else, a refusal naming the owner where it records nothing.
  it("judges an unregistered unit's identity: the App where it reaches, the owner's repository PAT else, a refusal where the owner records nothing", async () => {
    seedCredentialRow(db.db, { id: "cred_pkg", kind: "pat", label: "packages reader (example-org)", subject: { kind: "owner", id: "example-org" }, purpose: "packages-reader" });
    const githubApp = new FakeGitHubApp();
    expect(await probeBuildUnit(() => undefined, ports({ githubApp }), p(), base as BuildUnit, ctx())).toMatchObject([{ status: "pass", detail: "reached by the platform's GitHub App; its packages read with the owner's packages reader" }]);
    githubApp.reachable.set("example-org/example-jobs", false);
    expect(await probeBuildUnit(() => undefined, ports({ githubApp }), p(), base as BuildUnit, ctx())).toMatchObject([{ status: "fail", detail: expect.stringContaining("records no repository PAT") }]);
    seedCredentialRow(db.db, { id: "cred_pat", kind: "pat", label: "repository PAT (example-org)", subject: { kind: "owner", id: "example-org" }, purpose: "repository-pat" });
    expect(await probeBuildUnit(() => undefined, ports({ githubApp }), p(), base as BuildUnit, ctx())).toMatchObject([{ status: "pass", detail: "its owner's repository PAT; its packages read with the owner's packages reader" }]);
    dropCredentialRows(db.db, { kind: "owner", id: "example-org" });
    expect(await probeBuildUnit(() => undefined, ports({ githubApp }), p(), base as BuildUnit, ctx())).toMatchObject([{ status: "fail", detail: expect.stringContaining("owner example-org records no repository PAT") }]);
  });
  it("a registered unit's stored credential reads the hooks; without admin:repo_hook it fails by name", async () => {
    const github = new FakeGitHubConsumer();
    const deps = (): TenantBuildDeps => ({ ports: { github, resolveBuildPlaneFqdn: async () => "m1.example", webhookSubdomain: "build" } } as unknown as TenantBuildDeps);
    const registered = { ...base, registered: true } as BuildUnit;
    // A registered unit is reached with its owner's identity, resolved now (#226): the App installed
    // with example-org, its one row in the store.
    const app = new FakeGitHubApp();
    const withApp = (): ProbeCtx => ({ ...ctx(), creds: { open: async () => Buffer.from("ghp_stored"), list: async () => [{ id: "cred_app", kind: "github-app", subject: { kind: "owner", id: app.org }, purpose: "repository-identity" }] } as unknown as ProbeCtx["creds"] });
    expect(await probeBuildUnit(deps, ports({ githubApp: app }), p(), registered, withApp())).toMatchObject([{ status: "pass", detail: "its stored credential reads the hooks; the re-release sets the build hook" }]);
    github.scopeError = true;
    expect(await probeBuildUnit(deps, ports({ githubApp: app }), p(), registered, withApp())).toMatchObject([{ status: "fail", severity: "hard", hint: "re-onboard the unit with a PAT holding admin:repo_hook" }]);
  });
});

describe("probeTenantDns — the tenant's wildcard record", () => {
  it("free passes, ours passes, a leftover warns, a wildcard pointing at another cluster fails by name", async () => {
    const dns = new FakeDnsProvider();
    const prt = ports({ dns, resolveUnitApex: async () => "example.com" });
    expect(await probeTenantDns(prt, p(), ctx())).toMatchObject([{ id: "dns.record", status: "pass", detail: "is free; the run creates it" }]);
    dns.seed("*.acme.example.com", "CNAME", "s1.example");
    expect((await probeTenantDns(prt, p(), ctx()))[0]?.detail).toContain("already points at s1.example");
    dns.seed("*.acme.example.com", "CNAME", "apps4.gone.example");
    expect(await probeTenantDns(prt, p(), ctx())).toMatchObject([{ status: "warn" }]);
    db.db.insert(servers).values({ id: "srv_2", name: "s2", host: "203.0.113.20", sshUser: "root", role: "slave", status: "healthy" }).run();
    db.db.insert(clusters).values({ id: "cls_2", serverId: "srv_2", stage: "prod", domain: "s2.example", name: "s2", status: "active", slaveId: 2 }).run();
    dns.seed("*.acme.example.com", "CNAME", "s2.example");
    expect(await probeTenantDns(prt, p(), ctx())).toMatchObject([{ status: "fail", severity: "hard", detail: "points at s2.example, a cluster of this installation", hint: "offboard the tenant there first" }]);
  });
});
