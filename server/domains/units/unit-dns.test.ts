import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDb, type DbHandle } from "../../db/client.ts";
import { servers, clusters } from "../../db/schema/inventory.ts";
import { listDnsWrites, recordDnsWrite } from "../../db/dns-writes.ts";
import { FakeDnsProvider } from "../../adapters/dns/testing/fake.ts";
import type { StepCtx } from "../../executor/types.ts";
import type { CredentialStore } from "../../security/store.ts";
import type { Logger } from "../../kernel/logger.ts";
import { isTenantRecord, provisionUnitDns, removeTenantBookedRecords, removeUnitDns } from "./unit-dns.ts";

// The unit's ONE record and the book of DNS writes beside it: provisionUnitDns writes a CNAME onto the
// target cluster's name and enters what it changed — inserted where nothing stood, updated where
// another record stood — and enters NOTHING where the record already pointed at the target, because
// the book says what this Manager changed; removeUnitDns takes the row out beside the record. Every
// case is asserted against the fake provider's own store and the book read back from the database.

const CLUSTER = "s1.example";
const OTHER = "s2.example";
const HOST = "post.example.net";

let db: DbHandle;
beforeEach(() => {
  db = openDb(":memory:");
  db.db.insert(servers).values({ id: "srv_1", name: "s1", host: "10.1.1.11", sshUser: "root", role: "slave", status: "healthy" }).run();
  db.db.insert(clusters).values({ id: "cls_1", serverId: "srv_1", stage: "prod", domain: CLUSTER, name: (CLUSTER).split(".")[0]!, status: "active" }).run();
  db.db.insert(servers).values({ id: "srv_2", name: "s2", host: "10.1.1.12", sshUser: "root", role: "slave", status: "healthy" }).run();
  db.db.insert(clusters).values({ id: "cls_2", serverId: "srv_2", stage: "prod", domain: OTHER, name: (OTHER).split(".")[0]!, status: "active" }).run();
});
afterEach(() => { db.sqlite.close(); });

function ctx(logs: string[], runId = "run_onboard"): StepCtx {
  return {
    runId, stepName: "provision-dns", db: db.db, creds: {} as unknown as CredentialStore, params: {},
    secrets: { get: () => undefined, wipe: () => undefined }, signal: new AbortController().signal, logger: {} as unknown as Logger,
    ssh: () => Promise.reject(new Error("no ssh")), openPasswordSession: () => Promise.reject(new Error("no ssh")),
    closePasswordSession: () => undefined, attest: () => Promise.reject(new Error("no attest")),
    log: (_s, t) => logs.push(t), checkpoint: () => undefined, readCheckpoint: () => undefined, registerCleanup: () => undefined,
  };
}

const consumer = (dns: FakeDnsProvider, over: { repoint?: boolean } = {}) =>
  ({ dns, unit: "post", kind: "consumer" as const, stage: "prod" as const, recordName: HOST, clusterFqdn: CLUSTER, runKind: "consumer-onboard", ...over });

