import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { openDb, type DbHandle } from "../../db/client.ts";
import { apps, clusters, servers, tenants } from "../../db/schema/inventory.ts";
import { checkUnitsStep } from "#unit/server/check-units.ts";
import { consumerUnitProbes } from "./consumer-unit-probes.ts";
import { tenantUnitProbes } from "./tenant-unit-probes.ts";
import { ports as onboardPorts, emptyZone } from "./onboard.fixture.ts";
import { FakeGitHubApp } from "../../adapters/github-app/testing/fake.ts";
import { FakeGitHubConsumer } from "#unit/server/adapters/github-consumer/testing/fake.ts";
import type { StepCtx } from "../../executor/types.ts";
import type { CredentialStore } from "../../security/store.ts";
import type { Logger } from "../../kernel/logger.ts";
import { checkBadge } from "../../../web/src/unitCheck.ts";
import { GitHubConsumerError, webhookTargetUrl } from "#unit/server/adapters/github-consumer/port.ts";
import type { TenantOnboardPorts } from "./create-tenant.run.ts";
import type { TenantBuildDeps } from "./tenant-builds.ts";

// THE SCHEDULED CHECK RUNS EVERY STANDING UNIT'S PROBES (#210): over the rows, with the ports the
// onboarding ran them with, and records what it found on each row — the pass as well as the drift.

let db: DbHandle;
beforeEach(() => {
  db = openDb(":memory:");
  db.db.insert(servers).values({ id: "srv_1", name: "s1", host: "10.1.1.11", sshUser: "root", role: "slave", status: "healthy" }).run();
  db.db.insert(clusters).values({ id: "cls_1", serverId: "srv_1", stage: "prod", domain: "s1.example", name: "s1", status: "active" }).run();
});
afterEach(() => { db.sqlite.close(); });

/** The App installed with `owner`, reaching every repository of it — what a unit is checked with (#226). */
function appWith(owner: string): FakeGitHubApp {
  const a = new FakeGitHubApp();
  a.org = owner;
  return a;
}

function ctx(logs: string[]): StepCtx {
  return {
    runId: "run_chk", stepName: "check-units", db: db.db, params: {},
    creds: { open: async () => Buffer.from("ghp_stored"), list: async () => [{ id: "cred_app", kind: "github-app", subject: { kind: "owner", id: "x" }, purpose: "repository-identity" }] } as unknown as CredentialStore,
    secrets: { get: () => undefined, wipe: () => undefined },
    signal: new AbortController().signal, logger: {} as unknown as Logger,
    ssh: () => Promise.reject(new Error("no ssh")), openPasswordSession: () => Promise.reject(new Error("no ssh")),
    closePasswordSession: () => undefined, attest: () => Promise.reject(new Error("no attest")),
    log: (_s, t) => logs.push(t), checkpoint: () => undefined, readCheckpoint: () => undefined, registerCleanup: () => undefined,
  };
}

