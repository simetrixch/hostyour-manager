import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDb, type DbHandle } from "../../db/client.ts";
import { apps, clusters, servers } from "../../db/schema/inventory.ts";
import { recordDnsWrite } from "../../db/dns-writes.ts";
import { clusterMapPath } from "../../../shared/cluster-values.ts";
import { FakePlatformRepo } from "../../adapters/git/testing/fake.ts";
import { FakePublicDns } from "../../adapters/dns/testing/fake-public-dns.ts";
import { dkimRecordKey, mailDnsRows, readMailDns, readMailEgress, type MailDnsNeed } from "./mail-dns.ts";

// The Mail page's check: the records of a sender domain, measured at public DNS and held against where
// mail leaves — the name it leaves by, the address that name resolves to, and the key the sender signs
// with — and for the platform domain the envelope sender's SPF, beside rows that say why no run here
// publishes the domain's own records. Pure over scripted DNS, so every verdict and every note is read
// here as the operator reads it.

const EGRESS = "203.0.113.9";
const MAIL_NAME = "mail.example.com";
const PEM = "-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0B\nAQEFAAOCAQ8A\n-----END PUBLIC KEY-----\n";
const KEY = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A";
const need = (over: Partial<MailDnsNeed> = {}): MailDnsNeed => ({
  domain: "example.com", role: "customer mail", stage: "prod", egressName: "a1.example.net", egress: EGRESS, egressHost: MAIL_NAME, dkimPublicKey: KEY, envelopeDomain: null, ownMailService: false, ...over,
});
/** The platform domain's need: its envelope sender's name, and its mail on its own mail service. */
const platformNeed = (over: Partial<MailDnsNeed> = {}): MailDnsNeed => need({ envelopeDomain: MAIL_NAME, ownMailService: true, ...over });

function published(): FakePublicDns {
  const dns = new FakePublicDns();
  dns.seedTxt("example.com", `v=spf1 a:${MAIL_NAME} include:spf.protection.outlook.com -all`, "MS=ms123");
  dns.seedPtr(EGRESS, MAIL_NAME);
  dns.seedA(MAIL_NAME, EGRESS);
  dns.seedTxt("prod._domainkey.example.com", `v=DKIM1; h=sha256; k=rsa; p=${KEY}`);
  dns.seedTxt("_dmarc.example.com", "v=DMARC1; p=none; rua=mailto:dmarc@example.com");
  return dns;
}

describe("readMailEgress", () => {
  let db: DbHandle;
  beforeEach(() => { db = openDb(":memory:"); });
  afterEach(() => { db.sqlite.close(); });

  it("gives host: mail.example.org when PTR gives mail.example.org and its A record includes the egress address", async () => {
    const dns = new FakePublicDns();
    dns.seedA("m1.example.com", EGRESS);
    dns.seedPtr(EGRESS, "mail.example.org");
    dns.seedA("mail.example.org", EGRESS);
    const egress = await readMailEgress({ db: db.db, publicDns: dns }, "prod", "m1.example.com");
    expect(egress.host).toBe("mail.example.org");
  });

  it("PLANTED INNOCENT: a PTR name whose A record is another address gives host: null", async () => {
    const dns = new FakePublicDns();
    dns.seedA("m1.example.com", EGRESS);
    dns.seedPtr(EGRESS, "mail.example.org");
    dns.seedA("mail.example.org", "198.51.100.99");
    const egress = await readMailEgress({ db: db.db, publicDns: dns }, "prod", "m1.example.com");
    expect(egress.host).toBeNull();
  });

  it("lowercases a PTR name given in capitals, which the SPF step accepts only in lowercase", async () => {
    const dns = new FakePublicDns();
    dns.seedA("m1.example.com", EGRESS);
    dns.seedPtr(EGRESS, "MAIL.Example.ORG");
    dns.seedA("mail.example.org", EGRESS);
    const egress = await readMailEgress({ db: db.db, publicDns: dns }, "prod", "m1.example.com");
    expect(egress.host).toBe("mail.example.org");
  });

  it("two PTR names give host: null", async () => {
    const dns = new FakePublicDns();
    dns.seedA("m1.example.com", EGRESS);
    dns.seedPtr(EGRESS, "mail.example.org", "mail2.example.org");
    dns.seedA("mail.example.org", EGRESS);
    dns.seedA("mail2.example.org", EGRESS);
    const egress = await readMailEgress({ db: db.db, publicDns: dns }, "prod", "m1.example.com");
    expect(egress.host).toBeNull();
  });
});

