import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { openDb, type DbHandle } from "../../db/client.ts";
import { createLogger } from "../../kernel/logger.ts";
import { parseConfig } from "../../kernel/config.ts";
import { REQUIRED_ENV } from "../../kernel/config.fixture.ts";
import { CredentialStore } from "../../security/store.ts";
import { RunEventBus } from "../../executor/bus.ts";
import { Executor } from "../../executor/executor.ts";
import { getRun } from "../../executor/read.ts";
import type { AnyRunDefinition } from "../../executor/types.ts";
import { servers, clusters, tenants } from "../../db/schema/inventory.ts";
import { findDnsWrite, recordDnsWrite } from "../../db/dns-writes.ts";
import { makeTenantSetOwnDomainDef } from "./tenant-own-domain.run.ts";
import { TenantRegistrations } from "./tenant-registrations.ts";
import { FakePlatformRepo } from "../../adapters/git/testing/fake.ts";
import { FakeDnsProvider } from "../../adapters/dns/testing/fake.ts";
import { FakePublicProbe } from "../../adapters/http-probe/testing/fake.ts";
import { FakeMasterArgoReader, FakeClusterReader, FakeMasterProjectWriter, FakeClusterKubeResolver } from "../../adapters/kube/testing/fake.ts";
import { testMembers, TEST_QUOTA } from "./tenant-members.fixture.ts";
import type { MemberRouting } from "../../../shared/enums.ts";

// tenant-set-own-domain driven through the real Executor: the order the run exists for (the new
// domain's record, the recorded domain, a 2xx at the new host, only then the previous domain's record
// gone), the abort, the refused abort, the skip and the plan's refusals.

const GUID = "zsjs023ctne0";
const CLUSTER = "s1.example";
const ZONE = "acme.example.com";
const OWN = "www.customer.test";
const OTHER = "shop.customer.test";
const BARE = "customer.test";
const idpAt = (host: string): string => `https://${host}/auth/`;
const OK = { reachable: true, status: 200, detail: "HTTP 200" };
const REDIRECTS = { reachable: true, status: 307, detail: "HTTP 307" };

const logger = createLogger(parseConfig({
  ...REQUIRED_ENV, PUBLIC_URL: "https://x.example", OIDC_ISSUER: "https://i.example/", OIDC_CLIENT_ID: "c", OIDC_CLIENT_SECRET: "s",
  MANAGER_VERSION: "test", DATA_DIR: "/data", ADMIN_SOCKET_PATH: "/run/manager/admin.sock", LOG_LEVEL: "silent",
} as NodeJS.ProcessEnv));

