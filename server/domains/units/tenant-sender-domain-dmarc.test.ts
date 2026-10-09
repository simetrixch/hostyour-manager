import { describe, it, expect, afterEach } from "vitest";
import { rmSync } from "node:fs";
import type { DbHandle } from "../../db/client.ts";
import { getRun, getRunParams, getRunEnding, readEvents } from "../../executor/read.ts";
import { findDnsWrite, recordDnsWrite } from "../../db/dns-writes.ts";
import { FakeDnsProvider } from "../../adapters/dns/testing/fake.ts";
import type { TenantSetSenderDomainParams } from "./tenant-sender-domain.run.ts";
import {
  GUID,
  DOMAIN,
  ASKED,
  DKIM_RECORD_NAME,
  DKIM_RECORD_CONTENT,
  DKIM_ZONE,
  DMARC_RECORD_NAME,
  DMARC_RECORD_CONTENT,
  DMARC_RECORD_URL,
  KEPT,
  fakePost,
  make as makeFixture,
  set,
  type MakeOptions,
} from "./tenant-sender-domain.fixture.ts";

const SIGNED = { status: 200, body: JSON.stringify({ domain: DOMAIN, signing: true }) };
const UNSIGNED = { status: 200, body: JSON.stringify({ domain: DOMAIN, signing: false }) };
const OWNER = { kind: "tenant", name: GUID, stage: "prod" } as const;
const FOREIGN = "v=DMARC1; p=reject; rua=mailto:dmarc@customer.test";

