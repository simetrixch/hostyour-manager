import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDb, type DbHandle } from "#core/server/db/client.ts";
import { listDnsWrites, recordDnsWrite } from "#core/server/db/dns-writes.ts";
import { FakeDnsProvider } from "#core/server/adapters/dns/testing/fake.ts";
import type { StepCtx } from "#core/server/executor/types.ts";
import type { CredentialStore } from "#core/server/security/store.ts";
import type { Logger } from "#core/server/kernel/logger.ts";
import { bookedIssuerLabel, provisionIssuerRecord, removeIssuerRecords, tenantIssuerRecord } from "./unit-dns.ts";

// The identity provider's DNS mark beside a tenant's zone record: the product's mail service trusts the
// tenant's issuer only where this TXT names it, so the mark is booked for the tenant that published it
// last and goes with that tenant's offboard or purge. Every case is asserted against the fake
// provider's own store and the book read back from the database.

const GUID = "zsjs023ctne0";
const REPLACED = "ak64h58875qw";
const MARK = tenantIssuerRecord("_digita-idp", "path", "auth", "prod", "show", "digitacloud.app");
const HOST_MARK = tenantIssuerRecord("_digita-idp", "host", "auth", "prod", "show", "digitacloud.app");

let db: DbHandle;
beforeEach(() => { db = openDb(":memory:"); });
afterEach(() => { db.sqlite.close(); });

function ctx(logs: string[], runId = "run_create"): StepCtx {
  return {
    runId, stepName: "provision-dns", db: db.db, creds: {} as unknown as CredentialStore, params: {},
    secrets: { get: () => undefined, wipe: () => undefined }, signal: new AbortController().signal, logger: {} as unknown as Logger,
    ssh: () => Promise.reject(new Error("no ssh")), openPasswordSession: () => Promise.reject(new Error("no ssh")),
    closePasswordSession: () => undefined, attest: () => Promise.reject(new Error("no attest")),
    log: (_s, t) => logs.push(t), checkpoint: () => undefined, readCheckpoint: () => undefined, registerCleanup: () => undefined,
  };
}

const book = (): string[] => listDnsWrites(db.db).map((w) => `${w.act} ${w.type} ${w.name} → ${w.content} for ${w.owner.kind} ${w.owner.name} ${w.owner.stage ?? ""} by ${w.runId}`);
const publish = (dns: FakeDnsProvider, logs: string[] = [], guid = GUID, record = MARK) =>
  provisionIssuerRecord(ctx(logs), { dns, guid, stage: "prod", record, runKind: "tenant-create" });