describe("dkimRecordKey", () => {
  it("is the body of the SPKI PEM — the DER a DKIM record carries in p=", () => {
    expect(dkimRecordKey(PEM)).toBe(KEY);
  });
});

describe("mailDnsRows", () => {
  it("reads every record green when the domain is published for this sender, and never asks the apex for an address", async () => {
    const dns = published();
    const rows = await mailDnsRows(need(), dns);
    expect(rows.map((r) => `${r.record}:${r.ok}`)).toEqual(["spf:true", "a:true", "dkim:true", "dmarc:true", "ptr:true"]);
    expect(rows.find((r) => r.record === "spf")?.found).toBe(`v=spf1 a:${MAIL_NAME} include:spf.protection.outlook.com -all`); // the MS= record is not SPF
    expect(rows.find((r) => r.record === "a")).toMatchObject({ name: MAIL_NAME, expected: EGRESS }); // the mail name resolves back
    expect(rows.find((r) => r.record === "ptr")).toMatchObject({ name: EGRESS, found: MAIL_NAME });
    expect(rows.find((r) => r.record === "dkim")?.name).toBe("prod._domainkey.example.com"); // the selector is the stage
    expect(rows.every((r) => r.note === undefined)).toBe(true);
    expect(dns.asked).toEqual(["TXT example.com", `PTR ${EGRESS}`, `A ${MAIL_NAME}`, "TXT prod._domainkey.example.com", "TXT _dmarc.example.com"]);
  });

  it("a red row's note is one sentence naming the act", async () => {
    const dns = published();
    dns.seedTxt("example.com", "v=spf1 ip4:198.51.100.7 -all");
    dns.seedTxt("_dmarc.example.com");
    dns.seedA(MAIL_NAME, "198.51.100.7");
    const rows = await mailDnsRows(need(), dns);
    expect(rows.find((r) => r.record === "spf")).toMatchObject({ ok: false, note: `publish; a:${MAIL_NAME} is merged into the record that stands` });
    expect(rows.find((r) => r.record === "a")).toMatchObject({ ok: false, note: `point ${MAIL_NAME} at ${EGRESS}` });
    expect(rows.find((r) => r.record === "dmarc")).toMatchObject({ ok: false, note: "publish" });
    for (const row of rows) expect(row.note ?? "x").not.toMatch(/\. /); // one sentence
    dns.seedTxt("example.com", "v=spf1 ip4:198.51.100.7 -all", `v=spf1 a:${MAIL_NAME} -all`);
    expect((await mailDnsRows(need(), dns)).find((r) => r.record === "spf")).toMatchObject({ ok: false, note: "remove 1 of the 2 v=spf1 records by hand, then publish" });
  });

  it("DKIM: the sender's key must be the one published; the relay's key is only counted", async () => {
    const dns = published();
    dns.seedTxt("prod._domainkey.example.com", "v=DKIM1; k=rsa; p=MIIBsomethingElse");
    expect((await mailDnsRows(need(), dns)).find((r) => r.record === "dkim")).toMatchObject({ ok: false, note: "publish; the record carries another key than the sender signs with" });
    expect((await mailDnsRows(need({ dkimPublicKey: null }), dns)).find((r) => r.record === "dkim")?.ok).toBe(true);
    dns.seedTxt("prod._domainkey.example.com");
    expect((await mailDnsRows(need(), dns)).find((r) => r.record === "dkim")).toMatchObject({ ok: false, found: null, note: "publish" });
    expect((await mailDnsRows(need({ dkimPublicKey: null }), dns)).find((r) => r.record === "dkim")?.note).toBe("publish; the key is published where the relay holds one");
  });

  it("no reverse DNS names the provider as the place to set it, and the mail name cannot be checked before it", async () => {
    const dns = published();
    dns.seedPtr(EGRESS);
    const rows = await mailDnsRows(need(), dns);
    expect(rows.find((r) => r.record === "ptr")).toMatchObject({ ok: false, note: `set the reverse DNS of ${EGRESS} to the mail name at the hosting provider` });
    expect(rows.find((r) => r.record === "a")).toMatchObject({ ok: false, note: "set the reverse DNS first; the name it gives must resolve back to the address" });
  });

  it("the platform domain: the envelope sender's SPF is a row of its own after the apex SPF, asked at the envelope name", async () => {
    const dns = published();
    dns.seedTxt(MAIL_NAME, "v=spf1 a -all");
    const rows = await mailDnsRows(platformNeed(), dns);
    expect(rows.map((r) => `${r.record}:${r.ok}`)).toEqual(["spf:true", "envelope-spf:true", "a:true", "dkim:true", "dmarc:true", "ptr:true"]);
    expect(rows.every((r) => r.note === undefined)).toBe(true); // a green row carries no act
    expect(rows.find((r) => r.record === "envelope-spf")).toMatchObject({ name: MAIL_NAME, expected: `one v=spf1 record naming the host ${MAIL_NAME} (a), and no address`, found: "v=spf1 a -all" });
    expect(dns.asked).toContain(`TXT ${MAIL_NAME}`);
  });

  it("a missing or doubled envelope SPF names the envelope publish as the act", async () => {
    const dns = published();
    expect((await mailDnsRows(platformNeed(), dns)).find((r) => r.record === "envelope-spf")).toMatchObject({ ok: false, found: null, note: "publish the envelope SPF" });
    dns.seedTxt(MAIL_NAME, "v=spf1 ip4:198.51.100.7 -all", "v=spf1 a -all");
    expect((await mailDnsRows(platformNeed(), dns)).find((r) => r.record === "envelope-spf")).toMatchObject({ ok: false, note: "remove 1 of the 2 v=spf1 records by hand, then publish the envelope SPF" });
  });

  it("PLANTED DEFECT: a record that names the egress address is red, even beside the host, and the publish replaces it", async () => {
    const dns = published();
    dns.seedTxt("example.com", `v=spf1 a:${MAIL_NAME} ip4:${EGRESS} -all`);
    dns.seedTxt(MAIL_NAME, `v=spf1 ip4:${EGRESS}/32 -all`);
    const rows = await mailDnsRows(platformNeed({ ownMailService: false }), dns);
    expect(rows.find((r) => r.record === "spf")).toMatchObject({ ok: false, note: `publish; it replaces ip4:${EGRESS} with a:${MAIL_NAME}` });
    expect(rows.find((r) => r.record === "envelope-spf")).toMatchObject({ ok: false, note: `publish the envelope SPF; it replaces ip4:${EGRESS} with a` });
    // PLANTED INNOCENT: an address that only starts like the egress is not it, and the host's own name may carry the explicit form.
    dns.seedTxt("example.com", `v=spf1 a:${MAIL_NAME} ip4:203.0.113.95 -all`);
    dns.seedTxt(MAIL_NAME, `v=spf1 a:${MAIL_NAME} -all`);
    const again = await mailDnsRows(platformNeed({ ownMailService: false }), dns);
    expect(again.find((r) => r.record === "spf")?.ok).toBe(true);
    expect(again.find((r) => r.record === "envelope-spf")?.ok).toBe(true);
  });

  it("PLANTED DEFECT: a record that names another host, or a host that only starts like the egress host, is red", async () => {
    const dns = published();
    dns.seedTxt("example.com", "v=spf1 a:other.example.net -all");
    dns.seedTxt(MAIL_NAME, `v=spf1 a:${MAIL_NAME}.example.net -all`);
    const rows = await mailDnsRows(platformNeed({ ownMailService: false }), dns);
    expect(rows.find((r) => r.record === "spf")).toMatchObject({ ok: false, note: `publish; a:${MAIL_NAME} is merged into the record that stands` });
    expect(rows.find((r) => r.record === "envelope-spf")).toMatchObject({ ok: false, note: "publish the envelope SPF; a is merged into the record that stands" });
  });

  it("without a forward-confirmed host every SPF row is red and asks for the reverse DNS, never for the address", async () => {
    const dns = published();
    dns.seedTxt(MAIL_NAME, "v=spf1 a -all"); // PLANTED DEFECT: the bare `a` names no host when there is none
    const rows = await mailDnsRows(platformNeed({ ownMailService: false, egressHost: null }), dns);
    for (const record of ["spf", "envelope-spf"] as const) {
      expect(rows.find((r) => r.record === record)).toMatchObject({ ok: false, expected: "one v=spf1 record naming the host the reverse DNS of a1.example.net's address gives", note: "set the reverse DNS first; the name it gives must resolve back to the address" });
    }
  });

  it("the platform domain's apex SPF is judged as its mail service's one record, whatever addresses it names", async () => {
    const dns = published();
    dns.seedTxt("example.com", "v=spf1 include:spf.protection.outlook.com -all");
    const green = (await mailDnsRows(platformNeed(), dns)).find((r) => r.record === "spf");
    expect(green).toMatchObject({ ok: true, expected: "one v=spf1 record, kept by the domain's own mail service", found: "v=spf1 include:spf.protection.outlook.com -all" });
    expect(green?.note).toBeUndefined();
    // No apex SPF at all is red as well: SPF itself asks for one record.
    dns.seedTxt("example.com", "MS=ms123");
    expect((await mailDnsRows(platformNeed(), dns)).find((r) => r.record === "spf")).toMatchObject({ ok: false, found: null, note: "example.com's own mail service keeps this record" });
  });

  it("a doubled key under the platform's selector keeps its act, a removal by hand at the provider", async () => {
    const dns = published();
    dns.seedTxt("prod._domainkey.example.com", `v=DKIM1; k=rsa; p=${KEY}`, "v=DKIM1; k=rsa; p=MIIBother");
    expect((await mailDnsRows(platformNeed(), dns)).find((r) => r.record === "dkim")).toMatchObject({ ok: false, note: "remove 1 of the 2 records under this selector by hand" });
  });

  it("PLANTED DEFECT: a red row of the platform domain points at no refused run: the service keeps its records, and the platform's key has its own publish", async () => {
    const dns = published();
    dns.seedTxt("example.com", "v=spf1 include:spf.protection.outlook.com -all", `v=spf1 ip4:${EGRESS} -all`);
    dns.seedTxt("prod._domainkey.example.com");
    dns.seedTxt("_dmarc.example.com");
    const rows = await mailDnsRows(platformNeed(), dns);
    for (const record of ["spf", "dmarc"] as const) expect(rows.find((r) => r.record === record)).toMatchObject({ ok: false, note: "example.com's own mail service keeps this record" });
    expect(rows.find((r) => r.record === "dkim")).toMatchObject({ ok: false, note: "publish the DKIM key" });
    // Where no unit sends, nothing here holds the key, and the row says so rather than point at a run that refuses.
    expect((await mailDnsRows(platformNeed({ dkimPublicKey: null }), dns)).find((r) => r.record === "dkim")).toMatchObject({ ok: false, note: "no run here publishes this key: no unit signs example.com's mail with a key of its own" });
    // The envelope sender's SPF is the platform's own, so its act stays the envelope publish.
    expect(rows.find((r) => r.record === "envelope-spf")?.note).toBe("publish the envelope SPF");
    expect(rows.find((r) => r.record === "a")?.note).toBeUndefined();
  });

  it("where the name mail leaves by resolves to no address, every address-bound row is red for that ONE reason", async () => {
    const dns = published();
    const rows = await mailDnsRows(need({ egress: null, egressHost: null }), dns);
    for (const record of ["spf", "a", "ptr"] as const) {
      expect(rows.find((r) => r.record === record)).toMatchObject({ ok: false, note: "give a1.example.net an address record first" });
    }
    expect(dns.asked.some((q) => q.startsWith("PTR"))).toBe(false);
  });
});