describe("tenant-set-sender-domain DMARC steps", () => {
  const handles: DbHandle[] = [];
  const dirs: string[] = [];
  afterEach(() => {
    for (const h of handles.splice(0)) h.sqlite.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  const make = (opts: MakeOptions = {}) => makeFixture({ dmarc: true, renders: DOMAIN, ...opts }, handles, dirs);
  const zoned = (): FakeDnsProvider => Object.assign(new FakeDnsProvider(), { zones: [DKIM_ZONE] });
  const planOf = (h: Awaited<ReturnType<typeof make>>, senderDomain = DOMAIN, previous = "") =>
    h.executor.plan("tenant-set-sender-domain", { tenantId: "tnt_1", senderDomain, previous });
  const logsOf = (h: Awaited<ReturnType<typeof make>>, runId: string) => readEvents(h.db.db, runId).map((e) => e.text).join("\n");

  // mutant: the publish-dmarc-record step is not in the run's step list, so no DMARC record is published
  // mutant: the record text is a Manager literal, not the text post answers
  // mutant: planDmarcRecord answers null where the DKIM check says mail is signed already
  it("publishes the text post answers, books it as the tenant's, also where mail is signed already", async () => {
    const dns = zoned();
    const h = await make({ dns, answer: SIGNED });
    const { runId, plan } = await planOf(h);
    expect(plan.summary).toContain(`The run publishes TXT ${DMARC_RECORD_NAME} in the zone ${DKIM_ZONE}.`);
    expect(plan.steps.map((st) => st.name).slice(1, 4)).toEqual(["publish-dkim-record", "publish-dmarc-record", "await-dkim-signing"]);
    expect(getRunParams(h.db.db, runId)?.params.dmarc).toEqual({ act: "publish", name: DMARC_RECORD_NAME, content: DMARC_RECORD_CONTENT, zone: DKIM_ZONE });

    await h.executor.approve(runId);
    await h.executor.settle(runId);

    expect(getRun(h.db.db, runId)?.status).toBe("succeeded");
    // Asked at the plan and again by the step, each time with the key the Manager keeps for post.
    expect(h.post.calls.filter((c) => c.url === DMARC_RECORD_URL).map((c) => [c.method, c.key])).toEqual([["GET", KEPT], ["GET", KEPT]]);
    expect(dns.creates).toEqual([{ name: DMARC_RECORD_NAME, type: "TXT", content: DMARC_RECORD_CONTENT, proxied: false, ttl: 1 }]);
    expect(findDnsWrite(h.db.db, { name: DMARC_RECORD_NAME, type: "TXT" })).toMatchObject({
      name: DMARC_RECORD_NAME, type: "TXT", content: DMARC_RECORD_CONTENT, act: "inserted", owner: OWNER, runId,
    });
  });

  it("publishes the DKIM record first, then DMARC, and the run still waits for signing", async () => {
    const dns = zoned();
    const ref: { current?: Awaited<ReturnType<typeof make>> } = {};
    const post = fakePost({
      onCheck: () => ref.current?.probe.set(ASKED, { reachable: true, status: 200, detail: "HTTP 200", body: SIGNED.body }),
    });
    const h = await make({ dns, post, answer: UNSIGNED, dkimWaitMs: 50, dkimPollMs: 5 });
    ref.current = h;
    const runId = await set(h, DOMAIN);

    expect(getRun(h.db.db, runId)?.status).toBe("succeeded");
    expect(dns.creates.map((c) => [c.name, c.content])).toEqual([[DKIM_RECORD_NAME, DKIM_RECORD_CONTENT], [DMARC_RECORD_NAME, DMARC_RECORD_CONTENT]]);
    expect(await h.registered()).toBe(DOMAIN);
  });

  // mutant: a TXT record that this Manager did not write is overwritten, or planned as publish
  it("keeps a DMARC policy this Manager did not write, byte for byte, and the run succeeds", async () => {
    const dns = zoned();
    dns.seed(DMARC_RECORD_NAME, "TXT", FOREIGN);
    const h = await make({ dns, answer: SIGNED });
    const { runId, plan } = await planOf(h);
    const why = `a DMARC policy this Manager did not write stands at ${DMARC_RECORD_NAME}; it stays`;
    expect(plan.summary).toContain(`The run publishes no DMARC record: ${why}.`);
    expect(plan.steps.find((st) => st.name === "publish-dmarc-record")?.title).toBe(`No DMARC record to publish: ${why}`);
    expect(getRunParams(h.db.db, runId)?.params.dmarc).toEqual({ act: "keep", name: DMARC_RECORD_NAME, content: DMARC_RECORD_CONTENT, zone: DKIM_ZONE, why });

    await h.executor.approve(runId);
    await h.executor.settle(runId);

    expect(getRun(h.db.db, runId)?.status).toBe("succeeded");
    expect(dns.creates).toHaveLength(0);
    expect(dns.upserts).toHaveLength(0);
    expect(dns.deletes).toHaveLength(0);
    expect(dns.record(DMARC_RECORD_NAME, "TXT")).toBe(FOREIGN);
    expect(findDnsWrite(h.db.db, { name: DMARC_RECORD_NAME, type: "TXT" })).toBeNull();
    expect(await h.registered()).toBe(DOMAIN);
  });

  it("still publishes the DKIM record where a foreign DMARC policy stands", async () => {
    const dns = zoned();
    dns.seed(DMARC_RECORD_NAME, "TXT", FOREIGN);
    const ref: { current?: Awaited<ReturnType<typeof make>> } = {};
    const post = fakePost({
      onCheck: () => ref.current?.probe.set(ASKED, { reachable: true, status: 200, detail: "HTTP 200", body: SIGNED.body }),
    });
    const h = await make({ dns, post, answer: UNSIGNED, dkimWaitMs: 50, dkimPollMs: 5 });
    ref.current = h;
    const runId = await set(h, DOMAIN);

    expect(getRun(h.db.db, runId)?.status).toBe("succeeded");
    expect(dns.creates.map((c) => c.name)).toEqual([DKIM_RECORD_NAME]);
    expect(dns.record(DMARC_RECORD_NAME, "TXT")).toBe(FOREIGN);
  });

  it("keeps a record this Manager booked earlier as it stands, whatever its content", async () => {
    const dns = zoned();
    dns.seed(DMARC_RECORD_NAME, "TXT", "v=DMARC1; p=none");
    const h = await make({ dns, answer: SIGNED });
    recordDnsWrite(h.db.db, { name: DMARC_RECORD_NAME, type: "TXT", content: "v=DMARC1; p=none", act: "inserted", owner: OWNER, runId: "run_prev" });
    const { runId, plan } = await planOf(h);
    expect(plan.summary).toContain("The run publishes no DMARC record: the DMARC record booked by run run_prev stays.");

    await h.executor.approve(runId);
    await h.executor.settle(runId);

    expect(getRun(h.db.db, runId)?.status).toBe("succeeded");
    expect(dns.creates).toHaveLength(0);
    expect(dns.deletes).toHaveLength(0);
    expect(dns.record(DMARC_RECORD_NAME, "TXT")).toBe("v=DMARC1; p=none");
    expect(findDnsWrite(h.db.db, { name: DMARC_RECORD_NAME, type: "TXT" })?.runId).toBe("run_prev");
  });

  it("PLANTED INNOCENT: a booked record that is gone at the provider is published again", async () => {
    const dns = zoned();
    const h = await make({ dns, answer: SIGNED });
    recordDnsWrite(h.db.db, { name: DMARC_RECORD_NAME, type: "TXT", content: DMARC_RECORD_CONTENT, act: "inserted", owner: OWNER, runId: "run_prev" });
    const runId = await set(h, DOMAIN);

    expect(getRun(h.db.db, runId)?.status).toBe("succeeded");
    expect(dns.record(DMARC_RECORD_NAME, "TXT")).toBe(DMARC_RECORD_CONTENT);
    expect(findDnsWrite(h.db.db, { name: DMARC_RECORD_NAME, type: "TXT" })?.runId).toBe(runId);
  });

  // mutant: the step overwrites or fails on a TXT record that appeared at the name after the plan
  it("leaves a record that appeared since the plan, logs it, and does not fail", async () => {
    const dns = zoned();
    const h = await make({ dns, answer: SIGNED });
    const { runId } = await planOf(h);
    expect(getRunParams(h.db.db, runId)?.params.dmarc).toMatchObject({ act: "publish" });
    dns.seed(DMARC_RECORD_NAME, "TXT", FOREIGN);

    await h.executor.approve(runId);
    await h.executor.settle(runId);

    expect(getRun(h.db.db, runId)?.status).toBe("succeeded");
    expect(dns.creates).toHaveLength(0);
    expect(dns.record(DMARC_RECORD_NAME, "TXT")).toBe(FOREIGN);
    expect(findDnsWrite(h.db.db, { name: DMARC_RECORD_NAME, type: "TXT" })).toBeNull();
    expect(logsOf(h, runId)).toContain(`a TXT record stands at ${DMARC_RECORD_NAME} since the plan`);
  });

  // mutant: the step publishes the planned record although post wants another one now
  it("fails at run time when post wants another record than the plan named", async () => {
    const dns = zoned();
    const dmarcRecord = { name: DMARC_RECORD_NAME, type: "TXT", content: DMARC_RECORD_CONTENT };
    const h = await make({ dns, answer: SIGNED, post: fakePost({ dmarcRecord }) });
    const { runId } = await planOf(h);
    dmarcRecord.content = "v=DMARC1; p=reject";
    await h.executor.approve(runId);
    await h.executor.settle(runId);

    expect(getRun(h.db.db, runId)?.status).toBe("failed");
    expect(getRunEnding(h.db.db, runId)?.error).toContain("wants another DMARC record");
    expect(getRunEnding(h.db.db, runId)?.error).toContain("plan again");
    expect(dns.creates).toHaveLength(0);
  });

  // mutant: the cleanup deletes the record without asking the book, or after a later run booked it
  it("takes back on abort the record this run created, and forgets it", async () => {
    const dns = zoned();
    const h = await make({ dns, renders: "", answer: SIGNED });
    const runId = await set(h, DOMAIN);
    expect(getRun(h.db.db, runId)?.status).toBe("failed");
    expect(dns.record(DMARC_RECORD_NAME, "TXT")).toBe(DMARC_RECORD_CONTENT);

    await h.executor.abortWithCleanup(runId);
    await h.executor.settle(runId);

    expect(getRun(h.db.db, runId)?.status).toBe("cancelled");
    expect(dns.record(DMARC_RECORD_NAME, "TXT")).toBeUndefined();
    expect(dns.deletes).toEqual([{ name: DMARC_RECORD_NAME, type: "TXT", content: DMARC_RECORD_CONTENT, deleted: 1 }]);
    expect(findDnsWrite(h.db.db, { name: DMARC_RECORD_NAME, type: "TXT" })).toBeNull();
  });

  // mutant: removeDmarcRecordCleanup deletes a record whose book entry names another run
  it("leaves the record on abort once the book names another run", async () => {
    const dns = zoned();
    const h = await make({ dns, renders: "", answer: SIGNED });
    const runId = await set(h, DOMAIN);
    recordDnsWrite(h.db.db, { name: DMARC_RECORD_NAME, type: "TXT", content: DMARC_RECORD_CONTENT, act: "inserted", owner: OWNER, runId: "run_later" });

    await h.executor.abortWithCleanup(runId);
    await h.executor.settle(runId);

    expect(dns.deletes).toHaveLength(0);
    expect(dns.record(DMARC_RECORD_NAME, "TXT")).toBe(DMARC_RECORD_CONTENT);
    expect(findDnsWrite(h.db.db, { name: DMARC_RECORD_NAME, type: "TXT" })?.runId).toBe("run_later");
  });

  it("PLANTED INNOCENT: an abort leaves a foreign DMARC policy that stood the whole time", async () => {
    const dns = zoned();
    dns.seed(DMARC_RECORD_NAME, "TXT", FOREIGN);
    const h = await make({ dns, renders: "", answer: SIGNED });
    const runId = await set(h, DOMAIN);
    expect(getRun(h.db.db, runId)?.status).toBe("failed");

    await h.executor.abortWithCleanup(runId);
    await h.executor.settle(runId);

    expect(dns.deletes).toHaveLength(0);
    expect(dns.record(DMARC_RECORD_NAME, "TXT")).toBe(FOREIGN);
  });

  // mutant: readDmarcRecord accepts a record that is not the domain's DMARC record
  it.each([
    ["another domain's name", { name: "_dmarc.other.test", type: "TXT", content: DMARC_RECORD_CONTENT }],
    ["a name below the DMARC name", { name: `x._dmarc.${DOMAIN}`, type: "TXT", content: DMARC_RECORD_CONTENT }],
    ["a type other than TXT", { name: DMARC_RECORD_NAME, type: "CNAME", content: DMARC_RECORD_CONTENT }],
    ["a text that is no DMARC policy", { name: DMARC_RECORD_NAME, type: "TXT", content: "v=spf1 -all" }],
    ["an empty text", { name: DMARC_RECORD_NAME, type: "TXT", content: "" }],
  ])("refuses at plan an answer with %s", async (_what, dmarcRecord) => {
    const dns = zoned();
    const h = await make({ dns, answer: SIGNED, post: fakePost({ dmarcRecord }) });
    await expect(planOf(h)).rejects.toThrow(`answered no DMARC record of ${DOMAIN}`);
    expect(dns.creates).toHaveLength(0);
  });

  it("refuses at plan where post cannot give the record", async () => {
    const h = await make({ dns: zoned(), answer: SIGNED, post: fakePost({ dmarcRecord: null }) });
    await expect(planOf(h)).rejects.toThrow(`the Manager cannot read the DMARC record of ${DOMAIN}`);
  });

  it("refuses at plan a record in a zone this Manager does not manage, as DKIM does", async () => {
    const dns = new FakeDnsProvider();
    dns.unmanaged = [DKIM_ZONE];
    const h = await make({ dns, answer: SIGNED });
    await expect(planOf(h)).rejects.toThrow(new RegExp(`${DMARC_RECORD_NAME}.*does not manage`));
    expect(dns.creates).toHaveLength(0);
  });

  it("says in the plan that a product without dmarcRecordUrl gets no DMARC record, and asks post for none", async () => {
    const dns = zoned();
    const h = await make({ dns, dmarc: false, dkim: true, answer: SIGNED });
    const { runId, plan } = await planOf(h);
    expect(plan.summary).toContain("The product declares no senderDomainDkim.dmarcRecordUrl, so the run publishes no DMARC record.");
    expect(plan.steps.find((st) => st.name === "publish-dmarc-record")?.title).toBe("No DMARC record to publish: the product declares no senderDomainDkim.dmarcRecordUrl");
    expect(getRunParams(h.db.db, runId)?.params.dmarc).toBeUndefined();

    await h.executor.approve(runId);
    await h.executor.settle(runId);

    expect(getRun(h.db.db, runId)?.status).toBe("succeeded");
    expect(dns.creates).toHaveLength(0);
    expect(h.post.calls.some((c) => c.url.includes("/dmarc-record"))).toBe(false);
  });

  it("plans no DMARC record when the tenant sends from the platform's own domain", async () => {
    const dns = zoned();
    const h = await make({ dns, senderDomain: DOMAIN, renders: "" });
    const { runId, plan } = await planOf(h, "", DOMAIN);
    expect(plan.summary).not.toContain("DMARC");
    expect(getRunParams(h.db.db, runId)?.params.dmarc).toBeUndefined();

    await h.executor.approve(runId);
    await h.executor.settle(runId);

    expect(getRun(h.db.db, runId)?.status).toBe("succeeded");
    expect(dns.creates).toHaveLength(0);
    expect(dns.deletes).toHaveLength(0);
    expect(h.post.calls.some((c) => c.url.includes("/dmarc-record"))).toBe(false);
  });

  it("ignores a caller-supplied dmarc parameter and writes what the plan decides", async () => {
    const dns = zoned();
    const h = await make({ dns, answer: SIGNED });
    const { runId } = await h.executor.plan("tenant-set-sender-domain", {
      tenantId: "tnt_1",
      senderDomain: DOMAIN,
      previous: "",
      dmarc: { act: "publish", name: "_dmarc.evil.test", content: "v=DMARC1; p=none", zone: "evil.test" },
    } as unknown as TenantSetSenderDomainParams);
    expect(getRunParams(h.db.db, runId)?.params.dmarc).toEqual({ act: "publish", name: DMARC_RECORD_NAME, content: DMARC_RECORD_CONTENT, zone: DKIM_ZONE });

    await h.executor.approve(runId);
    await h.executor.settle(runId);

    expect(dns.creates.map((c) => c.name)).toEqual([DMARC_RECORD_NAME]);
  });
});
