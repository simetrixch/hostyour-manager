import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { openDb, type DbHandle } from "../../db/client.ts";
import { apps, clusters, servers, tenants } from "../../db/schema/inventory.ts";
import { checkUnitsStep } from "#unit/server/check-units.ts";
import { consumerUnitProbes } from "./consumer-unit-probes.ts";
import { tenantUnitProbes } from "./tenant-unit-probes.ts";
import { ports as onboardPorts, emptyZone } from "./onboard.fixture.ts";
import { FakeGitHubApp } from "../../adapters/github-app/testing/fake.ts";
import { FakeGitHubConsumer } from "../../adapters/github-consumer/testing/fake.ts";
import type { StepCtx } from "../../executor/types.ts";
import type { CredentialStore } from "../../security/store.ts";
import type { Logger } from "../../kernel/logger.ts";
import { checkBadge } from "../../../web/src/unitCheck.ts";

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
    db.db.insert(tenants).values({ id: "tnt_1", clusterId: "cls_1", guid: "acme1234abcd", subdomain: "acme", stage: "prod", members: ["auth"], identityProvider: "auth", provenance: "manager", status: "active" }).run();
    const dns = emptyZone();
    dns.seed("*.acme.example.com", "A", "198.51.100.7"); // the tenant's wildcard moved to an address nobody here carries
    const github = new FakeGitHubConsumer();
    github.scopeError = true; // the consumer's stored PAT lost admin:repo_hook
    const o = onboardPorts({ github, dns });
    const logs: string[] = [];
    const apex = async (): Promise<string> => "example.com";
    await checkUnitsStep(() => [consumerUnitProbes({ onboard: () => o, resolveUnitApex: apex, githubApp: appWith("x") }), tenantUnitProbes({ dns, resolveUnitApex: apex })]).run(ctx(logs));

    const consumer = db.db.select({ check: apps.checkJson }).from(apps).where(eq(apps.id, "app_1")).get()?.check;
    expect(consumer?.findings.map((f) => [f.id, f.status])).toEqual([["identity", "pass"], ["webhook", "fail"], ["dns.record", "pass"]]);
    expect(db.db.select({ check: apps.checkJson }).from(apps).where(eq(apps.id, "app_off")).get()?.check).toBeNull(); // offboarded: not probed
    const tenant = db.db.select({ check: tenants.checkJson }).from(tenants).where(eq(tenants.id, "tnt_1")).get()?.check;
    expect(tenant?.findings.map((f) => [f.id, f.status])).toEqual([["dns.record", "warn"]]);
    expect(logs.at(-1)).toBe("1 consumer(s) and 1 tenant(s) probed: 2 finding(s) worth a look, recorded on their rows");

    // What the pages show off the rows: the failure as the loud chip, the warning as the quiet one.
    expect(checkBadge(consumer ?? null, Date.now())).toMatchObject({ label: "1 probe(s) failed", modifier: "chip--warn" });
    expect(checkBadge(tenant ?? null, Date.now())).toMatchObject({ label: "1 probe(s) worth a look", modifier: null });
  });

  it("says not measured on a unit it cannot probe — no onboarding wired, or a row without a repository", async () => {
    db.db.insert(apps).values({ id: "app_adopted", clusterId: "cls_1", name: "found", stage: "prod", host: "found", provenance: "adopted", status: "active" }).run();
    const apex = async (): Promise<string> => "example.com";
    await checkUnitsStep(() => [consumerUnitProbes({ onboard: () => onboardPorts(), resolveUnitApex: apex })]).run(ctx([]));
    expect(db.db.select({ check: apps.checkJson }).from(apps).where(eq(apps.id, "app_adopted")).get()?.check?.findings).toMatchObject([{ status: "warn", detail: "not measured: the row records no repository (an adopted unit)" }]);
    await checkUnitsStep(() => [consumerUnitProbes({ onboard: () => undefined, resolveUnitApex: apex })]).run(ctx([]));
    expect(db.db.select({ check: apps.checkJson }).from(apps).where(eq(apps.id, "app_adopted")).get()?.check?.findings).toMatchObject([{ detail: "not measured: the consumer onboarding is not wired on this manager" }]);
  });

  it("the badge is quiet where every probe passed, and absent where no check has reached the unit", () => {
    expect(checkBadge(null, 0)).toBeNull();
    expect(checkBadge({ checkedAt: 0, findings: [{ id: "a", title: "A", severity: "hard", status: "pass", detail: "ok" }] }, 0)).toBeNull();
  });
});
