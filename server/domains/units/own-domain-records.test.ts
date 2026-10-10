import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { openDb, type DbHandle } from "../../db/client.ts";
import { servers, clusters, tenants } from "../../db/schema/inventory.ts";
import { customerHostProblem, recordsToReplace, replacementSentence, restoreReplacedRecords, ReplacedRecord, mailRecordHashes } from "./own-domain-records.ts";
import type { StepCtx } from "../../executor/types.ts";
import { FakeDnsProvider } from "../../adapters/dns/testing/fake.ts";
import { FakePublicDns } from "../../adapters/dns/testing/fake-public-dns.ts";
import { DohPublicDns } from "../../adapters/dns/public-dns.ts";

// One host serves one tenant, and a host of a tenant never lies under or above another tenant's host,
// except where the operator confirmed that one tenant's hosts lie under the other's.

const APEX = "digitacloud.app";

describe("customerHostProblem — another tenant's host, and confirmed nesting", () => {
  let db: DbHandle;
  const tenant = (id: string, guid: string, subdomain: string, ownDomain: string): void => {
    db.db.insert(tenants).values({
      id, clusterId: "cls_1", guid, subdomain, stage: "prod", members: ["auth"], identityProvider: "auth",
      ownDomain, ownDomainRedirects: ownDomain ? [`www.${ownDomain}`] : [], suspended: false, status: "active",
    }).run();
  };
  const nest = (id: string, under: string | null, ownDomain?: string): void => {
    db.db.update(tenants).set({ nestsUnder: under, ...(ownDomain ? { ownDomain, ownDomainRedirects: [`www.${ownDomain}`] } : {}) }).where(eq(tenants.id, id)).run();
  };

  beforeEach(() => {
    db = openDb(":memory:");
    db.db.insert(servers).values({ id: "srv_1", name: "s1", host: "10.1.1.11", sshUser: "root", role: "slave", status: "healthy" }).run();
    db.db.insert(clusters).values({ id: "cls_1", serverId: "srv_1", stage: "prod", domain: "apps1.digitacloud.app", name: "apps1", status: "active" }).run();
    tenant("tnt_sim", "a1a1a1a1a1a1", "simetrix", "digitaplatform.com");
    tenant("tnt_show", "b2b2b2b2b2b2", "show", "");
    tenant("tnt_other", "c3c3c3c3c3c3", "other", "other.example");
  });

  it("refuses a host under another tenant's host without a confirmation, and says how to confirm it", () => {
    expect(customerHostProblem(db.db, "tnt_show", "show.digitaplatform.com", APEX)).toBe(
      "show.digitaplatform.com overlaps a host of tenant simetrix (digitaplatform.com) — where both tenants are one owner's, confirm in Set own domain that this tenant's domain lies under tenant simetrix",
    );
  });

  it("lets a host lie under the host of the tenant it nests under: confirmed in the plan, then recorded on the row", () => {
    expect(customerHostProblem(db.db, "tnt_show", "show.digitaplatform.com", APEX, "tnt_sim")).toBeNull();
    nest("tnt_show", "tnt_sim");
    expect(customerHostProblem(db.db, "tnt_show", "cycleshop.show.digitaplatform.com", APEX)).toBeNull();
  });

  it("lets the tenant nested under keep its own hosts above the nested tenant's", () => {
    nest("tnt_show", "tnt_sim", "show.digitaplatform.com");
    expect(customerHostProblem(db.db, "tnt_sim", "digitaplatform.com", APEX)).toBeNull();
    expect(customerHostProblem(db.db, "tnt_sim", "www.digitaplatform.com", APEX)).toBeNull();
  });

  it("refuses the autodiscover name of a mail domain as a host: it is a mail record, never a web host", () => {
    expect(customerHostProblem(db.db, "tnt_other", "autodiscover.customer.example", APEX)).toBe(
      "autodiscover.customer.example is the autodiscover name of customer.example's mail, a mail record — no own domain takes it",
    );
    expect(customerHostProblem(db.db, "tnt_other", "discover.customer.example", APEX)).toBeNull();
  });

  it("PLANTED DEFECT: refuses the exact same host even when confirmed, a host under a third tenant, and a host above a tenant that nests under nobody", () => {
    expect(customerHostProblem(db.db, "tnt_show", "digitaplatform.com", APEX, "tnt_sim")).toBe("digitaplatform.com is already a host of tenant simetrix (digitaplatform.com)");
    expect(customerHostProblem(db.db, "tnt_show", "shop.other.example", APEX, "tnt_sim")).toMatch(/overlaps a host of tenant other \(other.example\)/);
    nest("tnt_show", null, "x.other.example");
    expect(customerHostProblem(db.db, "tnt_other", "other.example", APEX)).toBe("other.example overlaps a host of tenant show (x.other.example)");
    expect(customerHostProblem(db.db, "tnt_show", "show.digitaplatform.com", APEX, null)).toMatch(/overlaps a host of tenant simetrix/);
  });
});

