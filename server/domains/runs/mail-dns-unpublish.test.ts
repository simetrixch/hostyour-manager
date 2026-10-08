import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDb, type DbHandle } from "../../db/client.ts";
import { listDnsWrites, recordDnsWrite } from "../../db/dns-writes.ts";
import { FakeDnsProvider } from "../../adapters/dns/testing/fake.ts";
import type { StepCtx } from "../../executor/types.ts";
import type { CredentialStore } from "../../security/store.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { DnsInventoryView, DnsRecordRow } from "../../../shared/dns.ts";
import { makeMailDnsUnpublishDef, type MailDnsUnpublishParams } from "./defs/mail-dns-unpublish.ts";
import type { DnsRecordPorts } from "#unit/server/dns/dns-record.kit.ts";

// mail-dns-unpublish is the inverse of mail-dns-publish: the SPF, the DKIM key and the DMARC policy
// of ONE sender domain go in one act, and the two records this platform does not own stay — the
// domain's address record, which answers for the machine, and the reverse DNS, which is set where
// the egress address is rented. Both facts are asserted against the FakeDnsProvider's own store,
// and the book of DNS writes loses exactly the three rows, read back from a real database. Every
// TXT goes BY CONTENT: another service's TXT beside the SPF at the apex stays, a record published
// before the book existed goes by its tag, and a record a hand changed since is left with its row.

let db: DbHandle;
beforeEach(() => { db = openDb(":memory:"); });
afterEach(() => { db.sqlite.close(); });

const EGRESS = "203.0.113.9";
const SPF = `v=spf1 ip4:${EGRESS} -all`;
/** A mailbox provider's verification record at the apex — what a deletion by name alone would take. */
const NEIGHBOUR = "MS=ms12345678";

/** The mail half of the inventory for one sender domain, as dns-inventory.ts composes it from the
 *  rows the Mail page measures. */
const MAIL_ROWS: DnsRecordRow[] = [
  { owner: { kind: "mail", name: "example.com" }, name: "example.com", type: "TXT", record: "spf", expected: `one v=spf1 record naming ip4:${EGRESS}`, found: SPF, verdict: "standing", removable: true },
  { owner: { kind: "installer", name: "example.com" }, name: "example.com", type: "A", record: "a", expected: EGRESS, found: EGRESS, verdict: "standing", removable: false },
  { owner: { kind: "mail", name: "example.com" }, name: "prod._domainkey.example.com", type: "TXT", record: "dkim", expected: "one v=DKIM1 record", found: "v=DKIM1; p=MIIB", verdict: "standing", removable: true },
  { owner: { kind: "mail", name: "example.com" }, name: "_dmarc.example.com", type: "TXT", record: "dmarc", expected: "one v=DMARC1 record", found: "v=DMARC1; p=none", verdict: "standing", removable: true },
  { owner: { kind: "installer", name: "example.com" }, name: EGRESS, type: "PTR", record: "ptr", expected: "example.com", found: "example.com", verdict: "standing", removable: false },
];

const ports = (dns?: FakeDnsProvider, rows: DnsRecordRow[] = MAIL_ROWS): DnsRecordPorts => ({
  ...(dns ? { dns } : {}),
  readDnsInventory: async (): Promise<DnsInventoryView> => ({ rows, skipped: [], readAt: new Date().toISOString() }),
});

function ctx(logs: string[], params: MailDnsUnpublishParams): StepCtx {
  return {
    runId: "run_mail_unpublish", stepName: "remove-records", db: db.db, creds: {} as unknown as CredentialStore, params: { ...params },
    secrets: { get: () => undefined, wipe: () => undefined }, signal: new AbortController().signal, logger: {} as unknown as Logger,
    ssh: () => Promise.reject(new Error("no ssh")), openPasswordSession: () => Promise.reject(new Error("no ssh")),
    closePasswordSession: () => undefined, attest: () => Promise.reject(new Error("no attest")),
    log: (_s, t) => logs.push(t), checkpoint: () => undefined, readCheckpoint: () => undefined, registerCleanup: () => undefined,
  };
}

const PARAMS: MailDnsUnpublishParams = { domain: "example.com" };

