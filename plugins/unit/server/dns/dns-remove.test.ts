import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDb, type DbHandle } from "#core/server/db/client.ts";
import { listDnsWrites, recordDnsWrite } from "#core/server/db/dns-writes.ts";
import { FakeDnsProvider } from "#core/server/adapters/dns/testing/fake.ts";
import type { StepCtx } from "#core/server/executor/types.ts";
import type { CredentialStore } from "#core/server/security/store.ts";
import type { Logger } from "#core/server/kernel/logger.ts";
import type { DnsInventoryView, DnsRecordRow, DnsRecordType } from "#core/shared/dns.ts";
import { DnsRemoveParams, makeDnsRemoveDef } from "./dns-remove.ts";
import type { DnsRecordPorts } from "./dns-record.kit.ts";

// dns-remove takes a LIST of records back at the provider in one run, one step each. What these
// tests hold is the refusal: the run deletes only what the DNS inventory names as this
// installation's and removable, so a typed name and a row this platform merely depends on both end
// the WHOLE plan with one sentence naming them instead of a deletion of the rest. The steps run
// against a real database, because each deletion takes its record's row out of the book of DNS
// writes beside it. An A record goes by name and type; a TXT goes by the content this installation
// owns, so a sibling TXT with other content stays. A list of one is the removal as it was before
// hostyour-manager#172, and the params still accept that shape.

let db: DbHandle;
beforeEach(() => { db = openDb(":memory:"); });
afterEach(() => { db.sqlite.close(); });

const CONSUMER_ROW: DnsRecordRow = {
  owner: { kind: "consumer", name: "post", stage: "prod" },
  name: "post.example.net", type: "A", expected: "203.0.113.9", found: "198.51.100.4", verdict: "other", removable: true,
};
const AUTH_ROW: DnsRecordRow = {
  owner: { kind: "consumer", name: "auth", stage: "prod" },
  name: "auth.example.net", type: "A", expected: "203.0.113.9", found: "203.0.113.9", verdict: "standing", removable: true,
};
const INSTALLER_ROW: DnsRecordRow = {
  owner: { kind: "installer", name: "example.com" },
  name: "example.com", type: "A", record: "a", expected: "203.0.113.9", found: "203.0.113.9", verdict: "standing", removable: false,
};
const DMARC_ROW: DnsRecordRow = {
  owner: { kind: "mail", name: "example.com" },
  name: "_dmarc.example.com", type: "TXT", record: "dmarc", expected: "one v=DMARC1 record", found: "v=DMARC1; p=none", verdict: "standing", removable: true,
};

/** The platform domain's apex SPF, its own mail service's, and the envelope sender's SPF, the platform's. */
const SERVICE_SPF_ROW: DnsRecordRow = {
  owner: { kind: "mail-service", name: "example.com" },
  name: "example.com", type: "TXT", record: "spf", expected: "one v=spf1 record", found: "v=spf1 include:spf.protection.outlook.com -all", verdict: "standing", removable: false,
};
const ENVELOPE_ROW: DnsRecordRow = {
  owner: { kind: "mail", name: "example.com" },
  name: "mail.example.com", type: "TXT", record: "envelope-spf", expected: "one v=spf1 record naming ip4:203.0.113.9", found: "v=spf1 ip4:203.0.113.9 -all", verdict: "standing", removable: true,
};

const inventory = (rows: DnsRecordRow[]): DnsInventoryView => ({ rows, skipped: [], readAt: new Date().toISOString() });
const ports = (dns?: FakeDnsProvider, rows: DnsRecordRow[] = [CONSUMER_ROW, INSTALLER_ROW]): DnsRecordPorts => ({
  ...(dns ? { dns } : {}),
  readDnsInventory: async () => inventory(rows),
});

function ctx(logs: string[], params: DnsRemoveParams): StepCtx {
  return {
    runId: "run_dns", stepName: "remove-record", db: db.db, creds: {} as unknown as CredentialStore, params: { ...params },
    secrets: { get: () => undefined, wipe: () => undefined }, signal: new AbortController().signal, logger: {} as unknown as Logger,
    ssh: () => Promise.reject(new Error("no ssh")), openPasswordSession: () => Promise.reject(new Error("no ssh")),
    closePasswordSession: () => undefined, attest: () => Promise.reject(new Error("no attest")),
    log: (_s, t) => logs.push(t), checkpoint: () => undefined, readCheckpoint: () => undefined, registerCleanup: () => undefined,
  };
}

