import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { openDb, type DbHandle } from "../../db/client.ts";
import { servers, clusters, tenants } from "../../db/schema/inventory.ts";
import { makeTenantSetRoutingDef, type TenantSetRoutingPorts } from "./tenant-routing.run.ts";
import { TenantRegistrations } from "./tenant-registrations.ts";
import { FakePlatformRepo } from "../../adapters/git/testing/fake.ts";
import { FakeDnsProvider } from "../../adapters/dns/testing/fake.ts";
import { FakePublicProbe } from "../../adapters/http-probe/testing/fake.ts";
import { FakeMasterArgoReader, FakeClusterReader, FakeMasterProjectWriter, FakeClusterKubeResolver } from "../../adapters/kube/testing/fake.ts";
import { testMembers, TEST_QUOTA } from "./tenant-members.fixture.ts";
import type { MemberRouting } from "../../../shared/enums.ts";
import type { Cleanup, Step, StepCtx } from "../../executor/types.ts";
import type { CredentialStore } from "../../security/store.ts";
import type { Logger } from "../../kernel/logger.ts";

// tenant-set-routing — move a standing tenant from a host per member to paths of its zone (and back).
// What is asserted is the order the run exists for: the record the new routing names stands BEFORE the
// routing is recorded, and the record of the old routing is removed only AFTER the tenant answers at its
// new address — so no moment exists in which the tenant has no record.

const GUID = "zsjs023ctne0";
const CLUSTER = "s1.example";
const ZONE = "acme.example.com";
const WILDCARD = `*.${ZONE}`;
const PATH_IDP = `https://${ZONE}/auth/`;

let db: DbHandle;
beforeEach(() => { db = openDb(":memory:"); });
afterEach(() => { db.sqlite.close(); });

interface Harness { cleanups: Cleanup[]; logs: string[] }

function ctx(stepName: string, params: Record<string, unknown>, h: Harness): StepCtx {
  let saved: unknown;
  return {
    runId: "run_r", stepName, db: db.db, creds: {} as unknown as CredentialStore, params,
    secrets: { get: () => undefined, wipe: () => undefined }, signal: new AbortController().signal, logger: {} as unknown as Logger,
    ssh: () => Promise.reject(new Error("no ssh")), openPasswordSession: () => Promise.reject(new Error("no ssh")),
    closePasswordSession: () => undefined, attest: () => Promise.reject(new Error("no attest")),
    log: (_s, t) => h.logs.push(t),
    checkpoint: (d) => { saved = d; },
    readCheckpoint: <T,>() => saved as T | undefined,
    registerCleanup: (c) => h.cleanups.push(c),
  };
}

async function run(steps: Step[], params: Record<string, unknown>, h: Harness): Promise<void> {
  for (const step of steps) await step.run(ctx(step.name, params, h));
}

const ATTESTING = { deployState: { domain: CLUSTER, stage: "prod" as const, writtenAt: "x", generation: 1 } };

function ports(reg: TenantRegistrations, dns: FakeDnsProvider, probe: FakePublicProbe): TenantSetRoutingPorts {
  return {
    registrations: reg,
    resolver: new FakeClusterKubeResolver({
      clusterReader: new FakeClusterReader(ATTESTING),
      argoReader: new FakeMasterArgoReader(),
      projectWriter: new FakeMasterProjectWriter(),
      argoNamespace: "argocd",
    }),
    catalogRepoUrl: "https://github.com/acme/acme-catalog.git",
    argoWatchTimeoutMs: 1000,
    resolveUnitApex: async () => "example.com",
    dns,
    probe,
    routingWaitMs: 0,
    routingPollMs: 0,
  };
}

async function seedTenant(reg: TenantRegistrations, routing: MemberRouting, opts: { suspended?: boolean } = {}): Promise<void> {
  db.db.insert(servers).values({ id: "srv_1", name: "m1", host: "1.2.3.4", sshUser: "root", role: "master", status: "healthy" }).run();
  db.db.insert(clusters).values({ id: "cls_1", serverId: "srv_1", stage: "prod", domain: CLUSTER, name: "s1", status: "active" }).run();
  db.db.insert(tenants).values({
    id: "tnt_1", clusterId: "cls_1", guid: GUID, subdomain: "acme", stage: "prod",
    members: ["auth", "jobs", "report"], identityProvider: "auth", routing, suspended: opts.suspended ?? false, status: "active",
  }).run();
  await reg.commitTenant({
    stage: "prod", guid: GUID, runId: "run_crt",
    registration: {
      cluster: "s1", subdomain: "acme", apps: [], members: testMembers(), identityProvider: "auth", routing, ownDomain: "",
      seedUsers: false, quota: TEST_QUOTA, resetNonce: "1", suspended: false, quiesced: false, appsImage: "", appsImageTag: "",
    },
  });
}

const rowRouting = (): string | undefined => db.db.select({ routing: tenants.routing }).from(tenants).where(eq(tenants.id, "tnt_1")).get()?.routing;