describe("readMailDns", () => {
  let db: DbHandle;
  beforeEach(() => { db = openDb(":memory:"); });
  afterEach(() => { db.sqlite.close(); });

  const MAP = [
    "stage: prod", "role: master", "booksCluster: m1.example.com", "", "global:",
    "  domain: m1.example.com", "  buildPlane: m1.example.com", "  unitApex: apps.example.net", "  platformDomain: example.com",
    "  clusterName: m1", "  clusterIssuer: platform-acme",
  ].join("\n") + "\n";

  function seed(): FakePlatformRepo {
    db.db.insert(servers).values({ id: "srv_m", name: "m1", host: "m1.example.com", sshUser: "m1", role: "master", status: "healthy" }).run();
    db.db.insert(clusters).values({ id: "cls_m", serverId: "srv_m", stage: "prod", domain: "m1.example.com", name: "m1", status: "active" }).run();
    const platformRepo = new FakePlatformRepo();
    platformRepo.seed(platformRepo.booksBranch, clusterMapPath("m1.example.com"), MAP);
    return platformRepo;
  }

  it("without a sender, mail leaves by the master's identity, resolved at public DNS — a CNAME identity included", async () => {
    const platformRepo = seed();
    const dns = published();
    dns.seedA("m1.example.com", EGRESS); // the resolver has followed master's CNAME to the machine's address
    const view = await readMailDns({ db: db.db, platformRepo, publicDns: dns });
    expect(view.master).toEqual({ serverId: "srv_m", name: "m1", fqdn: "m1.example.com", stage: "prod" });
    expect(view.sender).toBeNull();
    expect(view.egress).toEqual({ name: "m1.example.com", address: EGRESS });
    expect(view.domains.map((d) => `${d.domain} (${d.role})`)).toEqual(["example.com (customer mail)", "apps.example.net (alert mail)"]);
    // The platform domain's own records are its mail service's; the alert domain's are published here.
    expect(view.domains[0]!.publishRefusal).toMatch(/^example\.com is the platform domain: its mail runs on its own mail service/);
    expect(view.domains[1]!.publishRefusal).toBeNull();
    expect(view.domains[0]!.rows.find((r) => r.record === "envelope-spf")?.name).toBe("mail.example.com");
    // The platform domain's apex SPF is its mail service's, judged without the egress: one naming none is green.
    dns.seedTxt("example.com", "v=spf1 include:spf.protection.outlook.com -all");
    const again = await readMailDns({ db: db.db, platformRepo, publicDns: dns });
    expect(again.domains[0]!.rows.find((r) => r.record === "spf")?.ok).toBe(true);
    expect(view.domains[1]!.rows.some((r) => r.record === "envelope-spf")).toBe(false);
    // No sender, so no key the Manager holds: the customer domain's DKIM is the relay's, counted only.
    expect(view.domains[0]!.rows.find((r) => r.record === "dkim")?.expected).toBe("one v=DKIM1 record carrying the relay's public key");
  });

  it("with a sender, mail leaves by the cluster it stands on, and the customer domain's DKIM is the sender's key", async () => {
    const platformRepo = seed();
    db.db.insert(servers).values({ id: "srv_a", name: "a1", host: "a1.example.com", sshUser: "a1", role: "slave", status: "healthy" }).run();
    db.db.insert(clusters).values({ id: "cls_a", serverId: "srv_a", stage: "prod", domain: "a1.example.com", name: "a1", status: "active", slaveId: 1 }).run();
    db.db.insert(apps).values({ id: "app_post", clusterId: "cls_a", name: "post", stage: "prod", host: "post", dkimPublicKey: PEM }).run();
    const dns = published();
    dns.seedA("a1.example.com", EGRESS);
    dns.seedTxt(MAIL_NAME, "v=spf1 a -all"); // the envelope sender's SPF, under the platform domain
    const view = await readMailDns({ db: db.db, platformRepo, publicDns: dns, smtpSenders: async () => [{ unit: "post", cluster: "a1" }] });
    expect(view.sender).toEqual({ unit: "post", cluster: "a1.example.com" });
    expect(view.egress).toEqual({ name: "a1.example.com", address: EGRESS });
    expect(view.domains[0]!.rows.every((r) => r.ok)).toBe(true);
    expect(view.domains[1]!.rows.find((r) => r.record === "dkim")?.expected).toBe("one v=DKIM1 record carrying the relay's public key"); // alerts: the relay signs
  });

  it("a sender on a cluster this Manager does not know is refused by name; so are no master and no map", async () => {
    const platformRepo = seed();
    await expect(readMailDns({ db: db.db, platformRepo, publicDns: published(), smtpSenders: async () => [{ unit: "post", cluster: "zz" }] })).rejects.toThrow(/post stands on cluster "zz"/);
    await expect(readMailDns({ db: db.db, publicDns: published() })).rejects.toThrow(/no platform repository is configured/);
    db.sqlite.exec("DELETE FROM clusters; DELETE FROM servers");
    await expect(readMailDns({ db: db.db, platformRepo, publicDns: published() })).rejects.toThrow(/no master server is registered/);
  });

  it("surfaces former sender domains' DMARC records from the book in formerDmarc, excluding map domains", async () => {
    const platformRepo = seed();
    const dns = published();
    dns.seedA("m1.example.com", EGRESS);
    dns.seedTxt("_dmarc.former.example", "v=DMARC1; p=none; rua=mailto:old@former.example");
    recordDnsWrite(db.db, {
      name: "_dmarc.former.example",
      type: "TXT",
      content: "v=DMARC1; p=none; rua=mailto:old@former.example",
      act: "inserted",
      owner: { kind: "mail", name: "former.example" },
      runId: "run_former",
    });
    recordDnsWrite(db.db, {
      name: "_dmarc.apps.example.net",
      type: "TXT",
      content: "v=DMARC1; p=none; rua=mailto:alert@example.net",
      act: "inserted",
      owner: { kind: "mail", name: "apps.example.net" },
      runId: "run_active",
    });
    const view = await readMailDns({ db: db.db, platformRepo, publicDns: dns });
    expect(view.formerDmarc).toEqual([
      {
        domain: "former.example",
        name: "_dmarc.former.example",
        found: "v=DMARC1; p=none; rua=mailto:old@former.example",
        publishedAt: expect.any(String),
      },
    ]);
  });
});