describe("check-units", () => {
  it("records every active consumer's and tenant's findings on its row, and the drift among them", async () => {
    db.db.insert(apps).values({ id: "app_1", clusterId: "cls_1", name: "acme", stage: "prod", host: "acme", repoUrl: "https://github.com/x/acme.git", provenance: "manager", status: "active" }).run();
    db.db.insert(apps).values({ id: "app_off", clusterId: "cls_1", name: "gone", stage: "prod", host: "gone", repoUrl: "https://github.com/x/gone.git", provenance: "manager", status: "offboarded" }).run();
    db.db.insert(tenants).values({ id: "tnt_1", clusterId: "cls_1", guid: "acme1234abcd", subdomain: "shop", stage: "prod", members: ["auth"], identityProvider: "auth", provenance: "manager", status: "active" }).run();
    const dns = emptyZone();
    dns.seed("shop.example.com", "A", "198.51.100.7"); // the tenant's zone record moved to an address nobody here carries
    const github = new FakeGitHubConsumer();
    github.scopeError = true; // the consumer's stored PAT lost admin:repo_hook
    const o = onboardPorts({ github, dns });
    const logs: string[] = [];
    const apex = async (): Promise<string> => "example.com";
    await checkUnitsStep(() => [consumerUnitProbes({ onboard: () => o, resolveUnitApex: apex, githubApp: appWith("x") }), tenantUnitProbes({ dns, resolveUnitApex: apex })]).run(ctx(logs));

    const consumer = db.db.select({ check: apps.checkJson }).from(apps).where(eq(apps.id, "app_1")).get()?.check;
    expect(consumer?.findings.map((f) => [f.id, f.status])).toEqual([["placement.stage", "pass"], ["identity", "pass"], ["webhook", "fail"], ["dns.record", "pass"]]);
    expect(db.db.select({ check: apps.checkJson }).from(apps).where(eq(apps.id, "app_off")).get()?.check).toBeNull(); // offboarded: not probed
    const tenant = db.db.select({ check: tenants.checkJson }).from(tenants).where(eq(tenants.id, "tnt_1")).get()?.check;
    expect(tenant?.findings.map((f) => [f.id, f.status])).toEqual([["placement.stage", "pass"], ["dns.record", "warn"]]);
    expect(logs.at(-1)).toBe("1 consumer(s) and 1 tenant(s) probed: 2 finding(s) worth a look, recorded on their rows");

    // What the pages show off the rows: the failure as the loud chip, the warning as the quiet one.
    expect(checkBadge(consumer ?? null, Date.now())).toMatchObject({ label: "1 probe(s) failed", modifier: "chip--warn" });
    expect(checkBadge(tenant ?? null, Date.now())).toMatchObject({ label: "1 probe(s) worth a look", modifier: null });
  });

  it("PLANTED DEFECT: a tenant or consumer on a machine of another stage is worth a look and stays where it is; one of its own stage passes", async () => {
    db.db.insert(servers).values({ id: "srv_2", name: "s2", host: "10.1.1.12", sshUser: "root", role: "slave", status: "healthy" }).run();
    db.db.insert(clusters).values({ id: "cls_2", serverId: "srv_2", stage: "test", domain: "s2.example", name: "s2", status: "active" }).run();
    db.db.insert(apps).values({ id: "app_breach", clusterId: "cls_2", name: "post", stage: "prod", host: "post", provenance: "adopted", status: "active" }).run();
    db.db.insert(apps).values({ id: "app_match", clusterId: "cls_2", name: "post", stage: "test", host: "post", provenance: "adopted", status: "active" }).run();
    db.db.insert(tenants).values({ id: "tnt_breach", clusterId: "cls_2", guid: "acme1234abcd", subdomain: "acme", stage: "prod", members: ["auth"], identityProvider: "auth", provenance: "manager", status: "active" }).run();
    db.db.insert(tenants).values({ id: "tnt_match", clusterId: "cls_1", guid: "beta1234abcd", subdomain: "beta", stage: "prod", members: ["auth"], identityProvider: "auth", provenance: "manager", status: "active" }).run();
    const dns = emptyZone();
    const apex = async (): Promise<string> => "example.com";
    await checkUnitsStep(() => [consumerUnitProbes({ onboard: () => onboardPorts(), resolveUnitApex: apex }), tenantUnitProbes({ dns, resolveUnitApex: apex })]).run(ctx([]));

    const placement = (row: { check: { findings: { id: string }[] } | null } | undefined) => row?.check?.findings.find((f) => f.id === "placement.stage");
    expect(placement(db.db.select({ check: apps.checkJson }).from(apps).where(eq(apps.id, "app_breach")).get())).toMatchObject({ status: "warn", detail: "prod runs on s2.example, which serves test environments only" });
    expect(placement(db.db.select({ check: tenants.checkJson }).from(tenants).where(eq(tenants.id, "tnt_breach")).get())).toMatchObject({ status: "warn", detail: "prod runs on s2.example, which serves test environments only" });
    expect(placement(db.db.select({ check: apps.checkJson }).from(apps).where(eq(apps.id, "app_match")).get())).toMatchObject({ status: "pass", detail: "test on s2.example, which serves test" });
    expect(placement(db.db.select({ check: tenants.checkJson }).from(tenants).where(eq(tenants.id, "tnt_match")).get())).toMatchObject({ status: "pass", detail: "prod on s1.example, which serves prod" });
    expect(db.db.select({ clusterId: tenants.clusterId }).from(tenants).where(eq(tenants.id, "tnt_breach")).get()?.clusterId).toBe("cls_2");
    expect(db.db.select({ clusterId: apps.clusterId }).from(apps).where(eq(apps.id, "app_breach")).get()?.clusterId).toBe("cls_2");
  });

  it("says not measured on a unit it cannot probe — no onboarding wired, or a row without a repository", async () => {
    db.db.insert(apps).values({ id: "app_adopted", clusterId: "cls_1", name: "found", stage: "prod", host: "found", provenance: "adopted", status: "active" }).run();
    const apex = async (): Promise<string> => "example.com";
    await checkUnitsStep(() => [consumerUnitProbes({ onboard: () => onboardPorts(), resolveUnitApex: apex })]).run(ctx([]));
    expect(db.db.select({ check: apps.checkJson }).from(apps).where(eq(apps.id, "app_adopted")).get()?.check?.findings).toMatchObject([{ id: "placement.stage", status: "pass" }, { status: "warn", detail: "not measured: the row records no repository (an adopted unit)" }]);
    await checkUnitsStep(() => [consumerUnitProbes({ onboard: () => undefined, resolveUnitApex: apex })]).run(ctx([]));
    expect(db.db.select({ check: apps.checkJson }).from(apps).where(eq(apps.id, "app_adopted")).get()?.check?.findings).toMatchObject([{ id: "placement.stage", status: "pass" }, { detail: "not measured: the consumer onboarding is not wired on this manager" }]);
  });

  it("a standing consumer whose only hook stands at another host is worth a look, naming the URL it expected; each repository is read once", async () => {
    for (const stage of ["prod", "test"] as const) {
      db.db.insert(apps).values({ id: `app_${stage}`, clusterId: "cls_1", name: "acme", stage, host: "acme", repoUrl: "https://github.com/x/acme.git", provenance: "manager", status: "active" }).run();
    }
    const github = new FakeGitHubConsumer();
    github.seedHook("x", "acme", "https://build.old.example/github"); // left behind when the build plane moved
    const o = onboardPorts({ github });
    const expected = webhookTargetUrl(await o.resolveBuildPlaneFqdn("s1.example"), o.webhookSubdomain);
    const reads = vi.spyOn(github, "hookStandsAt");
    await checkUnitsStep(() => [consumerUnitProbes({ onboard: () => o, resolveUnitApex: async () => "example.com", githubApp: appWith("x") })]).run(ctx([]));

    for (const id of ["app_prod", "app_test"]) {
      const webhook = db.db.select({ check: apps.checkJson }).from(apps).where(eq(apps.id, id)).get()?.check?.findings.find((f) => f.id === "webhook");
      expect(webhook).toMatchObject({ status: "warn", detail: `no hook stands at ${expected}: a push to this repository starts no build` });
    }
    expect(reads).toHaveBeenCalledTimes(1); // two stage rows, one repository
  });

  it("a tenant's row carries the build hooks of the units that build its images, and of no other unit", async () => {
    db.db.insert(tenants).values({ id: "tnt_1", clusterId: "cls_1", guid: "acme1234abcd", subdomain: "acme", stage: "prod", members: ["auth"], identityProvider: "auth", provenance: "manager", status: "active" }).run();
    const dns = emptyZone();
    const github = new FakeGitHubConsumer();
    const expected = webhookTargetUrl("m1.example", "build");
    github.seedHook("x", "digita-auth", expected);
    const reads = vi.spyOn(github, "hookStandsAt");
    const units = [
      { unit: "digita-auth", entry: { repoURL: "https://github.com/x/digita-auth.git", builds: ["digita-auth-backend"] } },
      { unit: "digita-jobs", entry: { repoURL: "https://github.com/x/digita-jobs.git", builds: ["digita-jobs"] } },
      { unit: "unrelated", entry: { repoURL: "https://github.com/x/unrelated.git", builds: ["unrelated"] } },
    ];
    const deps = (): TenantBuildDeps => ({ ports: { github, resolveBuildPlaneFqdn: async () => "m1.example", webhookSubdomain: "build", registrations: { listBuildRegistrations: async () => units } } } as unknown as TenantBuildDeps);
    const ports = {
      dns, resolveUnitApex: async () => "example.com", githubApp: appWith("x"), onboard: deps,
      registrations: { readTenant: async () => ({ entry: { approvedTags: { auth: { "digita-auth-backend": "1.0.0" }, jobs: { "digita-jobs": "1.0.0" } } } }) },
    } as unknown as TenantOnboardPorts;
    await checkUnitsStep(() => [tenantUnitProbes(ports)]).run(ctx([]));

    const findings = db.db.select({ check: tenants.checkJson }).from(tenants).where(eq(tenants.id, "tnt_1")).get()?.check?.findings ?? [];
    expect(findings.map((f) => [f.id, f.status])).toEqual([["placement.stage", "pass"], ["dns.record", "pass"], ["unit.digita-auth", "pass"], ["unit.digita-jobs", "warn"]]);
    expect(findings.find((f) => f.id === "unit.digita-jobs")?.detail).toBe(`its stored credential reads the hooks; no hook stands at ${expected}: a push to it starts no build`);
    expect(reads).toHaveBeenCalledTimes(2); // the unrelated unit builds nothing this tenant runs
  });

  it("a hook read GitHub does not answer (5xx, 429, no answer) is not measured in both walks; one it refuses still fails, by repository", async () => {
    db.db.insert(apps).values({ id: "app_1", clusterId: "cls_1", name: "acme", stage: "prod", host: "acme", repoUrl: "https://github.com/x/acme.git", provenance: "manager", status: "active" }).run();
    db.db.insert(tenants).values({ id: "tnt_1", clusterId: "cls_1", guid: "acme1234abcd", subdomain: "acme", stage: "prod", members: ["auth"], identityProvider: "auth", provenance: "manager", status: "active" }).run();
    const github = new FakeGitHubConsumer();
    const o = onboardPorts({ github });
    const units = [{ unit: "digita-jobs", entry: { repoURL: "https://github.com/x/digita-jobs.git", builds: ["digita-jobs"] } }];
    const deps = (): TenantBuildDeps => ({ ports: { github, resolveBuildPlaneFqdn: async () => "m1.example", webhookSubdomain: "build", registrations: { listBuildRegistrations: async () => units } } } as unknown as TenantBuildDeps);
    const tenantPorts = {
      dns: emptyZone(), resolveUnitApex: async () => "example.com", githubApp: appWith("x"), onboard: deps,
      registrations: { readTenant: async () => ({ entry: { approvedTags: { jobs: { "digita-jobs": "1.0.0" } } } }) },
    } as unknown as TenantOnboardPorts;
    const walk = async (err: Error) => {
      vi.spyOn(github, "hookStandsAt").mockRejectedValue(err);
      await checkUnitsStep(() => [consumerUnitProbes({ onboard: () => o, resolveUnitApex: async () => "example.com", githubApp: appWith("x") }), tenantUnitProbes(tenantPorts)]).run(ctx([]));
      return [
        db.db.select({ check: apps.checkJson }).from(apps).where(eq(apps.id, "app_1")).get()?.check?.findings.find((f) => f.id === "webhook"),
        db.db.select({ check: tenants.checkJson }).from(tenants).where(eq(tenants.id, "tnt_1")).get()?.check?.findings.find((f) => f.id === "unit.digita-jobs"),
      ];
    };
    for (const [err, why] of [
      [new GitHubConsumerError("GitHub GET /repos/x/acme/hooks → 502: Bad Gateway", 502), "HTTP 502"],
      [new GitHubConsumerError("GitHub GET /repos/x/acme/hooks → 429: rate limited", 429), "HTTP 429"],
      [new GitHubConsumerError("GitHub request failed (/repos/x/acme/hooks): fetch failed"), "no answer"],
    ] as const) {
      for (const finding of await walk(err)) {
        expect(finding).toMatchObject({ severity: "soft", status: "warn", detail: `not measured: GitHub did not answer the hook read this time (${why})` });
      }
    }
    // A refusal that is neither the scope's nor a passing one stays the hard failure, titled by the repository.
    const [consumer, tenant] = await walk(new GitHubConsumerError("GitHub GET /repos/x/digita-jobs/hooks → 422: Unprocessable", 422));
    expect(consumer).toMatchObject({ severity: "hard", status: "fail" });
    expect(tenant).toMatchObject({ title: "The build unit digita-jobs (x/digita-jobs)", severity: "hard", status: "fail" });
  });

  it("the badge is quiet where every probe passed, and absent where no check has reached the unit", () => {
    expect(checkBadge(null, 0)).toBeNull();
    expect(checkBadge({ checkedAt: 0, findings: [{ id: "a", title: "A", severity: "hard", status: "pass", detail: "ok" }] }, 0)).toBeNull();
  });
});
