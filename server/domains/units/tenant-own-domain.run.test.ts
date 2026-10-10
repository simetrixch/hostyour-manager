import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { getRun, readEvents } from "../../executor/read.ts";
import { tenants } from "../../db/schema/inventory.ts";
import { findDnsWrite, recordDnsWrite } from "../../db/dns-writes.ts";
import { useOwnDomainHarness, BARE, CLUSTER, GUID, OK, OTHER, OWN, ZONE, healthAt } from "./tenant-own-domain.fixture.ts";

// tenant-set-own-domain driven through the real Executor: the order the run exists for (the new
// domain's record, the recorded domain, a 2xx at the new host, only then the previous domain's record
// gone), the abort, the refused abort, the skip and the plan's refusals.

describe("tenant-set-own-domain through the Executor", () => {
  const { make, plan, move } = useOwnDomainHarness();

  it("sets an own domain: its record onto the zone first, then the domain, then a 2xx at the new host", async () => {
    const h = await make({ answers: [OWN] });
    const runId = await move(h, OWN, "");
    expect(getRun(h.db.db, runId)?.status).toBe("succeeded");
    expect(h.dns.record(OWN, "CNAME")).toBe(ZONE);
    expect(findDnsWrite(h.db.db, { name: OWN, type: "CNAME" })?.owner).toEqual({ kind: "tenant", name: GUID, stage: "prod" });
    expect(h.rowDomain()).toBe(OWN);
    expect(await h.regDomain()).toBe(OWN);
    expect(h.probe.probed).toContain(healthAt(OWN));
    // The zone keeps its record: the charts answer it with a redirect to the domain.
    expect(h.dns.record(ZONE, "CNAME")).toBe(CLUSTER);
  });

  it("sets redirect hosts beside the domain: a record each, recorded, and a redirect awaited at each", async () => {
    const h = await make({ answers: [OWN], redirecting: [BARE] });
    const runId = await move(h, OWN, "", { ownDomainRedirects: [BARE] });
    expect(getRun(h.db.db, runId)?.status).toBe("succeeded");
    expect(h.dns.record(BARE, "CNAME")).toBe(ZONE);
    expect(findDnsWrite(h.db.db, { name: BARE, type: "CNAME" })?.owner).toEqual({ kind: "tenant", name: GUID, stage: "prod" });
    expect(h.rowRedirects()).toEqual([BARE]);
    expect(await h.regRedirects()).toEqual([BARE]);
    expect(h.probe.probed).toContain(`https://${BARE}/`);
  });

  it("PLANTED DEFECT: moves a tenant standing at www.<domain> to <domain> when the domain is set again, writes and removes no record, and says its users sign in once more", async () => {
    const h = await make({ ownDomain: OWN, ownDomainRedirects: [BARE], answers: [BARE], redirecting: [OWN] });
    for (const host of [OWN, BARE]) {
      h.dns.seed(host, "CNAME", ZONE);
      recordDnsWrite(h.db.db, { name: host, type: "CNAME", content: ZONE, act: "inserted", owner: { kind: "tenant", name: GUID, stage: "prod" }, runId: "run_old" });
    }
    const planned = await plan(h, { ownDomain: BARE, ownDomainRedirects: [OWN], previous: OWN, previousRedirects: [BARE] });
    expect(planned.summary).toContain(`Move tenant ${GUID} from ${OWN} to ${BARE}`);
    expect(planned.summary).toContain("so every user of the tenant signs in once more");
    expect(planned.summary).not.toContain("remove the records of");
    await h.executor.approve(planned.runId); await h.executor.settle(planned.runId);
    expect(getRun(h.db.db, planned.runId)?.status).toBe("succeeded");
    expect([h.rowDomain(), await h.regDomain(), h.rowRedirects(), await h.regRedirects()]).toEqual([BARE, BARE, [OWN], [OWN]]);
    expect([h.dns.upserts, h.dns.creates, h.dns.deletes]).toEqual([[], [], []]);
    expect(h.probe.probed).toEqual([healthAt(BARE), `https://${OWN}/`]);
  });

  it("PLANTED DEFECT: retires the domain it moves from once the new host answers, and keeps no alias of it", async () => {
    const NEXT = "www.next.test";
    const h = await make({ ownDomain: OWN, ownDomainRedirects: [BARE], answers: [NEXT] });
    for (const host of [OWN, BARE]) {
      h.dns.seed(host, "CNAME", ZONE);
      recordDnsWrite(h.db.db, { name: host, type: "CNAME", content: ZONE, act: "inserted", owner: { kind: "tenant", name: GUID, stage: "prod" }, runId: "run_old" });
    }
    const planned = await plan(h, { ownDomain: NEXT, previous: OWN, previousRedirects: [BARE] });
    expect(planned.summary).toContain(`remove the records of ${OWN}, ${BARE}`);
    await h.executor.approve(planned.runId);
    await h.executor.settle(planned.runId);
    expect(getRun(h.db.db, planned.runId)?.status).toBe("succeeded");
    expect([h.rowAliases(), await h.regAliases()]).toEqual([[], []]);
    expect([h.dns.record(OWN, "CNAME"), h.dns.record(BARE, "CNAME"), h.dns.record(NEXT, "CNAME")]).toEqual([undefined, undefined, ZONE]);
  });

  it("names the mail records beside its hosts in the plan, and refuses to write where one changed since", async () => {
    const h = await make({ answers: [OWN], redirecting: [BARE] });
    h.dns.seed(BARE, "MX", "10 mx.mail.test");
    h.dns.seed(BARE, "TXT", "v=spf1 include:mail.test -all");
    h.dns.seed(`_dmarc.${BARE}`, "TXT", "v=DMARC1; p=reject"); h.dns.seed(`autodiscover.${BARE}`, "CNAME", "autodiscover.mail.test");
    const planned = await plan(h, { ownDomain: OWN, ownDomainRedirects: [BARE], previous: "" });
    expect(planned.summary).toMatch(/leaves the mail records beside them as they stand: MX customer\.test \(SHA-256 [0-9a-f]{12}\), TXT customer\.test \(SHA-256 [0-9a-f]{12}\), TXT _dmarc\.customer\.test \(SHA-256 [0-9a-f]{12}\), CNAME autodiscover\.customer\.test/);
    h.dns.seed(BARE, "MX", "10 mx.elsewhere.test");
    await h.executor.approve(planned.runId); await h.executor.settle(planned.runId);
    expect(getRun(h.db.db, planned.runId)?.status).toBe("failed");
    expect(readEvents(h.db.db, planned.runId).map((e) => e.text).join("\n")).toMatch(/the MX records at customer\.test changed since this run was planned/);
    expect(h.dns.upserts).toEqual([]);
  });

  it("sets alias domains: a record at each and its www., a redirect awaited at each, and dropping one removes only its records", async () => {
    const ALIAS = "simetrix.de";
    const h = await make({ ownDomain: OWN, answers: [OWN], redirecting: [ALIAS, `www.${ALIAS}`] });
    h.dns.seed(OWN, "CNAME", ZONE);
    expect(getRun(h.db.db, await move(h, OWN, OWN, { ownDomainAliases: [ALIAS] }))?.status).toBe("succeeded");
    expect([h.dns.record(ALIAS, "CNAME"), h.dns.record(`www.${ALIAS}`, "CNAME")]).toEqual([ZONE, ZONE]);
    expect([h.rowAliases(), await h.regAliases(), h.rowRedirects()]).toEqual([[ALIAS], [ALIAS], []]);
    const dropped = await move(h, OWN, OWN, { previousAliases: [ALIAS] });
    expect(getRun(h.db.db, dropped)?.status).toBe("succeeded");
    expect([h.dns.record(ALIAS, "CNAME"), h.dns.record(`www.${ALIAS}`, "CNAME"), h.dns.record(OWN, "CNAME")]).toEqual([undefined, undefined, ZONE]);
    expect((await h.reg.readTenant("prod", GUID))?.entry).not.toHaveProperty("ownDomainAliases");
  });

  it("REFUSES an alias that is the domain or a redirect host, one named twice, and making an alias the own domain directly", async () => {
    const h = await make({ ownDomain: OWN });
    const refusal = async (request: Record<string, unknown>) => (await plan(h, { previous: OWN, ...request })).error;
    expect(await refusal({ ownDomain: OWN, ownDomainAliases: ["customer.test"] })).toMatch(/already the own domain or a redirect host/);
    expect(await refusal({ ownDomain: OWN, ownDomainAliases: ["a.test", "a.test"] })).toMatch(/named twice/);
    h.db.db.update(tenants).set({ ownDomainAliases: ["simetrix.de"] }).where(eq(tenants.id, "tnt_1")).run();
    expect(await refusal({ ownDomain: "simetrix.de", previousAliases: ["simetrix.de"] })).toMatch(/drop the alias in one run/);
  });

  it("does not take a 2xx for a redirect host: it must answer the redirect itself", async () => {
    const h = await make({ answers: [OWN, BARE] });
    h.probe.set(`https://${BARE}/`, OK);
    const runId = await move(h, OWN, "", { ownDomainRedirects: [BARE] });
    expect(getRun(h.db.db, runId)?.status).toBe("failed");
  });

  it("drops a redirect host: its record goes only after the kept hosts answer", async () => {
    const h = await make({ ownDomain: OWN, ownDomainRedirects: [BARE], answers: [OWN] });
    for (const host of [OWN, BARE]) {
      h.dns.seed(host, "CNAME", ZONE);
      recordDnsWrite(h.db.db, { name: host, type: "CNAME", content: ZONE, act: "inserted", owner: { kind: "tenant", name: GUID, stage: "prod" }, runId: "run_old" });
    }
    const runId = await move(h, OWN, OWN, { previousRedirects: [BARE] });
    expect(getRun(h.db.db, runId)?.status).toBe("succeeded");
    expect(h.dns.record(BARE, "CNAME")).toBeUndefined();
    expect(h.dns.record(OWN, "CNAME")).toBe(ZONE);
    expect(h.rowRedirects()).toEqual([]);
  });

  it("an abort after a failed redirect wait removes the new redirect host's record and records the previous hosts again", async () => {
    const h = await make({ answers: [OWN] });
    const runId = await move(h, OWN, "", { ownDomainRedirects: [BARE], ownDomainAliases: ["simetrix.de"] });
    expect(getRun(h.db.db, runId)?.status).toBe("failed");
    expect([h.dns.record(BARE, "CNAME"), h.rowAliases()]).toEqual([ZONE, ["simetrix.de"]]);
    await h.executor.abortWithCleanup(runId);
    await h.executor.settle(runId);
    expect(h.dns.record(BARE, "CNAME")).toBeUndefined();
    expect(h.dns.record(OWN, "CNAME")).toBeUndefined();
    expect([h.rowRedirects(), await h.regRedirects(), h.rowAliases(), await h.regAliases(), h.dns.record("simetrix.de", "CNAME")]).toEqual([[], [], [], [], undefined]);
  });

  it("REFUSES redirect hosts without a domain, twice named, equal to the domain, in the platform's name space, or another tenant's", async () => {
    const h = await make();
    const refusal = async (ownDomain: string, ownDomainRedirects: string[]) => (await plan(h, { ownDomain, ownDomainRedirects, previous: "" })).error;
    expect(await refusal("", [BARE])).toMatch(/need an own domain/);
    expect(await refusal(OWN, [BARE, BARE])).toMatch(/named twice/);
    expect(await refusal(OWN, [OWN])).toMatch(/redirect to itself/);
    expect(await refusal(OWN, ["www.example.com"])).toMatch(/platform's own name space/);
    h.db.db.insert(tenants).values({
      id: "tnt_2", clusterId: "cls_1", guid: "zzzzzzzzzzzz", subdomain: "beta", stage: "prod",
      members: ["auth"], identityProvider: "auth", ownDomain: "beta.test", ownDomainRedirects: [BARE], suspended: false, status: "active",
    }).run();
    expect(await refusal(OWN, [BARE])).toMatch(/overlaps a host of tenant beta/);
    expect(await refusal("www.other.test", [BARE])).toMatch(/already a host of tenant beta/);
    expect(await refusal("www.other.test", ["www.beta.test"])).toMatch(/overlaps a host of tenant beta \(beta.test\)/);
    expect(await refusal("www.other.test", ["app.s1.example"])).toMatch(/under the cluster name s1.example/);
  });

  it("sets a domain under another tenant's host where the operator confirms it: the plan says so, and the row records it", async () => {
    const h = await make({ answers: [OWN] });
    h.db.db.insert(tenants).values({
      id: "tnt_2", clusterId: "cls_1", guid: "zzzzzzzzzzzz", subdomain: "beta", stage: "prod",
      members: ["auth"], identityProvider: "auth", ownDomain: BARE, suspended: false, status: "active",
    }).run();
    expect((await plan(h, { ownDomain: OWN, previous: "" })).error).toMatch(/overlaps a host of tenant beta \(customer.test\) — where both tenants are one owner's/);
    expect((await plan(h, { ownDomain: OWN, previous: "", nestsUnder: "nobody" })).error).toMatch(/no other live tenant has the subdomain "nobody"/);
    const planned = await plan(h, { ownDomain: OWN, previous: "", nestsUnder: "beta" });
    expect(planned.summary).toContain("www.customer.test lies under customer.test of tenant beta, as the operator confirms here");
    await h.executor.approve(planned.runId);
    await h.executor.settle(planned.runId);
    expect(getRun(h.db.db, planned.runId)?.status).toBe("succeeded");
    expect(h.db.db.select({ n: tenants.nestsUnder }).from(tenants).where(eq(tenants.id, "tnt_1")).get()?.n).toBe("tnt_2");
  });

  it("REFUSES a request whose previous redirect hosts are not the tenant's any more", async () => {
    const h = await make({ ownDomain: OWN, ownDomainRedirects: [BARE] });
    expect((await plan(h, { ownDomain: OWN, previous: OWN })).error).toMatch(/moved since/);
    expect((await plan(h, { ownDomain: OWN, previous: OWN, previousRedirects: [BARE] })).status).toBe("planned");
  });

  it("leaves a retired host's record standing once it points elsewhere: it is somebody else's now", async () => {
    const h = await make({ ownDomain: OWN, ownDomainRedirects: [BARE], answers: [OWN] });
    for (const host of [OWN, BARE]) recordDnsWrite(h.db.db, { name: host, type: "CNAME", content: ZONE, act: "inserted", owner: { kind: "tenant", name: GUID, stage: "prod" }, runId: "run_old" });
    h.dns.seed(OWN, "CNAME", ZONE);
    h.dns.seed(BARE, "CNAME", "shop.hoster.test");
    const runId = await move(h, OWN, OWN, { previousRedirects: [BARE] });
    expect(getRun(h.db.db, runId)?.status).toBe("succeeded");
    expect(h.dns.record(BARE, "CNAME")).toBe("shop.hoster.test");
    expect(findDnsWrite(h.db.db, { name: BARE, type: "CNAME" })).toBeNull();
  });

  it("REFUSES the abort once a retired redirect host's record is gone", async () => {
    const h = await make({ ownDomain: OWN, ownDomainRedirects: [BARE] });
    h.dns.seed(OWN, "CNAME", ZONE);
    h.dns.seed(BARE, "CNAME", ZONE);
    const runId = await move(h, OWN, OWN, { previousRedirects: [BARE] });
    expect(getRun(h.db.db, runId)?.status).toBe("failed");
    await h.dns.deleteRecord({ name: BARE, type: "CNAME" });
    await expect(h.executor.abortWithCleanup(runId)).rejects.toThrow(/customer.test, a previous host's record, is gone/);
  });

  it("writes nothing into a zone nobody here manages, and still records the domain once it answers", async () => {
    const h = await make({ answers: [OWN], unmanaged: ["customer.test"] });
    const runId = await move(h, OWN, "");
    expect(getRun(h.db.db, runId)?.status).toBe("succeeded");
    expect(h.dns.upserts).toEqual([]);
    expect(h.rowDomain()).toBe(OWN);
  });

  it("clears: the previous domain's record goes only after the zone answers", async () => {
    const h = await make({ ownDomain: OWN, answers: [ZONE] });
    h.dns.seed(OWN, "CNAME", ZONE);
    recordDnsWrite(h.db.db, { name: OWN, type: "CNAME", content: ZONE, act: "inserted", owner: { kind: "tenant", name: GUID, stage: "prod" }, runId: "run_old" });
    const runId = await move(h, "", OWN);
    expect(getRun(h.db.db, runId)?.status).toBe("succeeded");
    expect(h.dns.record(OWN, "CNAME")).toBeUndefined();
    expect(h.rowDomain()).toBe("");
  });

  it("an abort after the failed wait records the previous domain again and removes the new domain's record", async () => {
    const h = await make();
    const runId = await move(h, OWN, "");
    expect(getRun(h.db.db, runId)?.status).toBe("failed");
    expect(h.dns.record(OWN, "CNAME")).toBe(ZONE);

    await h.executor.abortWithCleanup(runId);
    await h.executor.settle(runId);
    expect(getRun(h.db.db, runId)?.status).toBe("cancelled");
    expect(h.rowDomain()).toBe("");
    expect(await h.regDomain()).toBe("");
    expect(h.dns.record(OWN, "CNAME")).toBeUndefined();
    expect(h.dns.record(ZONE, "CNAME")).toBe(CLUSTER);
  });

  it("REFUSES the abort once the previous domain's record is gone, and leaves the run as it was", async () => {
    const h = await make({ ownDomain: OWN });
    h.dns.seed(OWN, "CNAME", ZONE);
    const runId = await move(h, "", OWN);
    expect(getRun(h.db.db, runId)?.status).toBe("failed");
    await h.dns.deleteRecord({ name: OWN, type: "CNAME" });
    await expect(h.executor.abortWithCleanup(runId)).rejects.toThrow(/is gone/);
    expect(getRun(h.db.db, runId)?.status).toBe("failed");
  });

  it("skipping the failed wait removes nothing: the wait and the removal are one step", async () => {
    const h = await make({ ownDomain: OWN });
    h.dns.seed(OWN, "CNAME", ZONE);
    recordDnsWrite(h.db.db, { name: OWN, type: "CNAME", content: ZONE, act: "inserted", owner: { kind: "tenant", name: GUID, stage: "prod" }, runId: "run_old" });
    const runId = await move(h, OTHER, OWN);
    await h.executor.skipStep(runId, "retire-previous-own-domain", "test");
    await h.executor.settle(runId);
    expect(h.dns.record(OWN, "CNAME")).toBe(ZONE);
  });

  it("does not take a redirect for the IdP at the new host", async () => {
    const h = await make();
    h.probe.set(healthAt(OWN), { reachable: true, status: 307, detail: "HTTP 307" });
    const runId = await move(h, OWN, "");
    expect(getRun(h.db.db, runId)?.status).toBe("failed");
  });

  it("frees the domain of an offboarded tenant, and refuses one that overlaps a live tenant's or lies under a cluster name", async () => {
    const h = await make();
    const other = (id: string, guid: string, domain: string, status: "active" | "offboarded"): void => {
      h.db.db.insert(tenants).values({
        id, clusterId: "cls_1", guid, subdomain: id, stage: "prod",
        members: ["auth"], identityProvider: "auth", ownDomain: domain, suspended: false, status,
      }).run();
    };
    other("tnt_old", "oooooooooooo", OWN, "offboarded");
    expect((await plan(h, { ownDomain: OWN, previous: "" })).status).toBe("planned");
    other("tnt_live", "llllllllllll", "customer.test", "active");
    expect((await plan(h, { ownDomain: OWN, previous: "" })).error).toMatch(/overlaps a host of tenant tnt_live/);
    expect((await plan(h, { ownDomain: "app.s1.example", previous: "" })).error).toMatch(/under the cluster name s1.example/);
  });

  it("asks the plan's facts again when it runs: a run planned before another moved the tenant fails without writing", async () => {
    const h = await make({ answers: [OWN, OTHER] });
    const first = await plan(h, { ownDomain: OWN, previous: "" });
    const second = await plan(h, { ownDomain: OTHER, previous: "" });
    await h.executor.approve(first.runId);
    await h.executor.settle(first.runId);
    expect(h.rowDomain()).toBe(OWN);
    await h.executor.approve(second.runId);
    await h.executor.settle(second.runId);
    expect(getRun(h.db.db, second.runId)?.status).toBe("failed");
    expect(h.rowDomain()).toBe(OWN);
  });

  it("REFUSES at plan time: a moved tenant, a name of the platform and a domain another tenant has", async () => {
    const moved = await make({ ownDomain: OWN });
    expect((await plan(moved, { ownDomain: OTHER, previous: "" })).error).toMatch(/moved since/);
    const platform = await make();
    expect((await plan(platform, { ownDomain: "shop.example.com", previous: "" })).error).toMatch(/platform's own name space/);
    platform.db.db.insert(tenants).values({
      id: "tnt_2", clusterId: "cls_1", guid: "zzzzzzzzzzzz", subdomain: "beta", stage: "prod",
      members: ["auth"], identityProvider: "auth", ownDomain: OTHER, suspended: false, status: "active",
    }).run();
    expect((await plan(platform, { ownDomain: OTHER, previous: "" })).error).toMatch(/already a host of tenant beta/);
  });

  it("replaces the address records and a foreign CNAME at the new hosts: the plan lists them, the run deletes them, an abort writes them back", async () => {
    const h = await make();
    h.dns.seed(OWN, "A", "192.0.2.10", "192.0.2.11");
    h.dns.seed(BARE, "CNAME", "shop.hoster.test");
    const planned = await plan(h, { ownDomain: OWN, ownDomainRedirects: [BARE], previous: "" });
    expect(planned.summary).toContain(`It deletes A ${OWN} → 192.0.2.10, A ${OWN} → 192.0.2.11, CNAME ${BARE} → shop.hoster.test, which this installation did not write, and an abort writes them back.`);
    await h.executor.approve(planned.runId);
    await h.executor.settle(planned.runId);
    // Nothing answers at the new host, so the run fails at its wait with both hosts pointed at the tenant.
    expect(getRun(h.db.db, planned.runId)?.status).toBe("failed");
    expect([h.dns.record(OWN, "A"), h.dns.record(OWN, "CNAME"), h.dns.record(BARE, "CNAME")]).toEqual([undefined, ZONE, ZONE]);
    await h.executor.abortWithCleanup(planned.runId);
    await h.executor.settle(planned.runId);
    expect(await h.dns.listRecordContents({ name: OWN, type: "A" })).toEqual(["192.0.2.10", "192.0.2.11"]);
    expect([h.dns.record(OWN, "CNAME"), h.dns.record(BARE, "CNAME")]).toEqual([undefined, "shop.hoster.test"]);
  });

  it("REFUSES a record this installation wrote for another owner, and a record that stands only after the plan", async () => {
    const h = await make();
    h.dns.seed(OWN, "A", "192.0.2.10");
    recordDnsWrite(h.db.db, { name: OWN, type: "A", content: "192.0.2.10", act: "inserted", owner: { kind: "consumer", name: "shop", stage: "prod" }, runId: "run_shop" });
    expect((await plan(h, { ownDomain: OWN, previous: "" })).error).toMatch(/192\.0\.2\.10, which this installation wrote for consumer shop — it is not tenant zsjs023ctne0's to replace/);
    const late = await make({ answers: [OWN] });
    const planned = await plan(late, { ownDomain: OWN, previous: "" });
    expect(planned.summary).not.toContain("It deletes");
    late.dns.seed(OWN, "AAAA", "2001:db8::1");
    await late.executor.approve(planned.runId);
    await late.executor.settle(planned.runId);
    expect(getRun(late.db.db, planned.runId)?.status).toBe("failed");
    expect([late.dns.record(OWN, "AAAA"), late.dns.record(OWN, "CNAME")]).toEqual(["2001:db8::1", undefined]);
  });
});