describe("provisionUnitDns and the book", () => {
  it("a record that stood nowhere is inserted as a CNAME onto the cluster, whose own name need carry no address", async () => {
    const dns = new FakeDnsProvider(); // nothing stands under s1.example: a master identity that is itself a CNAME serves units the same way
    await provisionUnitDns(ctx([], "run_1"), consumer(dns));
    expect(dns.record(HOST, "CNAME")).toBe(CLUSTER);
    expect(listDnsWrites(db.db)).toMatchObject([
      { name: HOST, type: "CNAME", content: CLUSTER, act: "inserted", owner: { kind: "consumer", name: "post", stage: "prod" }, runId: "run_1" },
    ]);
  });

  it("an address record a gone installation left is taken off before the CNAME is written, and the book says updated", async () => {
    const dns = new FakeDnsProvider();
    dns.seed(HOST, "A", "157.90.201.150");
    const logs: string[] = [];
    await provisionUnitDns(ctx(logs, "run_2"), consumer(dns));
    expect(dns.record(HOST, "A")).toBeUndefined();
    expect(dns.record(HOST, "CNAME")).toBe(CLUSTER);
    expect(logs.some((l) => l.includes("stood as A 157.90.201.150") && l.includes(`replaced with a CNAME onto ${CLUSTER}`))).toBe(true);
    expect(listDnsWrites(db.db)).toMatchObject([{ name: HOST, type: "CNAME", act: "updated", content: CLUSTER, runId: "run_2" }]);
  });

  it("a CNAME onto a name that is no cluster of this installation is repointed in place", async () => {
    const dns = new FakeDnsProvider();
    dns.seed(HOST, "CNAME", "apps4.gone.example");
    await provisionUnitDns(ctx([], "run_3"), consumer(dns));
    expect(dns.upserts).toEqual([{ name: HOST, type: "CNAME", content: CLUSTER, created: false }]);
    expect(listDnsWrites(db.db)).toMatchObject([{ act: "updated", runId: "run_3" }]);
  });

  it("REFUSES a host that points at another cluster of this installation, and writes nothing", async () => {
    const dns = new FakeDnsProvider();
    dns.seed(HOST, "CNAME", OTHER);
    await expect(provisionUnitDns(ctx([]), consumer(dns))).rejects.toThrow(`already points at ${OTHER}, a cluster of this installation`);
    expect(dns.upserts).toEqual([]);
    expect(listDnsWrites(db.db)).toEqual([]);
  });

  it("a record that already points at the cluster is left alone in the book — nothing was changed", async () => {
    const dns = new FakeDnsProvider();
    dns.seed(HOST, "CNAME", CLUSTER);
    const logs: string[] = [];
    await provisionUnitDns(ctx(logs, "run_4"), consumer(dns));
    // The provider was still asked (the upsert is idempotent), the book was not.
    expect(dns.upserts).toHaveLength(1);
    expect(logs.at(-1)).toContain("updated in place");
    expect(listDnsWrites(db.db)).toEqual([]);
  });

  it("a re-run over its own earlier write keeps the earlier row rather than overwriting it with a write that changed nothing", async () => {
    const dns = new FakeDnsProvider();
    await provisionUnitDns(ctx([], "run_1"), consumer(dns));
    await provisionUnitDns(ctx([], "run_5"), consumer(dns));
    expect(listDnsWrites(db.db)).toMatchObject([{ act: "inserted", runId: "run_1" }]);
  });

  it("the move (repoint) takes the record off the source cluster, and the switch is booked as updated by the tenant's run", async () => {
    const dns = new FakeDnsProvider();
    dns.seed("*.acme.example.net", "CNAME", OTHER); // the source cluster
    await provisionUnitDns(ctx([], "run_move"), { dns, unit: "zsjs023ctne0", kind: "tenant", stage: "prod", recordName: "*.acme.example.net", clusterFqdn: CLUSTER, runKind: "tenant-migrate", repoint: true });
    expect(dns.record("*.acme.example.net", "CNAME")).toBe(CLUSTER);
    expect(listDnsWrites(db.db)).toMatchObject([
      { name: "*.acme.example.net", type: "CNAME", act: "updated", content: CLUSTER, owner: { kind: "tenant", name: "zsjs023ctne0", stage: "prod" }, runId: "run_move" },
    ]);
  });

  it("a provider failure books nothing — the book never records a write the zone did not take", async () => {
    const dns = new FakeDnsProvider();
    dns.failWith = new Error("Cloudflare DNS refused");
    await expect(provisionUnitDns(ctx([]), consumer(dns))).rejects.toThrow(/Cloudflare DNS refused/);
    expect(listDnsWrites(db.db)).toEqual([]);
  });
});