function published(): FakeDnsProvider {
  const dns = new FakeDnsProvider();
  dns.seed("example.com", "TXT", NEIGHBOUR, SPF);
  dns.seed("example.com", "A", EGRESS);
  dns.seed("prod._domainkey.example.com", "TXT", "v=DKIM1; p=MIIB");
  dns.seed("_dmarc.example.com", "TXT", "v=DMARC1; p=none");
  return dns;
}

/** The three as an earlier publish booked them. */
function booked(): void {
  for (const row of MAIL_ROWS.filter((r) => r.removable)) {
    recordDnsWrite(db.db, { name: row.name, type: "TXT", content: row.found!, act: "inserted", owner: { kind: "mail", name: "example.com" }, runId: "run_publish" });
  }
}

describe("mail-dns-unpublish plan", () => {
  it("names the three records it deletes and warns what the domain loses the moment they are gone", async () => {
    const plan = await makeMailDnsUnpublishDef(ports(published())).plan(PARAMS, { db: db.db });
    expect(plan.steps.map((s) => s.name)).toEqual(["attest-target", "remove-records"]);
    expect(plan).toMatchObject({ targetKind: "self", targetId: "manager", requiredSecrets: [] });
    // Each record with what its removal deletes, by the rule the step carries out.
    expect(plan.summary).toContain(`the TXT record example.com (the mail "example.com"): deletes ${SPF}, and ${NEIGHBOUR} stays`);
    expect(plan.summary).toContain('the TXT record prod._domainkey.example.com (the mail "example.com"): deletes v=DKIM1; p=MIIB');
    expect(plan.summary).toContain('the TXT record _dmarc.example.com (the mail "example.com"): deletes v=DMARC1; p=none');
    expect(plan.summary).toContain("The domain's own address record stays");
    expect(plan.warnings.join(" ")).toMatch(/fails the checks receivers make the moment these records are gone/);
  });

  it("refuses a domain this installation does not send as, and names the ones it does", async () => {
    await expect(makeMailDnsUnpublishDef(ports(published())).plan({ domain: "foreign.example" }, { db: {} as unknown as StepCtx["db"] }))
      .rejects.toThrow(/this installation publishes no mail records for foreign\.example — it sends as example\.com/);
  });
});

/** The platform domain as the inventory lists it: its apex SPF and DMARC are its own mail service's,
 *  the key under the platform's selector and the envelope sender's SPF are the platform's. */
const PLATFORM_ROWS: DnsRecordRow[] = MAIL_ROWS.map((r): DnsRecordRow => (r.record === "spf" || r.record === "dmarc" ? { ...r, owner: { kind: "mail-service", name: "example.com" }, removable: false } : r)).concat([
  { owner: { kind: "mail", name: "example.com" }, name: "mail.example.com", type: "TXT", record: "envelope-spf", expected: `one v=spf1 record naming ip4:${EGRESS}`, found: SPF, verdict: "standing", removable: true },
]);

describe("mail-dns-unpublish of the platform domain", () => {
  it("PLANTED DEFECT: refuses the platform domain at the plan, rather than taking its key and its envelope SPF out alone", async () => {
    await expect(makeMailDnsUnpublishDef(ports(new FakeDnsProvider(), PLATFORM_ROWS)).plan(PARAMS, { db: db.db }))
      .rejects.toThrow(/example\.com is the platform domain: its mail runs on its own mail service/);
  });

  it("refuses at the run as well and deletes nothing, where the plan saw the domain as a plain sender domain", async () => {
    const dns = published();
    await expect(makeMailDnsUnpublishDef(ports(dns, PLATFORM_ROWS)).steps(PARAMS)[1]!.run(ctx([], PARAMS))).rejects.toThrow(/is the platform domain/);
    expect(dns.deletes).toEqual([]);
  });
});