// A name with no MX or TXT of its own still answers them through a CNAME: Cloudflare flattens an apex
// CNAME and answers the target's MX and TXT, and a CNAME below the apex hands every type to its
// target. Replacing that CNAME withdraws those answers, so mail to the name finds no MX.
describe("recordsToReplace — the mail answers a replaced CNAME carries", () => {
  const GUID = "a1a1a1a1a1a1";
  const ZONE = "simetrix.digitacloud.app";
  let db: DbHandle;
  let dns: FakeDnsProvider;
  let publicDns: FakePublicDns;

  beforeEach(() => {
    db = openDb(":memory:");
    dns = new FakeDnsProvider();
    publicDns = new FakePublicDns();
  });

  it("PLANTED DEFECT: refuses a CNAME whose name answers MX and TXT only through it, and names each answer to add first", async () => {
    dns.seed("easy.example", "CNAME", "mail.example");
    publicDns.seedMx("easy.example", "0 mail-example.mail.protection.outlook.com");
    publicDns.seedTxt("easy.example", "MS=ms123", "v=spf1 include:spf.protection.outlook.com -all");
    await expect(recordsToReplace(db.db, { dns, publicDns }, GUID, ZONE, ["easy.example"])).rejects.toThrow(
      "easy.example answers MX 0 mail-example.mail.protection.outlook.com and TXT MS=ms123, v=spf1 include:spf.protection.outlook.com -all only through its CNAME onto mail.example, which this run replaces — add them as records of easy.example first, then plan again",
    );
  });

  it("refuses for the one type the name answers only through the CNAME, beside a type it holds itself", async () => {
    dns.seed("half.example", "CNAME", "mail.example");
    dns.seed("half.example", "MX", "10 mx.half.example");
    publicDns.seedMx("half.example", "10 mx.half.example");
    publicDns.seedTxt("half.example", "v=spf1 -all");
    await expect(recordsToReplace(db.db, { dns, publicDns }, GUID, ZONE, ["half.example"])).rejects.toThrow(/half.example answers TXT v=spf1 -all only through its CNAME/);
  });

  it("PLANTED INNOCENT: a CNAME beside the name's own MX and TXT is replaced as today", async () => {
    dns.seed("own.example", "CNAME", "elsewhere.example");
    dns.seed("own.example", "MX", "0 own-example.mail.protection.outlook.com");
    dns.seed("own.example", "TXT", "v=spf1 include:spf.protection.outlook.com -all");
    publicDns.seedMx("own.example", "0 own-example.mail.protection.outlook.com");
    publicDns.seedTxt("own.example", "v=spf1 include:spf.protection.outlook.com -all");
    expect(await recordsToReplace(db.db, { dns, publicDns }, GUID, ZONE, ["own.example"])).toEqual([{ name: "own.example", type: "CNAME", content: "elsewhere.example", proxied: false, ttl: 1 }]);
  });

  it("PLANTED INNOCENT: a CNAME whose name answers no MX or TXT, a www CNAME, and an address record are replaced as today", async () => {
    dns.seed("quiet.example", "CNAME", "site.hoster.test");
    dns.seed("www.easy.example", "CNAME", "mail.example");
    publicDns.seedMx("www.easy.example", "0 mail-example.mail.protection.outlook.com");
    dns.seed("addr.example", "A", "192.0.2.7");
    expect(await recordsToReplace(db.db, { dns, publicDns }, GUID, ZONE, ["quiet.example", "www.easy.example", "addr.example"])).toEqual([
      { name: "quiet.example", type: "CNAME", content: "site.hoster.test", proxied: false, ttl: 1 },
      { name: "www.easy.example", type: "CNAME", content: "mail.example", proxied: false, ttl: 1 },
      { name: "addr.example", type: "A", content: "192.0.2.7", proxied: false, ttl: 1 },
    ]);
  });

  it("through the real reader: a SERVFAIL from the first service asks the second, and SERVFAIL from both fails the plan", async () => {
    dns.seed("easy.example", "CNAME", "mail.example");
    const services = [{ name: "first", url: "https://first.invalid/dns-query" }, { name: "second", url: "https://second.invalid/resolve" }];
    const answering = (second: unknown): typeof fetch => (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const body = url.hostname === "first.invalid" ? { Status: 2 } : url.searchParams.get("type") === "15" ? second : { Status: 0 };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
    const reader = (second: unknown) => new DohPublicDns({ resolvers: services, fetchImpl: answering(second) });
    await expect(recordsToReplace(db.db, { dns, publicDns: reader({ Status: 0, Answer: [{ name: "easy.example", type: 15, data: "0 mx.mail.example." }] }) }, GUID, ZONE, ["easy.example"]))
      .rejects.toThrow(/easy.example answers MX 0 mx.mail.example only through its CNAME onto mail.example/);
    await expect(recordsToReplace(db.db, { dns, publicDns: reader({ Status: 2 }) }, GUID, ZONE, ["easy.example"]))
      .rejects.toThrow(/no public resolver could answer for easy.example: first: SERVFAIL; second: SERVFAIL/);
  });

  it("refuses to replace a CNAME where no public DNS reader is wired, because its mail answers cannot be read", async () => {
    dns.seed("easy.example", "CNAME", "mail.example");
    await expect(recordsToReplace(db.db, { dns }, GUID, ZONE, ["easy.example"])).rejects.toThrow(/no public DNS reader is wired on this manager/);
  });
});

describe("a replaced record is written back as it stood", () => {
  const GUID = "a1a1a1a1a1a1";
  const ZONE = "simetrix.digitacloud.app";
  let db: DbHandle;
  let dns: FakeDnsProvider;
  const logs: string[] = [];
  const ctx = () => ({ signal: new AbortController().signal, log: (_s: string, line: string) => logs.push(line) }) as unknown as StepCtx;

  beforeEach(() => {
    db = openDb(":memory:");
    dns = new FakeDnsProvider();
    logs.length = 0;
  });

  it("PLANTED DEFECT: freezes a proxied A record's flag and TTL, and an abort writes it back proxied with that TTL", async () => {
    dns.seedStanding("shop.example", "A", { content: "203.0.113.7", proxied: true, ttl: 300 });
    const replacing = await recordsToReplace(db.db, { dns }, GUID, ZONE, ["shop.example"]);
    expect(replacing).toEqual([{ name: "shop.example", type: "A", content: "203.0.113.7", proxied: true, ttl: 300 }]);
    await dns.deleteRecord({ name: "shop.example", type: "A", content: "203.0.113.7" });
    await restoreReplacedRecords(ctx(), { dns }, replacing);
    expect(dns.creates).toEqual([{ name: "shop.example", type: "A", content: "203.0.113.7", proxied: true, ttl: 300 }]);
    expect(await dns.listStandingRecords({ name: "shop.example", type: "A" })).toEqual([{ content: "203.0.113.7", proxied: true, ttl: 300 }]);
  });

  it("writes a hand-made DNS-only CNAME with the automatic TTL back as it stood", async () => {
    // A name that answers no MX or TXT through its CNAME, so the CNAME may be replaced.
    const publicDns = new FakePublicDns();
    dns.seedStanding("old.example", "CNAME", { content: "elsewhere.example", proxied: false, ttl: 1 });
    const replacing = await recordsToReplace(db.db, { dns, publicDns }, GUID, ZONE, ["old.example"]);
    expect(replacing).toEqual([{ name: "old.example", type: "CNAME", content: "elsewhere.example", proxied: false, ttl: 1 }]);
    await dns.deleteRecord({ name: "old.example", type: "CNAME" });
    await restoreReplacedRecords(ctx(), { dns }, replacing);
    expect(dns.creates).toEqual([{ name: "old.example", type: "CNAME", content: "elsewhere.example", proxied: false, ttl: 1 }]);
  });

  it("PLANTED DEFECT: freezes a proxied CNAME, a www host onto a hoster, and an abort writes it back proxied", async () => {
    const publicDns = new FakePublicDns();
    dns.seedStanding("www.shop.example", "CNAME", { content: "shop.hoster.test", proxied: true, ttl: 1 });
    const replacing = await recordsToReplace(db.db, { dns, publicDns }, GUID, ZONE, ["www.shop.example"]);
    expect(replacing).toEqual([{ name: "www.shop.example", type: "CNAME", content: "shop.hoster.test", proxied: true, ttl: 1 }]);
    await dns.deleteRecord({ name: "www.shop.example", type: "CNAME" });
    await restoreReplacedRecords(ctx(), { dns }, replacing);
    expect(dns.creates).toEqual([{ name: "www.shop.example", type: "CNAME", content: "shop.hoster.test", proxied: true, ttl: 1 }]);
  });

  it("reads a replaced record frozen before this change as DNS-only with the automatic TTL", () => {
    expect(ReplacedRecord.parse({ name: "shop.example", type: "A", content: "203.0.113.7" })).toEqual({ name: "shop.example", type: "A", content: "203.0.113.7", proxied: false, ttl: 1 });
  });

  it("names a proxied record so in the plan sentence", () => {
    expect(replacementSentence([{ name: "shop.example", type: "A", content: "203.0.113.7", proxied: true, ttl: 300 }])).toContain("A shop.example → 203.0.113.7 (behind the provider's proxy)");
    expect(replacementSentence([{ name: "old.example", type: "CNAME", content: "elsewhere.example", proxied: false, ttl: 1 }])).not.toContain("proxy");
  });

  it("PLANTED INNOCENT: the record a run writes for the tenant stays DNS-only with the automatic TTL", async () => {
    await dns.upsertRecord({ name: "www.shop.example", type: "CNAME", content: ZONE });
    await dns.createRecord({ name: "api.shop.example", type: "CNAME", content: ZONE });
    expect(await dns.listStandingRecords({ name: "api.shop.example", type: "CNAME" })).toEqual([{ content: ZONE, proxied: false, ttl: 1 }]);
  });
});

describe("mailRecordHashes", () => {
  it("hosts produce exactly the four records of one domain, each once", async () => {
    const dns = new FakeDnsProvider();
    const hashes = await mailRecordHashes({ dns }, ["example.com", "WWW.Example.com.", "www.example.com"]);
    expect(hashes.map((h) => `${h.type} ${h.name}`)).toEqual([
      "MX example.com",
      "TXT example.com",
      "TXT _dmarc.example.com",
      "CNAME autodiscover.example.com",
    ]);
  });
});