describe("isTenantRecord — what a tenant's purge may remove", () => {
  it("a wildcard is always the tenant's; a plain name only where the book names the tenant as its owner", () => {
    expect(isTenantRecord(db.db, "*.acme.example.com", "zsjs023ctne0")).toBe(true);
    expect(isTenantRecord(db.db, "acme.example.com", "zsjs023ctne0")).toBe(false);
    recordDnsWrite(db.db, { name: "acme.example.com", type: "CNAME", content: CLUSTER, act: "inserted", owner: { kind: "consumer", name: "acme", stage: "prod" }, runId: "run_c" });
    expect(isTenantRecord(db.db, "acme.example.com", "zsjs023ctne0")).toBe(false);
    recordDnsWrite(db.db, { name: "acme.example.com", type: "CNAME", content: CLUSTER, act: "updated", owner: { kind: "tenant", name: "zsjs023ctne0", stage: "prod" }, runId: "run_t" });
    expect(isTenantRecord(db.db, "acme.example.com", "zsjs023ctne0")).toBe(true);
  });
});

describe("removeTenantBookedRecords — the records a tenant's offboard and purge take along", () => {
  it("removes a record booked to the tenant at this stage while it points where the book says, and nothing else", async () => {
    const dns = new FakeDnsProvider();
    const book = (name: string, content: string, stage: "prod" | "dev"): void =>
      recordDnsWrite(db.db, { name, type: "CNAME", content, act: "inserted", owner: { kind: "tenant", name: "zsjs023ctne0", stage }, runId: "run_t" });
    dns.seed("www.customer.test", "CNAME", "acme.example.com");
    book("www.customer.test", "acme.example.com", "prod");
    dns.seed("moved.customer.test", "CNAME", "shop.elsewhere.test");
    book("moved.customer.test", "acme.example.com", "prod");
    dns.seed("acme.dev.example.com", "CNAME", CLUSTER);
    book("acme.dev.example.com", CLUSTER, "dev");
    await removeTenantBookedRecords(ctx([]), { dns, guid: "zsjs023ctne0", stage: "prod", except: [] });
    expect(dns.record("www.customer.test", "CNAME")).toBeUndefined();
    expect(dns.record("moved.customer.test", "CNAME")).toBe("shop.elsewhere.test");
    expect(dns.record("acme.dev.example.com", "CNAME")).toBe(CLUSTER);
  });
});

describe("removeUnitDns and the book", () => {
  it("takes the row out beside the record", async () => {
    const dns = new FakeDnsProvider();
    await provisionUnitDns(ctx([]), consumer(dns));
    expect(listDnsWrites(db.db)).toHaveLength(1);
    await removeUnitDns(ctx([]), { dns, unit: "post", recordName: HOST });
    expect(dns.record(HOST, "CNAME")).toBeUndefined();
    expect(listDnsWrites(db.db)).toEqual([]);
  });

  it("forgets a row whose record is already absent — a unit whose run died after the book was written", async () => {
    const dns = new FakeDnsProvider();
    recordDnsWrite(db.db, { name: HOST, type: "CNAME", content: CLUSTER, act: "inserted", owner: { kind: "consumer", name: "post", stage: "prod" }, runId: "run_dead" });
    const logs: string[] = [];
    await removeUnitDns(ctx(logs), { dns, unit: "post", recordName: HOST });
    expect(logs.at(-1)).toContain("already absent");
    expect(listDnsWrites(db.db)).toEqual([]);
  });

  it("leaves the row standing when the provider refuses — the record still stands, and so must the book", async () => {
    const dns = new FakeDnsProvider();
    await provisionUnitDns(ctx([]), consumer(dns));
    dns.failWith = new Error("Cloudflare DNS refused");
    await expect(removeUnitDns(ctx([]), { dns, unit: "post", recordName: HOST })).rejects.toThrow(/Cloudflare DNS refused/);
    expect(listDnsWrites(db.db)).toHaveLength(1);
  });
});