describe("tenant-set-routing", () => {
  it("moves a host-routed tenant onto paths: the zone record first, then the routing, then — once the IdP answers there — no wildcard", async () => {
    const reg = new TenantRegistrations(new FakePlatformRepo());
    await seedTenant(reg, "host");
    const dns = new FakeDnsProvider();
    dns.seed(WILDCARD, "CNAME", CLUSTER);
    const probe = new FakePublicProbe({ [PATH_IDP]: { reachable: true, status: 200, detail: "HTTP 200" } });
    const params = { tenantId: "tnt_1", routing: "path" as const, previous: "host" as const };
    await run(makeTenantSetRoutingDef(ports(reg, dns, probe)).steps(params), params, { cleanups: [], logs: [] });

    expect(dns.record(ZONE, "CNAME")).toBe(CLUSTER);
    expect(dns.record(WILDCARD, "CNAME")).toBeUndefined();
    expect((await reg.readTenant("prod", GUID))?.entry.routing).toBe("path");
    expect(rowRouting()).toBe("path");
    expect(probe.probed).toEqual([PATH_IDP]);
  });

  it("keeps the old record while the new address does not answer", async () => {
    const reg = new TenantRegistrations(new FakePlatformRepo());
    await seedTenant(reg, "host");
    const dns = new FakeDnsProvider();
    dns.seed(WILDCARD, "CNAME", CLUSTER);
    const probe = new FakePublicProbe(); // the edge answers 404: nothing routes the zone yet
    const params = { tenantId: "tnt_1", routing: "path" as const, previous: "host" as const };
    await expect(run(makeTenantSetRoutingDef(ports(reg, dns, probe)).steps(params), params, { cleanups: [], logs: [] })).rejects.toThrow(/did not answer/);
    // The wait failed: the old record still stands beside the new one, so the tenant is reachable. The
    // abort is proven through the Executor (tenant-routing.executor.test.ts).
    expect(dns.record(WILDCARD, "CNAME")).toBe(CLUSTER);
    expect(dns.record(ZONE, "CNAME")).toBe(CLUSTER);
  });

  it("does not take a redirect for the IdP: the old record stays while the zone's root redirects the IdP's path", async () => {
    const reg = new TenantRegistrations(new FakePlatformRepo());
    await seedTenant(reg, "host");
    const dns = new FakeDnsProvider();
    dns.seed(WILDCARD, "CNAME", CLUSTER);
    // Nothing routes /auth yet, so the website at the zone's root answers it with a redirect.
    const probe = new FakePublicProbe({ [PATH_IDP]: { reachable: true, status: 307, detail: "HTTP 307" } });
    const params = { tenantId: "tnt_1", routing: "path" as const, previous: "host" as const };
    await expect(run(makeTenantSetRoutingDef(ports(reg, dns, probe)).steps(params), params, { cleanups: [], logs: [] })).rejects.toThrow(/did not answer/);
    expect(dns.record(WILDCARD, "CNAME")).toBe(CLUSTER);
  });

  it("re-applies the routing a tenant has: its record stays, a record of the other routing left behind goes", async () => {
    const reg = new TenantRegistrations(new FakePlatformRepo());
    await seedTenant(reg, "path");
    const dns = new FakeDnsProvider();
    dns.seed(ZONE, "CNAME", CLUSTER);
    dns.seed(WILDCARD, "CNAME", CLUSTER);
    const probe = new FakePublicProbe({ [PATH_IDP]: { reachable: true, status: 200, detail: "HTTP 200" } });
    const params = { tenantId: "tnt_1", routing: "path" as const, previous: "path" as const };
    await run(makeTenantSetRoutingDef(ports(reg, dns, probe)).steps(params), params, { cleanups: [], logs: [] });

    expect(dns.record(ZONE, "CNAME")).toBe(CLUSTER);
    expect(dns.record(WILDCARD, "CNAME")).toBeUndefined();
    expect(rowRouting()).toBe("path");
  });

  it("refuses a suspended tenant at plan time — its ingress is down, so its new address could never answer", async () => {
    const reg = new TenantRegistrations(new FakePlatformRepo());
    await seedTenant(reg, "host", { suspended: true });
    const def = makeTenantSetRoutingDef(ports(reg, new FakeDnsProvider(), new FakePublicProbe()));
    await expect(def.plan({ tenantId: "tnt_1", routing: "path", previous: "host" }, { db: db.db })).rejects.toThrow(/suspended/);
  });

  it("plans attest-target first and says which record goes and which comes", async () => {
    const reg = new TenantRegistrations(new FakePlatformRepo());
    await seedTenant(reg, "host");
    const plan = await makeTenantSetRoutingDef(ports(reg, new FakeDnsProvider(), new FakePublicProbe())).plan({ tenantId: "tnt_1", routing: "path", previous: "host" }, { db: db.db });
    expect(plan.steps.map((s) => s.name)).toEqual(["attest-target", "provision-record", "write-routing", "retire-previous-record"]);
    expect(plan.summary).toContain(`provision the DNS record ${ZONE}`);
    expect(plan.summary).toContain(`remove ${WILDCARD}`);
  });
});
