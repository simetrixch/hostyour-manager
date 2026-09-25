import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDb, type DbHandle } from "../../db/client.ts";
import { listDnsWrites, recordDnsWrite } from "../../db/dns-writes.ts";
import { FakeDnsProvider } from "../../adapters/dns/testing/fake.ts";
import type { StepCtx } from "../../executor/types.ts";
import type { CredentialStore } from "../../security/store.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { DnsInventoryView, DnsRecordRow } from "../../../shared/dns.ts";
import { DnsRemoveParams, makeDnsRemoveDef } from "./defs/dns-remove.ts";
import type { DnsRecordPorts } from "./defs/dns-record.kit.ts";

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

const one = (name: string, type: "A" | "TXT"): DnsRemoveParams => ({ records: [{ name, type }] });
const PARAMS = one("post.example.net", "A");
const THREE: DnsRemoveParams = { records: [{ name: "post.example.net", type: "A" }, { name: "_dmarc.example.com", type: "TXT" }, { name: "auth.example.net", type: "A" }] };
const THREE_ROWS = [CONSUMER_ROW, INSTALLER_ROW, DMARC_ROW, AUTH_ROW];
const deps = { db: {} as unknown as StepCtx["db"] };

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
    const plan = await makeDnsRemoveDef(ports(new FakeDnsProvider(), THREE_ROWS)).plan(THREE, deps);
    expect(plan.steps.map((s) => s.name)).toEqual([
      "attest-target",
      "remove-record:A post.example.net",
      "remove-record:TXT _dmarc.example.com",
      "remove-record:A auth.example.net",
    ]);
    expect(plan).toMatchObject({ targetKind: "self", targetId: "manager", requiredSecrets: [] });
    expect(plan.summary).toMatch(/^Remove 3 records at the DNS provider, one step each: /);
    expect(plan.summary).toContain('the A record post.example.net — the record of the consumer "post" at prod, standing at 198.51.100.4');
    // Only the records in use right now warn: post answers with an address its owner does not expect.
    expect(plan.warnings).toEqual([
      '_dmarc.example.com answers with exactly what the mail "example.com" needs — removing it takes a name that is in use right now out of DNS.',
      'auth.example.net answers with exactly what the consumer "auth" at prod needs — removing it takes a name that is in use right now out of DNS.',
    ]);
  });

  it("a list of one plans the two steps the single removal always had", async () => {
    const plan = await makeDnsRemoveDef(ports(new FakeDnsProvider())).plan(PARAMS, deps);
    expect(plan.steps.map((s) => s.name)).toEqual(["attest-target", "remove-record:A post.example.net"]);
    expect(plan.summary).toMatch(/^Remove one record at the DNS provider/);
    expect(plan.summary).toContain('the record of the consumer "post" at prod');
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
    expect(dns.deletes).toEqual([{ name: "post.example.net", type: "A", deleted: 1 }]);
    expect(listDnsWrites(db.db).map((r) => r.name).sort()).toEqual(["_dmarc.example.com", "auth.example.net", "mail.example.net"]);
    await steps[2]!.run(ctx(logs, THREE));
    await steps[3]!.run(ctx(logs, THREE));
    expect(dns.deletes).toEqual([
      { name: "post.example.net", type: "A", deleted: 1 },
      { name: "_dmarc.example.com", type: "TXT", content: "v=DMARC1; p=none", deleted: 1 }, // the TXT by the content the book holds
      { name: "auth.example.net", type: "A", deleted: 1 },
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
    expect(dns.deletes).toEqual([{ name: "post.example.net", type: "A", deleted: 1 }]); // by name and type, no content: the name is the unit's own
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
});