const one = (name: string, type: DnsRecordType): DnsRemoveParams => ({ records: [{ name, type }] });
const PARAMS = one("post.example.net", "A");
const THREE: DnsRemoveParams = { records: [{ name: "post.example.net", type: "A" }, { name: "_dmarc.example.com", type: "TXT" }, { name: "auth.example.net", type: "A" }] };
const THREE_ROWS = [CONSUMER_ROW, INSTALLER_ROW, DMARC_ROW, AUTH_ROW];
const deps = { get db() { return db.db; } };

describe("dns-remove params", () => {
  it("takes the list, and still accepts the one-record shape from before #172 as the list of one", () => {
    expect(DnsRemoveParams.parse(THREE)).toEqual(THREE);
    expect(DnsRemoveParams.parse({ name: "post.example.net", type: "A" })).toEqual(PARAMS);
  });

  it("refuses an empty list, a record listed twice, and a type this platform never writes", () => {
    expect(() => DnsRemoveParams.parse({ records: [] })).toThrow();
    expect(() => DnsRemoveParams.parse({ records: [PARAMS.records[0], PARAMS.records[0]] })).toThrow(/listed twice/);
    expect(() => DnsRemoveParams.parse({ records: [{ name: "x.example.net", type: "PTR" }] })).toThrow();
  });

  it("starts with attest-target under empty params — the armed check evaluates def.steps({})", () => {
    expect(makeDnsRemoveDef(ports(new FakeDnsProvider())).steps({} as DnsRemoveParams).map((s) => s.name)).toEqual(["attest-target"]);
  });
});

