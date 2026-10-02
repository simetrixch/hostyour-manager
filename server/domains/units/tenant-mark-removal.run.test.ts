import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { seedQuota } from "#unit/shared/unit-size.ts";
import { openDb, type DbHandle } from "../../db/client.ts";
import type { PlanStreamCtx, StepCtx } from "../../executor/types.ts";
import type { CredentialStore } from "../../security/store.ts";
import type { Logger } from "../../kernel/logger.ts";
import { servers, clusters, tenants } from "../../db/schema/inventory.ts";
import { listDnsWrites } from "../../db/dns-writes.ts";
import { makeTenantPurgeDef, type TenantPurgeRequest } from "./tenant-purge.run.ts";
import { makeOffboardTenantDef } from "./tenant-offboard.run.ts";
import { TenantRegistrations } from "./tenant-registrations.ts";
import type { TenantLifecyclePorts } from "./lifecycle.ts";
import { FakePlatformRepo } from "../../adapters/git/testing/fake.ts";
import { FakeDnsProvider } from "../../adapters/dns/testing/fake.ts";
import { FakeMasterArgoReader, FakeClusterReader, FakeMasterProjectWriter, FakeClusterKubeResolver } from "../../adapters/kube/testing/fake.ts";
import { provisionIssuerRecord, tenantIssuerRecord } from "#unit/server/unit-dns.ts";
import type { TenantRegistration } from "../../../shared/tenant.ts";
import { ARGO_NS, testMembers } from "./tenant-members.fixture.ts";

// The identity provider's DNS mark goes with its tenant on every removal path: tenant-offboard,
// tenant-purge with a subdomain, and the re-run tenant-purge whose registration an earlier purge already
// removed, so it knows no subdomain. A mark left behind would keep the product's mail service trusting
// whatever serves that host next. The fixtures are the purge tests' own, cut to what remove-dns reads.

const GUID = "zsjs023ctne0";
const MARK = tenantIssuerRecord("_digita-idp", "host", "auth", "prod", "acme", "example.com");
const REQUEST: TenantPurgeRequest = { guid: GUID, stage: "prod", clusterId: "cls_1" };

let db: DbHandle;
beforeEach(() => {
  db = openDb(":memory:");
  db.db.insert(servers).values({ id: "srv_1", name: "s1", host: "10.1.1.11", sshUser: "root", role: "slave", status: "healthy" }).run();
  db.db.insert(clusters).values({ id: "cls_1", serverId: "srv_1", stage: "prod", domain: "s1.example", name: "s1", status: "active" }).run();
});
afterEach(() => { db.sqlite.close(); });

function ports(reg: TenantRegistrations, dns: FakeDnsProvider, over: Partial<TenantLifecyclePorts> = {}): TenantLifecyclePorts {
  return {
    registrations: reg,
    resolver: new FakeClusterKubeResolver({
      clusterReader: new FakeClusterReader({ deployState: { domain: "s1.example", stage: "prod", writtenAt: "2026-01-01T00:00:00Z", generation: 3 } }),
      argoReader: new FakeMasterArgoReader(),
      projectWriter: new FakeMasterProjectWriter(),
      argoNamespace: ARGO_NS,
    }),
    deployRepoUrl: "https://github.com/acme/acme-deploy.git",
    argoWatchTimeoutMs: 1000,
    resolveUnitApex: async () => "example.com",
    dns,
    ...over,
  };
}

function entry(): TenantRegistration {
  return {
    members: testMembers([]), identityProvider: "auth", routing: "host", ownDomain: "", ownDomainRedirects: [], approvedTags: {}, senderDomain: "",
    cluster: "s1", subdomain: "acme", apps: [], seedUsers: false, quota: seedQuota("small"), resetNonce: "1", suspended: false, quiesced: false, appsImage: "", appsImageTag: "",
  };
}

function ctx(params: object): StepCtx {
  return {
    runId: "run_x", stepName: "remove-dns", db: db.db, creds: {} as unknown as CredentialStore, params: params as StepCtx["params"],
    secrets: { get: () => undefined, wipe: () => undefined }, signal: new AbortController().signal, logger: {} as unknown as Logger,
    ssh: () => Promise.reject(new Error("no ssh")), openPasswordSession: () => Promise.reject(new Error("no ssh")),
    closePasswordSession: () => undefined, attest: () => Promise.reject(new Error("no attest")),
    log: () => undefined, checkpoint: () => undefined, readCheckpoint: () => undefined, registerCleanup: () => undefined,
  };
}

