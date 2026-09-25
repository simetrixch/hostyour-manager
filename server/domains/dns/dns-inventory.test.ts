import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDb, type DbHandle } from "../../db/client.ts";
import { clusters, servers } from "../../db/schema/inventory.ts";
import { FakeDnsProvider } from "../../adapters/dns/testing/fake.ts";
import type { MailDnsView } from "../../../shared/mail.ts";
import { readDnsInventory, type DnsInventoryDeps } from "./dns-inventory.ts";

// The DNS inventory over scripted registrations and a scripted provider: what the page lists, whose
// each record is, whether this Manager may take it back, and the three verdicts an operator reads a
// tear-down by. The reading is the FakeDnsProvider's, so "standing", "absent" and "other content"
// are asserted here exactly as the operator sees them.

const M1 = "m1.example.com";
const S1 = "s1.example.com";
const M1_ADDRESS = "203.0.113.9";

/** The five rows the Mail page measures for one sender domain, as that page composes them. */
const mailView = (): MailDnsView => ({
  master: { serverId: "srv_m", name: "m1", fqdn: M1, stage: "prod" },
  sender: null,
  egress: { name: M1, address: M1_ADDRESS },
  domains: [
    {
      domain: "example.com",
      role: "customer mail",
      rows: [
        { record: "spf", name: "example.com", expected: `one v=spf1 record naming ip4:${M1_ADDRESS}`, found: `v=spf1 ip4:${M1_ADDRESS} -all`, ok: true },
        { record: "a", name: "example.com", expected: M1_ADDRESS, found: M1_ADDRESS, ok: true },
        { record: "dkim", name: "prod._domainkey.example.com", expected: "one v=DKIM1 record carrying the relay's public key", found: "v=DKIM1; p=MIIB", ok: true },
        { record: "dmarc", name: "_dmarc.example.com", expected: "one v=DMARC1 record with a policy and a report mailbox", found: null, ok: false, note: "publish" },
        { record: "ptr", name: M1_ADDRESS, expected: "example.com", found: "example.com", ok: true },
      ],
    },
  ],
  measuredAt: new Date().toISOString(),
});