describe("dns-remove plan", () => {
  it("plans attest-target and one step per record against this manager itself, in the order asked", async () => {
    const dns = new FakeDnsProvider();
    dns.seed("post.example.net", "A", "198.51.100.4");
    dns.seed("_dmarc.example.com", "TXT", "somebody-else=verification", "v=DMARC1; p=none");
    dns.seed("auth.example.net", "A", "203.0.113.9");
    const plan = await makeDnsRemoveDef(ports(dns, THREE_ROWS)).plan(THREE, deps);
    expect(plan.steps.map((s) => s.name)).toEqual([
      "attest-target",
      "remove-record:A post.example.net",
      "remove-record:TXT _dmarc.example.com",
      "remove-record:A auth.example.net",
    ]);
    expect(plan).toMatchObject({ targetKind: "self", targetId: "manager", requiredSecrets: [] });
    expect(plan.summary).toMatch(/^Take back 3 records, one step each; 3 are deleted at the DNS provider: /);
    // Each sentence says what GOES, by the rule the step carries out, never only what stands.
    expect(plan.summary).toContain('the A record post.example.net (the consumer "post" at prod): deletes every A record of the name (198.51.100.4)');
    expect(plan.summary).toContain('the TXT record _dmarc.example.com (the mail "example.com"): deletes v=DMARC1; p=none, and somebody-else=verification stays');
    expect(plan.summary).toContain('the A record auth.example.net (the consumer "auth" at prod): deletes every A record of the name (203.0.113.9)');
    // Only the records in use right now warn: post answers with an address its owner does not expect.
    expect(plan.warnings).toEqual([
      '_dmarc.example.com answers with exactly what the mail "example.com" needs — removing it takes a name that is in use right now out of DNS.',
      'auth.example.net answers with exactly what the consumer "auth" at prod needs — removing it takes a name that is in use right now out of DNS.',
    ]);
  });

  it("a list of one plans the two steps the single removal always had", async () => {
    const plan = await makeDnsRemoveDef(ports(new FakeDnsProvider())).plan(PARAMS, deps);
    expect(plan.steps.map((s) => s.name)).toEqual(["attest-target", "remove-record:A post.example.net"]);
    expect(plan.summary).toMatch(/^Take back one record, one step each; nothing is deleted at the DNS provider: /);
    expect(plan.summary).toContain('the A record post.example.net (the consumer "post" at prod): nothing stands there, so nothing is deleted');
    expect(plan.warnings).toEqual([]);
  });

  it("refuses the WHOLE plan on one foreign name among three, naming it and the count — the inventory is the permission, not the operator's typing", async () => {
    const params: DnsRemoveParams = { records: [THREE.records[0]!, { name: "foreign.example", type: "A" }, THREE.records[2]!] };
    await expect(makeDnsRemoveDef(ports(new FakeDnsProvider(), THREE_ROWS)).plan(params, deps))
      .rejects.toThrow(/^1 of the 3 record\(s\) cannot be taken back, so none is: this installation owns no A record foreign\.example\./);
  });

  it("names every refused record with its own reason: a foreign name and a read-only row are two different mistakes", async () => {
    const params: DnsRemoveParams = { records: [{ name: "foreign.example", type: "A" }, { name: "example.com", type: "A" }, THREE.records[0]!] };
    await expect(makeDnsRemoveDef(ports(new FakeDnsProvider(), THREE_ROWS)).plan(params, deps))
      .rejects.toThrow(/2 of the 3 record\(s\) cannot be taken back, so none is: this installation owns no A record foreign\.example; the A record example\.com is listed read-only: it is the installer "example\.com"'s\./);
  });

  it("refuses the apex SPF of a domain whose mail runs on its own mail service, naming that service as its owner", async () => {
    await expect(makeDnsRemoveDef(ports(new FakeDnsProvider(), [SERVICE_SPF_ROW, ENVELOPE_ROW])).plan(one("example.com", "TXT"), deps))
      .rejects.toThrow(/the TXT record example\.com is listed read-only: it is the mail-service "example\.com"'s/);
  });

  it("refuses without a DNS provider rather than reporting a removal nobody made", async () => {
    await expect(makeDnsRemoveDef(ports()).plan(PARAMS, deps)).rejects.toThrow(/no DNS provider is wired into this manager/);
  });
});

describe("dns-remove steps", () => {
  it("attests every record is still ours, then each step deletes its own record and forgets its row in the book", async () => {
    const dns = new FakeDnsProvider();
    dns.seed("post.example.net", "A", "198.51.100.4");
    dns.seed("_dmarc.example.com", "TXT", "v=DMARC1; p=none", "somebody-else=verification");
    dns.seed("auth.example.net", "A", "203.0.113.9");
    for (const [name, type, content] of [["post.example.net", "A", "198.51.100.4"], ["_dmarc.example.com", "TXT", "v=DMARC1; p=none"], ["auth.example.net", "A", "203.0.113.9"]] as const) {
      recordDnsWrite(db.db, { name, type, content, act: "inserted", owner: { kind: "consumer", name: "x", stage: "prod" }, runId: "run_old" });
    }
    recordDnsWrite(db.db, { name: "mail.example.net", type: "A", content: "203.0.113.9", act: "inserted", owner: { kind: "consumer", name: "mail", stage: "prod" }, runId: "run_old" });
    const logs: string[] = [];
    const steps = makeDnsRemoveDef(ports(dns, THREE_ROWS)).steps(THREE);
    expect(steps).toHaveLength(4);
    await steps[0]!.run(ctx(logs, THREE));
    expect(logs).toEqual([
      'A post.example.net belongs to the consumer "post" at prod and stands at 198.51.100.4',
      'TXT _dmarc.example.com belongs to the mail "example.com" and stands at v=DMARC1; p=none',
      'A auth.example.net belongs to the consumer "auth" at prod and stands at 203.0.113.9',
    ]);
    // Step by step: after the first remove the other two records still stand and their rows are still in the book.
    await steps[1]!.run(ctx(logs, THREE));
    expect(dns.deletes).toEqual([{ name: "post.example.net", type: "A", content: "198.51.100.4", deleted: 1 }]);
    expect(listDnsWrites(db.db).map((r) => r.name).sort()).toEqual(["_dmarc.example.com", "auth.example.net", "mail.example.net"]);
    await steps[2]!.run(ctx(logs, THREE));
    await steps[3]!.run(ctx(logs, THREE));
    expect(dns.deletes).toEqual([
      // Every booked record by the content the book holds.
      { name: "post.example.net", type: "A", content: "198.51.100.4", deleted: 1 },
      { name: "_dmarc.example.com", type: "TXT", content: "v=DMARC1; p=none", deleted: 1 },
      { name: "auth.example.net", type: "A", content: "203.0.113.9", deleted: 1 },
    ]);
    expect(await dns.listRecordContents({ name: "_dmarc.example.com", type: "TXT" })).toEqual(["somebody-else=verification"]);
    expect(logs.slice(3)).toEqual([
      "A post.example.net stood at 198.51.100.4 and is gone (1 removed)",
      "TXT _dmarc.example.com stood at v=DMARC1; p=none and is gone (1 removed, 1 other record(s) of the name left standing)",
      "A auth.example.net stood at 203.0.113.9 and is gone (1 removed)",
    ]);
    // The three rows leave the book; the row of a record nobody asked for stays.
    expect(listDnsWrites(db.db).map((r) => r.name)).toEqual(["mail.example.net"]);
  });

  it("a list of one attests, deletes by name and type, says what stood there, and forgets it in the book — as the single removal did", async () => {
    const dns = new FakeDnsProvider();
    dns.seed("post.example.net", "A", "198.51.100.4");
    recordDnsWrite(db.db, { name: "post.example.net", type: "A", content: "198.51.100.4", act: "inserted", owner: { kind: "consumer", name: "post", stage: "prod" }, runId: "run_old" });
    recordDnsWrite(db.db, { name: "_dmarc.example.com", type: "TXT", content: "v=DMARC1; p=none", act: "inserted", owner: { kind: "mail", name: "example.com" }, runId: "run_old" });
    const logs: string[] = [];
    for (const step of makeDnsRemoveDef(ports(dns)).steps(PARAMS)) await step.run(ctx(logs, PARAMS));
    expect(dns.record("post.example.net", "A")).toBeUndefined();
    expect(dns.deletes).toEqual([{ name: "post.example.net", type: "A", content: "198.51.100.4", deleted: 1 }]); // by the content the book holds
    expect(logs[0]).toContain('belongs to the consumer "post" at prod');
    expect(logs[1]).toBe("A post.example.net stood at 198.51.100.4 and is gone (1 removed)");
    expect(listDnsWrites(db.db).map((r) => r.name)).toEqual(["_dmarc.example.com"]);
  });

  it("a TXT no book row names goes by its tag — the record published before the book existed", async () => {
    const dns = new FakeDnsProvider();
    dns.seed("_dmarc.example.com", "TXT", "somebody-else=verification", "v=DMARC1; p=none");
    const params = one("_dmarc.example.com", "TXT");
    await makeDnsRemoveDef(ports(dns, [DMARC_ROW])).steps(params)[1]!.run(ctx([], params));
    expect(dns.deletes).toEqual([{ name: "_dmarc.example.com", type: "TXT", content: "v=DMARC1; p=none", deleted: 1 }]);
    expect(await dns.listRecordContents({ name: "_dmarc.example.com", type: "TXT" })).toEqual(["somebody-else=verification"]);
  });

  it("the envelope sender's SPF goes by the SPF tag where no book row names it, and the name's other TXT stays", async () => {
    const dns = new FakeDnsProvider();
    dns.seed("mail.example.com", "TXT", "somebody-else=verification", "v=spf1 ip4:203.0.113.9 -all");
    const params = one("mail.example.com", "TXT");
    await makeDnsRemoveDef(ports(dns, [SERVICE_SPF_ROW, ENVELOPE_ROW])).steps(params)[1]!.run(ctx([], params));
    expect(dns.deletes).toEqual([{ name: "mail.example.com", type: "TXT", content: "v=spf1 ip4:203.0.113.9 -all", deleted: 1 }]);
    expect(await dns.listRecordContents({ name: "mail.example.com", type: "TXT" })).toEqual(["somebody-else=verification"]);
  });

  it("is a no-op on a record that is already absent — a resumed run deletes nothing twice", async () => {
    const dns = new FakeDnsProvider();
    const logs: string[] = [];
    await makeDnsRemoveDef(ports(dns)).steps(PARAMS)[1]!.run(ctx(logs, PARAMS));
    expect(logs).toEqual(["no A record post.example.net to remove — already absent"]);
  });

  it("refuses at attest-target when one of the records stopped being ours between the plan and the run", async () => {
    const logs: string[] = [];
    const attest = makeDnsRemoveDef(ports(new FakeDnsProvider(), [INSTALLER_ROW, DMARC_ROW, AUTH_ROW])).steps(THREE)[0]!;
    await expect(attest.run(ctx(logs, THREE))).rejects.toThrow(/1 of the 3 record\(s\) cannot be taken back, so none is: this installation owns no A record post\.example\.net/);
    expect(logs).toEqual([]);
  });

  it("a remove step refuses its own record when it stopped being ours, and touches no other", async () => {
    const dns = new FakeDnsProvider();
    dns.seed("post.example.net", "A", "198.51.100.4");
    const step = makeDnsRemoveDef(ports(dns, [INSTALLER_ROW, DMARC_ROW, AUTH_ROW])).steps(THREE)[1]!;
    await expect(step.run(ctx([], THREE))).rejects.toThrow(/this installation owns no A record post\.example\.net/);
    expect(dns.deletes).toEqual([]);
  });

  it("booked TXT X whose booked content no longer stands while Y stands: deletes nothing, forgets the book row, and logs X as no longer standing and Y as staying", async () => {
    const dns = new FakeDnsProvider();
    dns.seed("_dmarc.example.com", "TXT", "v=DMARC1; p=reject");
    recordDnsWrite(db.db, {
      name: "_dmarc.example.com",
      type: "TXT",
      content: "v=DMARC1; p=none",
      act: "inserted",
      owner: { kind: "mail", name: "example.com" },
      runId: "run_test",
    });
    const params = one("_dmarc.example.com", "TXT");
    const logs: string[] = [];
    await makeDnsRemoveDef(ports(dns, [DMARC_ROW])).steps(params)[1]!.run(ctx(logs, params));
    expect(dns.deletes).toEqual([]); // the provider is not asked to delete at all
    expect(listDnsWrites(db.db).map((r) => r.name)).toEqual([]);
    expect(await dns.listRecordContents({ name: "_dmarc.example.com", type: "TXT" })).toEqual(["v=DMARC1; p=reject"]);
    expect(logs).toEqual([
      "no TXT record _dmarc.example.com of this installation's to remove — the 1 record(s) of the name (v=DMARC1; p=reject) carry content no run here wrote and stay, and the provider was not asked to delete anything; the book forgets the write",
    ]);
  });

  it("planted innocent: booked X with standing [X, Y] deletes X, leaves Y, and forgets the book row", async () => {
    const dns = new FakeDnsProvider();
    dns.seed("_dmarc.example.com", "TXT", "v=DMARC1; p=none", "v=DMARC1; p=reject");
    recordDnsWrite(db.db, {
      name: "_dmarc.example.com",
      type: "TXT",
      content: "v=DMARC1; p=none",
      act: "inserted",
      owner: { kind: "mail", name: "example.com" },
      runId: "run_test",
    });
    const params = one("_dmarc.example.com", "TXT");
    const logs: string[] = [];
    await makeDnsRemoveDef(ports(dns, [DMARC_ROW])).steps(params)[1]!.run(ctx(logs, params));
    expect(dns.deletes).toEqual([{ name: "_dmarc.example.com", type: "TXT", content: "v=DMARC1; p=none", deleted: 1 }]);
    expect(listDnsWrites(db.db).map((r) => r.name)).toEqual([]);
    expect(await dns.listRecordContents({ name: "_dmarc.example.com", type: "TXT" })).toEqual(["v=DMARC1; p=reject"]);
    expect(logs).toEqual([
      "TXT _dmarc.example.com stood at v=DMARC1; p=none and is gone (1 removed, 1 other record(s) of the name left standing)",
    ]);
  });

  it("book-only row: a booked TXT whose name the inventory does not carry is accepted at plan, passes attest, deletes at remove, and forgets the book row", async () => {
    const dns = new FakeDnsProvider();
    dns.seed("mail.digitaplatform.com", "TXT", "v=spf1 ip4:157.90.201.186 -all");
    recordDnsWrite(db.db, {
      name: "mail.digitaplatform.com",
      type: "TXT",
      content: "v=spf1 ip4:157.90.201.186 -all",
      act: "inserted",
      owner: { kind: "mail", name: "digitaplatform.com" },
      runId: "run_test",
    });
    const params = one("mail.digitaplatform.com", "TXT");
    const def = makeDnsRemoveDef(ports(dns, []));
    const plan = await def.plan(params, deps);
    expect(plan.summary).toContain('the TXT record mail.digitaplatform.com (the mail "digitaplatform.com"): deletes v=spf1 ip4:157.90.201.186 -all');
    const steps = def.steps(params);
    const logs: string[] = [];
    await steps[0]!.run(ctx(logs, params));
    expect(logs[0]).toContain('TXT mail.digitaplatform.com belongs to the mail "digitaplatform.com" and stands at v=spf1 ip4:157.90.201.186 -all');
    await steps[1]!.run(ctx(logs, params));
    expect(dns.deletes).toEqual([{ name: "mail.digitaplatform.com", type: "TXT", content: "v=spf1 ip4:157.90.201.186 -all", deleted: 1 }]);
    expect(listDnsWrites(db.db).map((r) => r.name)).toEqual([]);
    expect(await dns.listRecordContents({ name: "mail.digitaplatform.com", type: "TXT" })).toEqual([]);
    expect(logs[1]).toContain("TXT mail.digitaplatform.com stood at v=spf1 ip4:157.90.201.186 -all and is gone (1 removed)");
  });

  it("book-only row variant: booked content no longer stands so nothing is deleted and the book row is forgotten", async () => {
    const dns = new FakeDnsProvider();
    dns.seed("mail.digitaplatform.com", "TXT", "v=spf1 include:spf.protection.outlook.com -all");
    recordDnsWrite(db.db, {
      name: "mail.digitaplatform.com",
      type: "TXT",
      content: "v=spf1 ip4:157.90.201.186 -all",
      act: "inserted",
      owner: { kind: "mail", name: "digitaplatform.com" },
      runId: "run_test",
    });
    const params = one("mail.digitaplatform.com", "TXT");
    const steps = makeDnsRemoveDef(ports(dns, [])).steps(params);
    const logs: string[] = [];
    await steps[0]!.run(ctx(logs, params));
    await steps[1]!.run(ctx(logs, params));
    expect(dns.deletes).toEqual([]);
    expect(listDnsWrites(db.db).map((r) => r.name)).toEqual([]);
    expect(logs[1]).toBe("no TXT record mail.digitaplatform.com of this installation's to remove — the 1 record(s) of the name (v=spf1 include:spf.protection.outlook.com -all) carry content no run here wrote and stay, and the provider was not asked to delete anything; the book forgets the write");
  });

  it("planted: a book row under a foreign record of its name plans NOTHING deleted and asks the provider to delete nothing — the PROD case of 2026-10-08", async () => {
    const dns = new FakeDnsProvider();
    dns.seed("digitaplatform.com", "TXT", "v=spf1 include:spf.protection.outlook.com -all");
    recordDnsWrite(db.db, {
      name: "digitaplatform.com", type: "TXT", content: "v=spf1 ip4:157.90.201.186 -all", act: "inserted",
      owner: { kind: "mail", name: "digitaplatform.com" }, runId: "run_test",
    });
    const params = one("digitaplatform.com", "TXT");
    const def = makeDnsRemoveDef(ports(dns, []));
    const plan = await def.plan(params, deps);
    expect(plan.summary).toMatch(/^Take back one record, one step each; nothing is deleted at the DNS provider: /);
    expect(plan.summary).toContain('the TXT record digitaplatform.com (the mail "digitaplatform.com"): NOTHING is deleted at the provider — what stands there (v=spf1 include:spf.protection.outlook.com -all) is content no run here wrote, and it stays; the book forgets its row');
    expect(plan.warnings).toEqual([]);
    for (const step of def.steps(params)) await step.run(ctx([], params));
    expect(dns.deletes).toEqual([]);
    expect(await dns.listRecordContents({ name: "digitaplatform.com", type: "TXT" })).toEqual(["v=spf1 include:spf.protection.outlook.com -all"]);
    expect(listDnsWrites(db.db)).toEqual([]);
  });

  it("a book-only CNAME whose name was re-pointed since is not deleted, and the book forgets the write", async () => {
    const dns = new FakeDnsProvider();
    dns.seed("shop.example.com", "CNAME", "customer.elsewhere.net");
    recordDnsWrite(db.db, {
      name: "shop.example.com",
      type: "CNAME",
      content: "apps1.digitacloud.app",
      act: "inserted",
      owner: { kind: "tenant", name: "shop", stage: "prod" },
      runId: "run_test",
    });
    const params = one("shop.example.com", "CNAME");
    const steps = makeDnsRemoveDef(ports(dns, [])).steps(params);
    const logs: string[] = [];
    await steps[0]!.run(ctx(logs, params));
    await steps[1]!.run(ctx(logs, params));
    expect(dns.deletes).toEqual([]);
    expect(await dns.listRecordContents({ name: "shop.example.com", type: "CNAME" })).toEqual(["customer.elsewhere.net"]);
    expect(listDnsWrites(db.db).map((r) => r.name)).toEqual([]);
    expect(logs[1]).toBe("no CNAME record shop.example.com of this installation's to remove — the 1 record(s) of the name (customer.elsewhere.net) carry content no run here wrote and stay, and the provider was not asked to delete anything; the book forgets the write");
  });

  it("planted innocent: a book-only CNAME that still points where this Manager wrote it is deleted", async () => {
    const dns = new FakeDnsProvider();
    dns.seed("shop.example.com", "CNAME", "apps1.digitacloud.app");
    recordDnsWrite(db.db, {
      name: "shop.example.com",
      type: "CNAME",
      content: "apps1.digitacloud.app",
      act: "inserted",
      owner: { kind: "tenant", name: "shop", stage: "prod" },
      runId: "run_test",
    });
    const params = one("shop.example.com", "CNAME");
    const steps = makeDnsRemoveDef(ports(dns, [])).steps(params);
    const logs: string[] = [];
    await steps[0]!.run(ctx(logs, params));
    await steps[1]!.run(ctx(logs, params));
    expect(await dns.listRecordContents({ name: "shop.example.com", type: "CNAME" })).toEqual([]);
    expect(listDnsWrites(db.db).map((r) => r.name)).toEqual([]);
  });

  it("planted defect kept: a name neither the inventory nor the book names is refused at the plan with the refusal sentence", async () => {
    const params = one("unheardof.example.org", "A");
    await expect(makeDnsRemoveDef(ports(new FakeDnsProvider(), [])).plan(params, deps)).rejects.toThrow(
      "1 of the 1 record(s) cannot be taken back, so none is: this installation owns no A record unheardof.example.org. " +
        "The DNS inventory names 0 record(s); a name neither the inventory nor the book of DNS writes names belongs to somebody — the installer, the customer's own mail " +
        "service, or an installation this one knows nothing about — and a read-only row is one this Manager may not take back: the sender " +
        "domain's address record is the installer's, the reverse DNS is set where the egress address is rented, and the platform domain's apex " +
        "SPF and DMARC are kept by its own mail service",
    );
  });

  it("planted defect kept: a TXT in the inventory with no book row and no mail record tag is refused by ownedTxtContent", async () => {
    const dns = new FakeDnsProvider();
    dns.seed("custom.example.net", "TXT", "random-val");
    const customTxtRow: DnsRecordRow = {
      owner: { kind: "consumer", name: "custom", stage: "prod" },
      name: "custom.example.net",
      type: "TXT",
      expected: "something",
      found: "random-val",
      verdict: "standing",
      removable: true,
    };
    const params = one("custom.example.net", "TXT");
    const step = makeDnsRemoveDef(ports(dns, [customTxtRow])).steps(params)[1]!;
    await expect(step.run(ctx([], params))).rejects.toThrow(
      "the inventory does not say which mail record TXT custom.example.net is, so nothing here can pick this installation's own among the records of the name — refusing to delete by name alone",
    );
  });

  it("an inventory row that is read-only with a book row of the same name and type stays refused", async () => {
    recordDnsWrite(db.db, {
      name: "example.com",
      type: "TXT",
      content: "v=spf1 include:spf.protection.outlook.com -all",
      act: "inserted",
      owner: { kind: "mail-service", name: "example.com" },
      runId: "run_test",
    });
    const params = one("example.com", "TXT");
    await expect(makeDnsRemoveDef(ports(new FakeDnsProvider(), [SERVICE_SPF_ROW])).plan(params, deps))
      .rejects.toThrow(/the TXT record example\.com is listed read-only: it is the mail-service "example\.com"'s/);
  });
});