describe("mail-dns-unpublish steps", () => {
  it("deletes the SPF, the DKIM key and the DMARC policy by the content the book holds, forgets the three, and leaves the address record and the neighbour TXT standing", async () => {
    const dns = published();
    booked();
    recordDnsWrite(db.db, { name: "post.example.net", type: "A", content: EGRESS, act: "inserted", owner: { kind: "consumer", name: "post", stage: "prod" }, runId: "run_onboard" });
    const logs: string[] = [];
    for (const step of makeMailDnsUnpublishDef(ports(dns)).steps(PARAMS)) await step.run(ctx(logs, PARAMS));
    expect(listDnsWrites(db.db).map((r) => `${r.type} ${r.name}`)).toEqual(["A post.example.net"]);
    expect(dns.deletes).toEqual([
      { name: "example.com", type: "TXT", content: SPF, deleted: 1 },
      { name: "prod._domainkey.example.com", type: "TXT", content: "v=DKIM1; p=MIIB", deleted: 1 },
      { name: "_dmarc.example.com", type: "TXT", content: "v=DMARC1; p=none", deleted: 1 },
    ]);
    expect(await dns.listRecordContents({ name: "example.com", type: "TXT" })).toEqual([NEIGHBOUR]); // another service's, and never this run's to take
    expect(dns.record("prod._domainkey.example.com", "TXT")).toBeUndefined();
    expect(dns.record("_dmarc.example.com", "TXT")).toBeUndefined();
    expect(dns.record("example.com", "A")).toBe(EGRESS); // the installer's, and never this run's to take
    expect(logs.some((l) => l.includes(`TXT example.com stood at ${SPF} and is gone (1 removed, 1 other record(s) of the name left standing)`))).toBe(true);
    expect(logs.at(-1)).toContain("announces no SPF, no DKIM key and no DMARC policy any more");
  });

  it("a record published before the book existed goes by its tag — the SPF among the TXT of the apex, never the neighbour", async () => {
    const dns = published();
    const logs: string[] = [];
    await makeMailDnsUnpublishDef(ports(dns)).steps(PARAMS)[1]!.run(ctx(logs, PARAMS));
    expect(dns.deletes.map((d) => d.content)).toEqual([SPF, "v=DKIM1; p=MIIB", "v=DMARC1; p=none"]);
    expect(await dns.listRecordContents({ name: "example.com", type: "TXT" })).toEqual([NEIGHBOUR]);
  });

  it("a record a hand changed since the publish is left standing, but the book row is forgotten as requested", async () => {
    const dns = published();
    booked();
    dns.seed("_dmarc.example.com", "TXT", "v=DMARC1; p=reject; rua=mailto:somebody@example.org");
    const logs: string[] = [];
    await makeMailDnsUnpublishDef(ports(dns)).steps(PARAMS)[1]!.run(ctx(logs, PARAMS));
    expect(dns.record("_dmarc.example.com", "TXT")).toBe("v=DMARC1; p=reject; rua=mailto:somebody@example.org");
    expect(listDnsWrites(db.db).map((r) => r.name)).toEqual([]);
    expect(dns.deletes.filter((d) => d.name === "_dmarc.example.com")).toEqual([]);
    expect(logs).toContain("no TXT record _dmarc.example.com of this installation's to remove — the 1 record(s) of the name (v=DMARC1; p=reject; rua=mailto:somebody@example.org) carry content no run here wrote and stay, and the provider was not asked to delete anything; the book forgets the write");
  });

  it("with nothing of ours under a name and no book row, nothing is deleted and the neighbour is named", async () => {
    const dns = new FakeDnsProvider();
    dns.seed("example.com", "TXT", NEIGHBOUR);
    const logs: string[] = [];
    await makeMailDnsUnpublishDef(ports(dns)).steps(PARAMS)[1]!.run(ctx(logs, PARAMS));
    expect(dns.deletes).toEqual([]);
    expect(logs[0]).toBe(`no TXT record example.com of this installation's to remove — the 1 record(s) of the name (${NEIGHBOUR}) carry content no run here wrote and stay, and the provider was not asked to delete anything`);
    expect(logs[1]).toBe("no TXT record prod._domainkey.example.com to remove — already absent");
  });

  it("refuses at attest-target when the domain stopped being a sender domain between the plan and the run", async () => {
    const attest = makeMailDnsUnpublishDef(ports(published(), [])).steps(PARAMS)[0]!;
    await expect(attest.run(ctx([], PARAMS))).rejects.toThrow(/no domain the DNS inventory could read/);
  });
});