describe("provisionIssuerRecord", () => {
  it("publishes the mark where none stands and books it for the tenant at its stage", async () => {
    const dns = new FakeDnsProvider();
    await publish(dns);
    expect(await dns.listRecordContents({ name: MARK.name, type: "TXT" })).toEqual([MARK.content]);
    expect(book()).toEqual([`inserted TXT ${MARK.name} → ${MARK.content} for tenant ${GUID} prod by run_create`]);
  });

  it("PLANTED INNOCENT: leaves a mark that stands booked for the tenant, and writes nothing", async () => {
    const dns = new FakeDnsProvider();
    await publish(dns);
    const logs: string[] = [];
    await publish(dns, logs);
    expect(dns.creates).toHaveLength(1);
    expect(dns.deletes).toEqual([]);
    expect(logs).toEqual([`TXT ${MARK.name} → ${MARK.content} already stands, booked for tenant ${GUID}`]);
  });

  it("PLANTED DEFECT: takes over a mark that stands booked for a replaced tenant, so it goes with the tenant on the zone now", async () => {
    const dns = new FakeDnsProvider();
    dns.seed(MARK.name, "TXT", MARK.content);
    recordDnsWrite(db.db, { name: MARK.name, type: "TXT", content: MARK.content, act: "inserted", owner: { kind: "tenant", name: REPLACED, stage: "prod" }, runId: "run_old" });
    const logs: string[] = [];
    await publish(dns, logs);
    expect(book()).toEqual([`updated TXT ${MARK.name} → ${MARK.content} for tenant ${GUID} prod by run_create`]);
    expect(logs[0]).toContain(`booked for the tenant ${REPLACED}`);
    // The replaced tenant's purge now finds no mark of its own to remove.
    await removeIssuerRecords(ctx([]), { dns, guid: REPLACED, stage: "prod" });
    expect(await dns.listRecordContents({ name: MARK.name, type: "TXT" })).toEqual([MARK.content]);
  });

  it("books a mark that stands with no book row, the attempt that died before the book", async () => {
    const dns = new FakeDnsProvider();
    dns.seed(MARK.name, "TXT", MARK.content);
    await publish(dns);
    expect(book()).toEqual([`updated TXT ${MARK.name} → ${MARK.content} for tenant ${GUID} prod by run_create`]);
  });

  it("replaces what a gone installation left at the name, and says what stood there", async () => {
    const dns = new FakeDnsProvider();
    dns.seed(MARK.name, "TXT", "https://show.digitacloud.app/old-auth", "leftover");
    const logs: string[] = [];
    await publish(dns, logs);
    expect(await dns.listRecordContents({ name: MARK.name, type: "TXT" })).toEqual([MARK.content]);
    expect(logs[0]).toContain("in place of https://show.digitacloud.app/old-auth | leftover");
  });

  it("refuses without a DNS provider, rather than publishing nothing in silence", async () => {
    await expect(provisionIssuerRecord(ctx([]), { dns: undefined, guid: GUID, stage: "prod", record: MARK, runKind: "tenant-create" })).rejects.toThrow(/requires the DNS provider/);
  });
});

describe("removeIssuerRecords and bookedIssuerLabel", () => {
  it("removes every mark booked for the tenant at its stage but the excepted ones, and forgets them in the book", async () => {
    const dns = new FakeDnsProvider();
    await publish(dns);
    await publish(dns, [], GUID, HOST_MARK);
    await removeIssuerRecords(ctx([]), { dns, guid: GUID, stage: "prod", except: [HOST_MARK.name] });
    expect(await dns.listRecordContents({ name: MARK.name, type: "TXT" })).toEqual([]);
    expect(await dns.listRecordContents({ name: HOST_MARK.name, type: "TXT" })).toEqual([HOST_MARK.content]);
    expect(listDnsWrites(db.db).map((w) => w.name)).toEqual([HOST_MARK.name]);
  });

  it("PLANTED INNOCENT: leaves another tenant's mark, a CNAME of the tenant, and a mark re-pointed since it was booked", async () => {
    const dns = new FakeDnsProvider();
    await publish(dns, [], REPLACED, HOST_MARK);
    await publish(dns);
    dns.seed(MARK.name, "TXT", "https://elsewhere.example/auth");
    recordDnsWrite(db.db, { name: "show.digitacloud.app", type: "CNAME", content: "s1.example", act: "inserted", owner: { kind: "tenant", name: GUID, stage: "prod" }, runId: "run_create" });
    const logs: string[] = [];
    await removeIssuerRecords(ctx(logs), { dns, guid: GUID, stage: "prod" });
    expect(await dns.listRecordContents({ name: MARK.name, type: "TXT" })).toEqual(["https://elsewhere.example/auth"]);
    expect(await dns.listRecordContents({ name: HOST_MARK.name, type: "TXT" })).toEqual([HOST_MARK.content]);
    expect(listDnsWrites(db.db).map((w) => `${w.type} ${w.name}`).sort()).toEqual([`CNAME show.digitacloud.app`, `TXT ${HOST_MARK.name}`]);
    expect(logs).toEqual([`TXT ${MARK.name} no longer carries ${MARK.content} — left standing, it is not tenant ${GUID}'s any more`]);
  });

  it("names the label of the tenant's booked mark, and none where the book holds none", async () => {
    expect(bookedIssuerLabel(db.db, GUID, "prod")).toBeNull();
    await publish(new FakeDnsProvider());
    expect(bookedIssuerLabel(db.db, GUID, "prod")).toBe("_digita-idp");
    expect(bookedIssuerLabel(db.db, GUID, "dev")).toBeNull();
  });
});