/** The mark as tenant-create leaves it: standing and booked for the tenant. */
async function marked(dns: FakeDnsProvider, guid = GUID): Promise<void> {
  await provisionIssuerRecord(ctx({}), { dns, guid, stage: "prod", record: MARK, runKind: "tenant-create" });
}

const standing = (dns: FakeDnsProvider): Promise<string[]> => dns.listRecordContents({ name: MARK.name, type: "TXT" });

async function purgeRemoveDns(p: TenantLifecyclePorts): Promise<void> {
  const planCtx: PlanStreamCtx = { db: db.db, log: () => undefined, signal: new AbortController().signal };
  const result = await makeTenantPurgeDef(p).planStream!(REQUEST, planCtx);
  if (result.outcome !== "planned") throw new Error(`rejected: ${result.summary}`);
  await makeTenantPurgeDef(p).steps(result.params).find((s) => s.name === "remove-dns")!.run(ctx(result.params));
}

describe("the identity provider's DNS mark goes with its tenant", () => {
  it("tenant-offboard removes the mark beside the zone record, and the book forgets it", async () => {
    db.db.insert(tenants).values({ id: "tnt_1", clusterId: "cls_1", guid: GUID, subdomain: "acme", stage: "prod", members: ["auth", "jobs", "report"], identityProvider: "auth", status: "active" }).run();
    const dns = new FakeDnsProvider();
    await marked(dns);
    await makeOffboardTenantDef(ports(new TenantRegistrations(new FakePlatformRepo()), dns)).steps({ tenantId: "tnt_1" }).find((s) => s.name === "remove-dns")!.run(ctx({ tenantId: "tnt_1" }));
    expect(await standing(dns)).toEqual([]);
    expect(listDnsWrites(db.db).some((w) => w.name === MARK.name)).toBe(false);
  });

  it("tenant-purge with a subdomain removes the mark", async () => {
    const reg = new TenantRegistrations(new FakePlatformRepo());
    await reg.commitTenant({ stage: "prod", guid: GUID, registration: entry(), runId: "run_onb" });
    const dns = new FakeDnsProvider();
    await marked(dns);
    await purgeRemoveDns(ports(reg, dns));
    expect(await standing(dns)).toEqual([]);
  });

  it("PLANTED DEFECT: the re-run tenant-purge that knows no subdomain removes the mark too, although it stands under the platform's apex", async () => {
    const dns = new FakeDnsProvider();
    await marked(dns);
    await purgeRemoveDns(ports(new TenantRegistrations(new FakePlatformRepo()), dns));
    expect(await standing(dns)).toEqual([]);
  });

  it("removes the mark before a purge without a subdomain refuses on an apex it cannot read", async () => {
    db.db.insert(servers).values({ id: "srv_2", name: "s2", host: "10.1.1.12", sshUser: "root", role: "slave", status: "healthy" }).run();
    db.db.insert(clusters).values({ id: "cls_2", serverId: "srv_2", stage: "prod", domain: "s2.example", name: "s2", status: "active" }).run();
    const dns = new FakeDnsProvider();
    await marked(dns);
    const p = ports(new TenantRegistrations(new FakePlatformRepo()), dns, { resolveUnitApex: async (domain: string) => { if (domain === "s2.example") throw new Error("no install branch"); return "example.com"; } });
    await expect(purgeRemoveDns(p)).rejects.toThrow(/the unit apex of s2 cannot be read/);
    expect(await standing(dns)).toEqual([]);
  });

  it("PLANTED INNOCENT: a purge leaves the mark a newer tenant on the same subdomain took over", async () => {
    const dns = new FakeDnsProvider();
    await marked(dns);
    await marked(dns, "ffffffffffff"); // the newer tenant's create publishes the same mark and books it for itself
    await purgeRemoveDns(ports(new TenantRegistrations(new FakePlatformRepo()), dns));
    expect(await standing(dns)).toEqual([MARK.content]);
    expect(listDnsWrites(db.db).find((w) => w.name === MARK.name)?.owner.name).toBe("ffffffffffff");
  });
});