describe("tenant-set-own-domain through the Executor", () => {
  const handles: DbHandle[] = [];
  const dirs: string[] = [];
  afterEach(() => {
    for (const h of handles.splice(0)) h.sqlite.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  async function make(opts: { routing?: MemberRouting; ownDomain?: string; ownDomainRedirects?: string[]; answers?: string[]; redirecting?: string[]; unmanaged?: string[] } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "mgr-owndomain-"));
    dirs.push(dir);
    const db = openDb(join(dir, "manager.db"));
    handles.push(db);
    const routing = opts.routing ?? "path";
    const ownDomain = opts.ownDomain ?? "";
    const ownDomainRedirects = opts.ownDomainRedirects ?? [];
    const reg = new TenantRegistrations(new FakePlatformRepo());
    const dns = new FakeDnsProvider();
    dns.unmanaged = opts.unmanaged ?? [];
    dns.seed(ZONE, "CNAME", CLUSTER);
    const probe = new FakePublicProbe(Object.fromEntries([
      ...(opts.answers ?? []).map((host) => [idpAt(host), OK]),
      ...(opts.redirecting ?? []).map((host) => [`https://${host}/`, REDIRECTS]),
    ]));
    db.db.insert(servers).values({ id: "srv_1", name: "m1", host: "1.2.3.4", sshUser: "root", role: "master", status: "healthy" }).run();
    db.db.insert(clusters).values({ id: "cls_1", serverId: "srv_1", stage: "prod", domain: CLUSTER, name: "s1", status: "active" }).run();
    db.db.insert(tenants).values({
      id: "tnt_1", clusterId: "cls_1", guid: GUID, subdomain: "acme", stage: "prod",
      members: ["auth", "jobs", "report"], identityProvider: "auth", routing, ownDomain, ownDomainRedirects, suspended: false, status: "active",
    }).run();
    await reg.commitTenant({
      stage: "prod", guid: GUID, runId: "run_crt",
      registration: {
        cluster: "s1", subdomain: "acme", apps: [], members: testMembers(), identityProvider: "auth", routing, ownDomain, ownDomainRedirects,
        seedUsers: false, quota: TEST_QUOTA, resetNonce: "1", suspended: false, quiesced: false, appsImage: "", appsImageTag: "",
      },
    });
    const def = makeTenantSetOwnDomainDef({
      registrations: reg,
      resolver: new FakeClusterKubeResolver({
        clusterReader: new FakeClusterReader({ deployState: { domain: CLUSTER, stage: "prod", writtenAt: "x", generation: 1 } }),
        argoReader: new FakeMasterArgoReader(), projectWriter: new FakeMasterProjectWriter(), argoNamespace: "argocd",
      }),
      catalogRepoUrl: "https://github.com/acme/acme-catalog.git", argoWatchTimeoutMs: 1000, resolveUnitApex: async () => "example.com",
      dns, probe, routingWaitMs: 0, routingPollMs: 0,
    });
    const executor = new Executor({
      db: db.db, creds: new CredentialStore({ db: db.db, logger }), bus: new RunEventBus(), logger,
      runDefinitions: new Map([["tenant-set-own-domain", def as unknown as AnyRunDefinition]]),
      sshFactory: () => Promise.reject(new Error("no ssh")), actor: () => "op_system",
    });
    const rowDomain = (): string | undefined => db.db.select({ d: tenants.ownDomain }).from(tenants).where(eq(tenants.id, "tnt_1")).get()?.d;
    const regDomain = async (): Promise<string | undefined> => (await reg.readTenant("prod", GUID))?.entry.ownDomain;
    const rowRedirects = (): string[] | undefined => db.db.select({ r: tenants.ownDomainRedirects }).from(tenants).where(eq(tenants.id, "tnt_1")).get()?.r;
    const regRedirects = async (): Promise<string[] | undefined> => (await reg.readTenant("prod", GUID))?.entry.ownDomainRedirects;
    return { db, reg, dns, probe, executor, rowDomain, regDomain, rowRedirects, regRedirects };
  }

  async function move(h: Awaited<ReturnType<typeof make>>, ownDomain: string, previous: string, redirects: { ownDomainRedirects?: string[]; previousRedirects?: string[] } = {}): Promise<string> {
    const { runId } = await h.executor.plan("tenant-set-own-domain", { tenantId: "tnt_1", ownDomain, previous, ...redirects });
    await h.executor.approve(runId);
    await h.executor.settle(runId);
    return runId;
  }

  it("sets an own domain: its record onto the zone first, then the domain, then a 2xx at the new host", async () => {
    const h = await make({ answers: [OWN] });
    const runId = await move(h, OWN, "");
    expect(getRun(h.db.db, runId)?.status).toBe("succeeded");
    expect(h.dns.record(OWN, "CNAME")).toBe(ZONE);
    expect(findDnsWrite(h.db.db, { name: OWN, type: "CNAME" })?.owner).toEqual({ kind: "tenant", name: GUID, stage: "prod" });
    expect(h.rowDomain()).toBe(OWN);
    expect(await h.regDomain()).toBe(OWN);
    expect(h.probe.probed).toContain(idpAt(OWN));
    // The zone keeps its record: the charts answer it with a redirect to the domain.
    expect(h.dns.record(ZONE, "CNAME")).toBe(CLUSTER);
  });

  it("sets redirect hosts beside the domain: a record each, recorded, and a redirect awaited at each", async () => {
    const h = await make({ answers: [OWN], redirecting: [BARE] });
    const runId = await move(h, OWN, "", { ownDomainRedirects: [BARE] });
    expect(getRun(h.db.db, runId)?.status).toBe("succeeded");
    expect(h.dns.record(BARE, "CNAME")).toBe(ZONE);
    expect(findDnsWrite(h.db.db, { name: BARE, type: "CNAME" })?.owner).toEqual({ kind: "tenant", name: GUID, stage: "prod" });
    expect(h.rowRedirects()).toEqual([BARE]);
    expect(await h.regRedirects()).toEqual([BARE]);
    expect(h.probe.probed).toContain(`https://${BARE}/`);
  });

  it("does not take a 2xx for a redirect host: it must answer the redirect itself", async () => {
    const h = await make({ answers: [OWN, BARE] });
    h.probe.set(`https://${BARE}/`, OK);
    const runId = await move(h, OWN, "", { ownDomainRedirects: [BARE] });
    expect(getRun(h.db.db, runId)?.status).toBe("failed");
  });

  it("drops a redirect host: its record goes only after the kept hosts answer", async () => {
    const h = await make({ ownDomain: OWN, ownDomainRedirects: [BARE], answers: [OWN] });
    for (const host of [OWN, BARE]) {
      h.dns.seed(host, "CNAME", ZONE);
      recordDnsWrite(h.db.db, { name: host, type: "CNAME", content: ZONE, act: "inserted", owner: { kind: "tenant", name: GUID, stage: "prod" }, runId: "run_old" });
    }
    const runId = await move(h, OWN, OWN, { previousRedirects: [BARE] });
    expect(getRun(h.db.db, runId)?.status).toBe("succeeded");
    expect(h.dns.record(BARE, "CNAME")).toBeUndefined();
    expect(h.dns.record(OWN, "CNAME")).toBe(ZONE);
    expect(h.rowRedirects()).toEqual([]);
  });

  it("an abort after a failed redirect wait removes the new redirect host's record and records the previous hosts again", async () => {
    const h = await make({ answers: [OWN] });
    const runId = await move(h, OWN, "", { ownDomainRedirects: [BARE] });
    expect(getRun(h.db.db, runId)?.status).toBe("failed");
    expect(h.dns.record(BARE, "CNAME")).toBe(ZONE);
    await h.executor.abortWithCleanup(runId);
    await h.executor.settle(runId);
    expect(h.dns.record(BARE, "CNAME")).toBeUndefined();
    expect(h.dns.record(OWN, "CNAME")).toBeUndefined();
    expect(h.rowRedirects()).toEqual([]);
    expect(await h.regRedirects()).toEqual([]);
  });

  it("REFUSES redirect hosts without a domain, twice named, equal to the domain, in the platform's name space, or another tenant's", async () => {
    const h = await make();
    const plan = (ownDomain: string, ownDomainRedirects: string[]) => h.executor.plan("tenant-set-own-domain", { tenantId: "tnt_1", ownDomain, ownDomainRedirects, previous: "" });
    await expect(plan("", [BARE])).rejects.toThrow(/need an own domain/);
    await expect(plan(OWN, [BARE, BARE])).rejects.toThrow(/named twice/);
    await expect(plan(OWN, [OWN])).rejects.toThrow(/redirect to itself/);
    await expect(plan(OWN, ["www.example.com"])).rejects.toThrow(/platform's own name space/);
    h.db.db.insert(tenants).values({
      id: "tnt_2", clusterId: "cls_1", guid: "zzzzzzzzzzzz", subdomain: "beta", stage: "prod",
      members: ["auth"], identityProvider: "auth", routing: "path", ownDomain: "beta.test", ownDomainRedirects: [BARE], suspended: false, status: "active",
    }).run();
    await expect(plan(OWN, [BARE])).rejects.toThrow(/already a host of tenant beta/);
  });

  it("writes nothing into a zone nobody here manages, and still records the domain once it answers", async () => {
    const h = await make({ answers: [OWN], unmanaged: ["customer.test"] });
    const runId = await move(h, OWN, "");
    expect(getRun(h.db.db, runId)?.status).toBe("succeeded");
    expect(h.dns.upserts).toEqual([]);
    expect(h.rowDomain()).toBe(OWN);
  });

  it("switches: the previous domain's record goes only after the new host answers", async () => {
    const h = await make({ ownDomain: OWN, answers: [OTHER] });
    h.dns.seed(OWN, "CNAME", ZONE);
    recordDnsWrite(h.db.db, { name: OWN, type: "CNAME", content: ZONE, act: "inserted", owner: { kind: "tenant", name: GUID, stage: "prod" }, runId: "run_old" });
    const runId = await move(h, OTHER, OWN);
    expect(getRun(h.db.db, runId)?.status).toBe("succeeded");
    expect(h.dns.record(OTHER, "CNAME")).toBe(ZONE);
    expect(h.dns.record(OWN, "CNAME")).toBeUndefined();
    expect(h.rowDomain()).toBe(OTHER);
  });

  it("an abort after the failed wait records the previous domain again and removes the new domain's record", async () => {
    const h = await make();
    const runId = await move(h, OWN, "");
    expect(getRun(h.db.db, runId)?.status).toBe("failed");
    expect(h.dns.record(OWN, "CNAME")).toBe(ZONE);

    await h.executor.abortWithCleanup(runId);
    await h.executor.settle(runId);
    expect(getRun(h.db.db, runId)?.status).toBe("cancelled");
    expect(h.rowDomain()).toBe("");
    expect(await h.regDomain()).toBe("");
    expect(h.dns.record(OWN, "CNAME")).toBeUndefined();
    expect(h.dns.record(ZONE, "CNAME")).toBe(CLUSTER);
  });

  it("REFUSES the abort once the previous domain's record is gone, and leaves the run as it was", async () => {
    const h = await make({ ownDomain: OWN });
    h.dns.seed(OWN, "CNAME", ZONE);
    const runId = await move(h, OTHER, OWN);
    expect(getRun(h.db.db, runId)?.status).toBe("failed");
    await h.dns.deleteRecord({ name: OWN, type: "CNAME" });
    await expect(h.executor.abortWithCleanup(runId)).rejects.toThrow(/is gone/);
    expect(getRun(h.db.db, runId)?.status).toBe("failed");
  });

  it("skipping the failed wait removes nothing: the wait and the removal are one step", async () => {
    const h = await make({ ownDomain: OWN });
    h.dns.seed(OWN, "CNAME", ZONE);
    recordDnsWrite(h.db.db, { name: OWN, type: "CNAME", content: ZONE, act: "inserted", owner: { kind: "tenant", name: GUID, stage: "prod" }, runId: "run_old" });
    const runId = await move(h, OTHER, OWN);
    await h.executor.skipStep(runId, "retire-previous-own-domain", "test");
    await h.executor.settle(runId);
    expect(h.dns.record(OWN, "CNAME")).toBe(ZONE);
  });

  it("does not take a redirect for the IdP at the new host", async () => {
    const h = await make();
    h.probe.set(idpAt(OWN), { reachable: true, status: 307, detail: "HTTP 307" });
    const runId = await move(h, OWN, "");
    expect(getRun(h.db.db, runId)?.status).toBe("failed");
  });

  it("frees the domain of an offboarded tenant, and refuses one that overlaps a live tenant's or lies under a cluster name", async () => {
    const h = await make();
    const other = (id: string, guid: string, domain: string, status: "active" | "offboarded"): void => {
      h.db.db.insert(tenants).values({
        id, clusterId: "cls_1", guid, subdomain: id, stage: "prod",
        members: ["auth"], identityProvider: "auth", routing: "path", ownDomain: domain, suspended: false, status,
      }).run();
    };
    other("tnt_old", "oooooooooooo", OWN, "offboarded");
    await expect(h.executor.plan("tenant-set-own-domain", { tenantId: "tnt_1", ownDomain: OWN, previous: "" })).resolves.toBeDefined();
    other("tnt_live", "llllllllllll", "customer.test", "active");
    await expect(h.executor.plan("tenant-set-own-domain", { tenantId: "tnt_1", ownDomain: OWN, previous: "" })).rejects.toThrow(/overlaps the own domain of tenant tnt_live/);
    await expect(h.executor.plan("tenant-set-own-domain", { tenantId: "tnt_1", ownDomain: "app.s1.example", previous: "" })).rejects.toThrow(/under the cluster name s1.example/);
  });

  it("asks the plan's facts again when it runs: a run planned before another moved the tenant fails without writing", async () => {
    const h = await make({ answers: [OWN, OTHER] });
    const first = await h.executor.plan("tenant-set-own-domain", { tenantId: "tnt_1", ownDomain: OWN, previous: "" });
    const second = await h.executor.plan("tenant-set-own-domain", { tenantId: "tnt_1", ownDomain: OTHER, previous: "" });
    await h.executor.approve(first.runId);
    await h.executor.settle(first.runId);
    expect(h.rowDomain()).toBe(OWN);
    await h.executor.approve(second.runId);
    await h.executor.settle(second.runId);
    expect(getRun(h.db.db, second.runId)?.status).toBe("failed");
    expect(h.rowDomain()).toBe(OWN);
  });

  it("REFUSES at plan time: a host-routed tenant, a moved one, a name of the platform and a domain another tenant has", async () => {
    const hostRouted = await make({ routing: "host" });
    await expect(hostRouted.executor.plan("tenant-set-own-domain", { tenantId: "tnt_1", ownDomain: OWN, previous: "" })).rejects.toThrow(/path routing first/);
    const moved = await make({ ownDomain: OWN });
    await expect(moved.executor.plan("tenant-set-own-domain", { tenantId: "tnt_1", ownDomain: OTHER, previous: "" })).rejects.toThrow(/moved since/);
    const platform = await make();
    await expect(platform.executor.plan("tenant-set-own-domain", { tenantId: "tnt_1", ownDomain: "shop.example.com", previous: "" })).rejects.toThrow(/platform's own name space/);
    platform.db.db.insert(tenants).values({
      id: "tnt_2", clusterId: "cls_1", guid: "zzzzzzzzzzzz", subdomain: "beta", stage: "prod",
      members: ["auth"], identityProvider: "auth", routing: "path", ownDomain: OTHER, suspended: false, status: "active",
    }).run();
    await expect(platform.executor.plan("tenant-set-own-domain", { tenantId: "tnt_1", ownDomain: OTHER, previous: "" })).rejects.toThrow(/already the own domain of tenant beta/);
  });
});