describe("readDnsInventory", () => {
  let db: DbHandle;
  let dns: FakeDnsProvider;

  beforeEach(() => {
    db = openDb(":memory:");
    db.db.insert(servers).values({ id: "srv_m", name: "m1", host: M1, sshUser: "m1", role: "master", status: "healthy" }).run();
    db.db.insert(servers).values({ id: "srv_s", name: "s1", host: S1, sshUser: "s1", role: "slave", status: "healthy" }).run();
    db.db.insert(clusters).values({ id: "cls_m", serverId: "srv_m", stage: "prod", domain: M1, name: (M1).split(".")[0]!, status: "active" }).run();
    db.db.insert(clusters).values({ id: "cls_s", serverId: "srv_s", stage: "prod", domain: S1, name: (S1).split(".")[0]!, status: "active", slaveId: 1 }).run();
    dns = new FakeDnsProvider();
  });
  afterEach(() => db.sqlite.close());

  /** One consumer and one tenant per cluster, at prod alone — the shape a small installation has. */
  const deps = (over: Partial<DnsInventoryDeps> = {}): DnsInventoryDeps => ({
    db: db.db,
    dns,
    consumers: async (cluster, stage) => (stage === "prod" && cluster === M1.split(".")[0] ? [{ name: "post", host: "post" }] : []),
    tenants: async (stage) => (stage === "prod" ? [{ subdomain: "acme", routing: "host", ownDomain: "", ownDomainRedirects: [], cluster: "m1" }, { subdomain: "beta", routing: "host", ownDomain: "", ownDomainRedirects: [], cluster: "s1" }] : []),
    unitApex: async () => "example.net",
    mail: async () => mailView(),
    ...over,
  });

  it("derives one record per unit per stage and reads each at the provider, with the cluster's own name as what its CNAME must carry", async () => {
    dns.seed("post.example.net", "CNAME", M1); // the consumer's host, pointing at its cluster
    dns.seed("*.beta.example.net", "CNAME", M1); // the slave's tenant, still pointing at the master
    const view = await readDnsInventory(deps());
    expect(view.skipped).toEqual([]);
    expect(view.rows.filter((r) => r.owner.kind === "consumer" || r.owner.kind === "tenant").map((r) => `${r.name} ${r.verdict}`)).toEqual([
      "post.example.net standing",
      "*.acme.example.net absent", // never provisioned, or already taken back
      "*.beta.example.net other", // the slave's own name is what this one must carry
    ]);
    const consumer = view.rows.find((r) => r.name === "post.example.net")!;
    expect(consumer).toMatchObject({ owner: { kind: "consumer", name: "post", stage: "prod" }, type: "CNAME", expected: M1, removable: true });
    expect(view.rows.find((r) => r.name === "*.beta.example.net")).toMatchObject({ owner: { kind: "tenant", name: "beta", stage: "prod" }, expected: S1, found: M1 });
  });

  it("names a path-routed tenant's record by its zone, which the wildcard does not cover", async () => {
    dns.seed("gamma.example.net", "CNAME", M1);
    const view = await readDnsInventory(deps({ tenants: async (stage) => (stage === "prod" ? [{ subdomain: "gamma", routing: "path", ownDomain: "", ownDomainRedirects: [], cluster: "m1" }] : []) }));
    expect(view.rows.filter((r) => r.owner.kind === "tenant").map((r) => `${r.name} ${r.verdict}`)).toEqual(["gamma.example.net standing"]);
  });

  it("lists an own domain's and its redirect hosts' records, each expected on the tenant's zone", async () => {
    dns.seed("gamma.example.net", "CNAME", M1);
    dns.seed("www.gamma.test", "CNAME", "gamma.example.net");
    const view = await readDnsInventory(deps({ tenants: async (stage) => (stage === "prod" ? [{ subdomain: "gamma", routing: "path", ownDomain: "www.gamma.test", ownDomainRedirects: ["gamma.test"], cluster: "m1" }] : []) }));
    expect(view.rows.filter((r) => r.owner.kind === "tenant").map((r) => `${r.name} ${r.expected} ${r.verdict}`)).toEqual([
      `gamma.example.net ${M1} standing`,
      "www.gamma.test gamma.example.net standing",
      "gamma.test gamma.example.net absent",
    ]);
  });

  it("shows an address record standing where a unit's CNAME belongs as what it is — never as an absence", async () => {
    dns.seed("*.acme.example.net", "A", "157.90.201.150"); // what a gone installation left under the tenant's wildcard
    const view = await readDnsInventory(deps());
    expect(view.rows.find((r) => r.name === "*.acme.example.net")).toMatchObject({
      owner: { kind: "tenant", name: "acme", stage: "prod" }, type: "A", expected: M1, found: "157.90.201.150", verdict: "other", removable: true,
    });
  });

  it("carries the mail rows verbatim and lets this Manager take back only the three it publishes", async () => {
    const view = await readDnsInventory(deps());
    expect(view.rows.filter((r) => r.owner.kind === "mail" || r.owner.kind === "installer").map((r) => `${r.owner.kind} ${r.type} ${r.name} ${r.removable}`)).toEqual([
      "mail TXT example.com true",
      "installer A example.com false", // the address record answers for the machine, not for the mail
      "mail TXT prod._domainkey.example.com true",
      "mail TXT _dmarc.example.com true",
      `installer PTR ${M1_ADDRESS} false`, // set where the address is rented, not in this zone
    ]);
    expect(view.rows.find((r) => r.name === "_dmarc.example.com")).toMatchObject({ verdict: "absent", found: null });
    expect(view.rows.find((r) => r.name === "example.com" && r.type === "TXT")?.verdict).toBe("standing");
  });

  it("names what it could not list instead of answering with a zone that looks empty", async () => {
    const { dns: _provider, ...withoutProvider } = deps();
    const noProvider = await readDnsInventory(withoutProvider);
    expect(noProvider.skipped.join(" ")).toMatch(/consumer and tenant records are not listed/);
    expect(noProvider.rows.every((r) => r.owner.kind === "mail" || r.owner.kind === "installer")).toBe(true); // the mail rows are measured elsewhere and still stand

    const broken = await readDnsInventory(deps({
      tenants: async (stage) => { throw new Error(`registrations/${stage} is not readable`); },
      mail: async () => { throw new Error("no master server is registered"); },
    }));
    expect(broken.skipped.filter((s) => s.includes("is not readable"))).toHaveLength(3); // one sentence per stage
    expect(broken.skipped.some((s) => s.includes("the mail records are not listed: no master server is registered"))).toBe(true);
    expect(broken.rows.map((r) => r.name)).toEqual(["post.example.net"]); // the consumer scan still answered
  });
});
