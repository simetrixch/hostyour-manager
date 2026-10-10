import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDb, type DbHandle } from "#core/server/db/client.ts";
import { listDnsWrites, recordDnsWrite } from "#core/server/db/dns-writes.ts";
import { FakeDnsProvider } from "#core/server/adapters/dns/testing/fake.ts";
import type { StepCtx } from "#core/server/executor/types.ts";
import type { CredentialStore } from "#core/server/security/store.ts";
import type { Logger } from "#core/server/kernel/logger.ts";
import { publishIssuerRecord, removeIssuerRecords, tenantIssuerRecord } from "./unit-dns.ts";

// The identity provider's DNS mark beside a tenant's zone record: the product's mail service trusts the
// tenant's issuer only where this TXT names it, so the mark is booked for the tenant that published it
// last and goes with that tenant's offboard or purge. Every case is asserted against the fake
// provider's own store and the book read back from the database.

const GUID = "zsjs023ctne0";
const REPLACED = "ak64h58875qw";
const MARK = tenantIssuerRecord("_digita-idp", "auth", "prod", "show", "digitacloud.app");
const SECOND_MARK = tenantIssuerRecord("_second-idp", "auth", "prod", "show", "digitacloud.app");
const CLUSTER = "s1.example";

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
  publishIssuerRecord(ctx(logs), { dns, guid, stage: "prod", record, clusterFqdn: CLUSTER, runKind: "tenant-create" });

describe("publishIssuerRecord", () => {
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

  it("PLANTED DEFECT: adopts a mark that stands booked for a replaced tenant, without a write, so it goes with the tenant on the zone now", async () => {
    const dns = new FakeDnsProvider();
    dns.seed(MARK.name, "TXT", MARK.content);
    recordDnsWrite(db.db, { name: MARK.name, type: "TXT", content: MARK.content, act: "inserted", owner: { kind: "tenant", name: REPLACED, stage: "prod" }, runId: "run_old" });
    const logs: string[] = [];
    await publish(dns, logs);
    expect(book()).toEqual([`adopted TXT ${MARK.name} → ${MARK.content} for tenant ${GUID} prod by run_create`]);
    // Never absent in between: the record is neither deleted nor written again.
    expect([dns.deletes, dns.creates]).toEqual([[], []]);
    expect(logs[0]).toContain(`booked for the tenant ${REPLACED} — adopted for tenant ${GUID}`);
    // The replaced tenant's purge now finds no mark of its own to remove.
    await removeIssuerRecords(ctx([]), { dns, guid: REPLACED, stage: "prod" });
    expect(await dns.listRecordContents({ name: MARK.name, type: "TXT" })).toEqual([MARK.content]);
  });

  it("adopts a mark that stands with no book row, the attempt that died before the book", async () => {
    const dns = new FakeDnsProvider();
    dns.seed(MARK.name, "TXT", MARK.content);
    await publish(dns);
    expect(book()).toEqual([`adopted TXT ${MARK.name} → ${MARK.content} for tenant ${GUID} prod by run_create`]);
    expect(dns.creates).toEqual([]);
  });

  it("PLANTED INNOCENT: publishes beside what a gone installation left at the name, deletes none of it, and says what stands there", async () => {
    const dns = new FakeDnsProvider();
    dns.seed(MARK.name, "TXT", "https://show.digitacloud.app/old-auth", "leftover");
    const logs: string[] = [];
    await publish(dns, logs);
    expect((await dns.listRecordContents({ name: MARK.name, type: "TXT" })).sort()).toEqual([MARK.content, "https://show.digitacloud.app/old-auth", "leftover"].sort());
    expect(dns.deletes).toEqual([]);
    expect(logs[0]).toContain("beside it stands https://show.digitacloud.app/old-auth | leftover, which no run of this Manager wrote and which is left as it is");
  });

  it("leaves a TXT booked for the tenant whose name carries no underscore label: it is no mark", async () => {
    const dns = new FakeDnsProvider();
    dns.seed("show.digitacloud.app", "TXT", "v=spf1 -all");
    recordDnsWrite(db.db, { name: "show.digitacloud.app", type: "TXT", content: "v=spf1 -all", act: "inserted", owner: { kind: "tenant", name: GUID, stage: "prod" }, runId: "run_other" });
    await removeIssuerRecords(ctx([]), { dns, guid: GUID, stage: "prod" });
    expect(await dns.listRecordContents({ name: "show.digitacloud.app", type: "TXT" })).toEqual(["v=spf1 -all"]);
  });

  it("refuses without a DNS provider, rather than publishing nothing in silence", async () => {
    await expect(publishIssuerRecord(ctx([]), { dns: undefined, guid: GUID, stage: "prod", record: MARK, clusterFqdn: CLUSTER, runKind: "tenant-create" })).rejects.toThrow(/requires the DNS provider/);
  });
});

describe("removeIssuerRecords", () => {
  it("removes every mark booked for the tenant at its stage, and forgets them in the book", async () => {
    const dns = new FakeDnsProvider();
    await publish(dns);
    await publish(dns, [], GUID, SECOND_MARK);
    await removeIssuerRecords(ctx([]), { dns, guid: GUID, stage: "prod" });
    expect(await dns.listRecordContents({ name: MARK.name, type: "TXT" })).toEqual([]);
    expect(await dns.listRecordContents({ name: SECOND_MARK.name, type: "TXT" })).toEqual([]);
    expect(listDnsWrites(db.db)).toEqual([]);
  });

  it("PLANTED INNOCENT: leaves another tenant's mark, a CNAME of the tenant, and a mark re-pointed since it was booked", async () => {
    const dns = new FakeDnsProvider();
    await publish(dns, [], REPLACED, SECOND_MARK);
    await publish(dns);
    dns.seed(MARK.name, "TXT", "https://elsewhere.example/auth");
    recordDnsWrite(db.db, { name: "show.digitacloud.app", type: "CNAME", content: "s1.example", act: "inserted", owner: { kind: "tenant", name: GUID, stage: "prod" }, runId: "run_create" });
    const logs: string[] = [];
    await removeIssuerRecords(ctx(logs), { dns, guid: GUID, stage: "prod" });
    expect(await dns.listRecordContents({ name: MARK.name, type: "TXT" })).toEqual(["https://elsewhere.example/auth"]);
    expect(await dns.listRecordContents({ name: SECOND_MARK.name, type: "TXT" })).toEqual([SECOND_MARK.content]);
    expect(listDnsWrites(db.db).map((w) => `${w.type} ${w.name}`).sort()).toEqual([`CNAME show.digitacloud.app`, `TXT ${SECOND_MARK.name}`]);
    expect(logs).toEqual([`TXT ${MARK.name} no longer carries ${MARK.content} — left standing, it is not tenant ${GUID}'s any more`]);
  });
});
