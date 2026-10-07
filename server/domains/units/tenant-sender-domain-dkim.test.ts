import { describe, it, expect, afterEach } from "vitest";
import { rmSync } from "node:fs";
import type { DbHandle } from "../../db/client.ts";
import { getRun, getRunParams, getRunEnding } from "../../executor/read.ts";
import { findDnsWrite, recordDnsWrite } from "../../db/dns-writes.ts";
import { FakeDnsProvider } from "../../adapters/dns/testing/fake.ts";
import type { TenantSetSenderDomainParams } from "./tenant-sender-domain.run.ts";
import {
  GUID,
  DOMAIN,
  ASKED,
  DKIM_RECORD_NAME,
  DKIM_RECORD_CONTENT,
  DKIM_CHECK_URL,
  DKIM_ZONE,
  fakePost,
  make as makeFixture,
  set,
  type MakeOptions,
} from "./tenant-sender-domain.fixture.ts";

describe("tenant-set-sender-domain DKIM steps", () => {
  const handles: DbHandle[] = [];
  const dirs: string[] = [];
  afterEach(() => {
    for (const h of handles.splice(0)) h.sqlite.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  const make = (opts: MakeOptions = {}) => makeFixture(opts, handles, dirs);

  // mutant: plan names no DKIM record or DNS creation is skipped / runs after issuer binding
  it("plans and publishes DKIM record, books inserted, checks signing, and binds issuer in order", async () => {
    const dns = new FakeDnsProvider();
    dns.zones = [DKIM_ZONE];
    const calls: string[] = [];
    const origCreate = dns.createRecord.bind(dns);
    dns.createRecord = async (arg) => {
      calls.push(`dns:create:${arg.name}`);
      return origCreate(arg);
    };

    const ref: { current?: Awaited<ReturnType<typeof make>> } = {};
    const post = fakePost({
      onCheck: () => {
        calls.push("post:check");
        ref.current?.probe.set(ASKED, { reachable: true, status: 200, detail: "HTTP 200", body: JSON.stringify({ domain: DOMAIN, signing: true }) });
      },
    });
    const origCall = post.call.bind(post);
    post.call = async (req) => {
      if (req.method === "PUT" && req.url.includes("/issuers")) {
        calls.push("post:put-issuer");
      }
      return origCall(req);
    };

    const h = await make({
      dkim: true,
      issuers: true,
      renders: DOMAIN,
      dns,
      post,
      answer: { status: 200, body: JSON.stringify({ domain: DOMAIN, signing: false }) },
      dkimWaitMs: 50,
      dkimPollMs: 5,
    });
    ref.current = h;

    const { runId, plan } = await h.executor.plan("tenant-set-sender-domain", { tenantId: "tnt_1", senderDomain: DOMAIN, previous: "" });
    expect(plan.summary).toContain(`TXT ${DKIM_RECORD_NAME}`);
    expect(plan.summary).toContain(`zone ${DKIM_ZONE}`);

    await h.executor.approve(runId);
    await h.executor.settle(runId);

    const run = getRun(h.db.db, runId);
    expect(run?.status).toBe("succeeded");

    expect(dns.creates).toHaveLength(1);
    expect(dns.creates[0]).toEqual(expect.objectContaining({
      name: DKIM_RECORD_NAME,
      type: "TXT",
      content: DKIM_RECORD_CONTENT,
    }));

    const booked = findDnsWrite(h.db.db, { name: DKIM_RECORD_NAME, type: "TXT" });
    expect(booked).toEqual(expect.objectContaining({
      name: DKIM_RECORD_NAME,
      type: "TXT",
      content: DKIM_RECORD_CONTENT,
      act: "inserted",
      owner: { kind: "tenant", name: GUID, stage: "prod" },
      runId,
    }));

    expect(await h.registered()).toBe(DOMAIN);
    expect(calls).toEqual([`dns:create:${DKIM_RECORD_NAME}`, "post:check", "post:put-issuer"]);
  });

  // mutant: removeDkimRecordCleanup skips deleting the record or does not forget it from the book
  it("cleans up published DKIM record on abort after wait failure", async () => {
    const dns = new FakeDnsProvider();
    dns.zones = [DKIM_ZONE];
    const h = await make({
      dkim: true,
      renders: DOMAIN,
      dns,
      answer: { status: 200, body: JSON.stringify({ domain: DOMAIN, signing: false }) },
      dkimWaitMs: 50,
      dkimPollMs: 5,
    });
    const runId = await set(h, DOMAIN);
    expect(getRun(h.db.db, runId)?.status).toBe("failed");
    expect(dns.record(DKIM_RECORD_NAME, "TXT")).toBe(DKIM_RECORD_CONTENT);
    expect(findDnsWrite(h.db.db, { name: DKIM_RECORD_NAME, type: "TXT" })).not.toBeNull();

    await h.executor.abortWithCleanup(runId);
    await h.executor.settle(runId);

    expect(getRun(h.db.db, runId)?.status).toBe("cancelled");
    expect(dns.record(DKIM_RECORD_NAME, "TXT")).toBeUndefined();
    expect(dns.deletes).toContainEqual(expect.objectContaining({
      name: DKIM_RECORD_NAME,
      type: "TXT",
      content: DKIM_RECORD_CONTENT,
    }));
    expect(findDnsWrite(h.db.db, { name: DKIM_RECORD_NAME, type: "TXT" })).toBeNull();
    expect(await h.registered()).toBe("");
  });

  // mutant: planDkimRecord ignores unmanaged DNS zone and does not throw
  it("refuses at plan when the DKIM record lies in an unmanaged zone", async () => {
    const dns = new FakeDnsProvider();
    dns.zones = [];
    dns.unmanaged = [DKIM_ZONE];
    const h = await make({
      dkim: true,
      dns,
      answer: { status: 200, body: JSON.stringify({ domain: DOMAIN, signing: false }) },
    });
    await expect(h.executor.plan("tenant-set-sender-domain", { tenantId: "tnt_1", senderDomain: DOMAIN, previous: "" }))
      .rejects.toThrow(new RegExp(`${DKIM_RECORD_NAME}.*does not manage`));
    expect(dns.creates).toHaveLength(0);
  });

  // mutant: standingDkim permits overwriting foreign TXT records
  it("refuses at plan when a foreign TXT record stands at the DKIM record name", async () => {
    const dns = new FakeDnsProvider();
    dns.zones = [DKIM_ZONE];
    dns.seed(DKIM_RECORD_NAME, "TXT", "v=DKIM1; p=foreign");
    const h = await make({
      dkim: true,
      dns,
      answer: { status: 200, body: JSON.stringify({ domain: DOMAIN, signing: false }) },
    });
    await expect(h.executor.plan("tenant-set-sender-domain", { tenantId: "tnt_1", senderDomain: DOMAIN, previous: "" }))
      .rejects.toThrow("did not write");
    expect(dns.creates).toHaveLength(0);
    expect(dns.deletes).toHaveLength(0);
    expect(dns.record(DKIM_RECORD_NAME, "TXT")).toBe("v=DKIM1; p=foreign");
  });

  // mutant: standingDkim tolerates a foreign TXT that stands beside the matching key
  it("refuses at plan when a foreign TXT stands beside the record itself", async () => {
    const dns = new FakeDnsProvider();
    dns.zones = [DKIM_ZONE];
    dns.seed(DKIM_RECORD_NAME, "TXT", DKIM_RECORD_CONTENT, "v=DKIM1; p=foreign");
    const h = await make({
      dkim: true,
      dns,
      answer: { status: 200, body: JSON.stringify({ domain: DOMAIN, signing: false }) },
    });
    await expect(h.executor.plan("tenant-set-sender-domain", { tenantId: "tnt_1", senderDomain: DOMAIN, previous: "" }))
      .rejects.toThrow("did not write");
    expect(dns.creates).toHaveLength(0);
    expect(dns.deletes).toHaveLength(0);
  });

  // mutant: readDkimRecord accepts a record post names for another domain
  it("refuses at plan a record post names for another domain", async () => {
    const dns = new FakeDnsProvider();
    dns.zones = [DKIM_ZONE, "other.test"];
    const post = fakePost({ dkimRecord: { name: "sel._domainkey.other.test", type: "TXT", content: DKIM_RECORD_CONTENT } });
    const h = await make({
      dkim: true,
      dns,
      post,
      answer: { status: 200, body: JSON.stringify({ domain: DOMAIN, signing: false }) },
    });
    await expect(h.executor.plan("tenant-set-sender-domain", { tenantId: "tnt_1", senderDomain: DOMAIN, previous: "" }))
      .rejects.toThrow(`answered no DKIM record of ${DOMAIN}`);
    expect(dns.creates).toHaveLength(0);
  });

  // mutant: standingDkim does not distinguish manager-booked TXT with different content
  it("refuses at plan when a booked TXT with another key stands at the name", async () => {
    const dns = new FakeDnsProvider();
    dns.zones = [DKIM_ZONE];
    dns.seed(DKIM_RECORD_NAME, "TXT", "v=DKIM1; p=old-key");
    const h = await make({
      dkim: true,
      dns,
      answer: { status: 200, body: JSON.stringify({ domain: DOMAIN, signing: false }) },
    });
    recordDnsWrite(h.db.db, {
      name: DKIM_RECORD_NAME,
      type: "TXT",
      content: "v=DKIM1; p=old-key",
      act: "inserted",
      owner: { kind: "tenant", name: GUID, stage: "prod" },
      runId: "run_prev",
    });
    await expect(h.executor.plan("tenant-set-sender-domain", { tenantId: "tnt_1", senderDomain: DOMAIN, previous: "" }))
      .rejects.toThrow("remove it on the DNS page");
    expect(dns.creates).toHaveLength(0);
  });

  // mutant: publishDkimRecordStep fails to adopt standing record or cleanup deletes adopted record
  it("adopts a standing record with the same content and preserves it on abort", async () => {
    const dns = new FakeDnsProvider();
    dns.zones = [DKIM_ZONE];
    dns.seed(DKIM_RECORD_NAME, "TXT", DKIM_RECORD_CONTENT);
    const h = await make({
      dkim: true,
      renders: DOMAIN,
      dns,
      answer: { status: 200, body: JSON.stringify({ domain: DOMAIN, signing: false }) },
      dkimWaitMs: 50,
      dkimPollMs: 5,
    });
    const runId = await set(h, DOMAIN);
    expect(getRun(h.db.db, runId)?.status).toBe("failed");
    expect(dns.creates).toHaveLength(0);
    const booked = findDnsWrite(h.db.db, { name: DKIM_RECORD_NAME, type: "TXT" });
    expect(booked).toEqual(expect.objectContaining({
      name: DKIM_RECORD_NAME,
      type: "TXT",
      content: DKIM_RECORD_CONTENT,
      act: "adopted",
      runId,
    }));

    await h.executor.abortWithCleanup(runId);
    await h.executor.settle(runId);

    expect(dns.deletes).toHaveLength(0);
    expect(dns.record(DKIM_RECORD_NAME, "TXT")).toBe(DKIM_RECORD_CONTENT);
  });

  // mutant: removeDkimRecordCleanup deletes a record whose book entry names another run
  it("leaves the record on abort once the book names another run", async () => {
    const dns = new FakeDnsProvider();
    dns.zones = [DKIM_ZONE];
    const h = await make({
      dkim: true,
      renders: DOMAIN,
      dns,
      answer: { status: 200, body: JSON.stringify({ domain: DOMAIN, signing: false }) },
      dkimWaitMs: 50,
      dkimPollMs: 5,
    });
    const runId = await set(h, DOMAIN);
    recordDnsWrite(h.db.db, { name: DKIM_RECORD_NAME, type: "TXT", content: DKIM_RECORD_CONTENT, act: "adopted", owner: { kind: "tenant", name: GUID, stage: "prod" }, runId: "run_later" });

    await h.executor.abortWithCleanup(runId);
    await h.executor.settle(runId);

    expect(dns.deletes).toHaveLength(0);
    expect(dns.record(DKIM_RECORD_NAME, "TXT")).toBe(DKIM_RECORD_CONTENT);
    expect(findDnsWrite(h.db.db, { name: DKIM_RECORD_NAME, type: "TXT" })?.runId).toBe("run_later");
  });

  // mutant: planDkimRecord publishes for a domain the product does not know, because the route is declared
  it("refuses at plan a domain the product does not know, though it declares the route", async () => {
    const dns = new FakeDnsProvider();
    dns.zones = [DKIM_ZONE];
    const h = await make({ dkim: true, dns, answer: { status: 404 } });
    await expect(h.executor.plan("tenant-set-sender-domain", { tenantId: "tnt_1", senderDomain: DOMAIN, previous: "" }))
      .rejects.toThrow("does not know customer.test as a sender domain");
    expect(h.post.calls.some((c) => c.url.includes("/dkim-record"))).toBe(false);
  });

  // mutant: planDkimRecord fetches DKIM record or publishes for already signed domain
  it("skips publishing when the domain is already signed", async () => {
    const dns = new FakeDnsProvider();
    dns.zones = [DKIM_ZONE];
    const h = await make({
      dkim: true,
      renders: DOMAIN,
      dns,
      answer: { status: 200, body: JSON.stringify({ domain: DOMAIN, signing: true }) },
    });
    const { runId, plan } = await h.executor.plan("tenant-set-sender-domain", { tenantId: "tnt_1", senderDomain: DOMAIN, previous: "" });
    expect(plan.summary).toContain("mail from customer.test is signed");
    expect(getRunParams(h.db.db, runId)?.params.dkim).toBeUndefined();
    expect(h.post.calls.some((c) => c.url.includes("/dkim-record"))).toBe(false);

    await h.executor.approve(runId);
    await h.executor.settle(runId);

    expect(getRun(h.db.db, runId)?.status).toBe("succeeded");
    expect(dns.creates).toHaveLength(0);
    expect(findDnsWrite(h.db.db, { name: DKIM_RECORD_NAME, type: "TXT" })).toBeNull();
    expect(await h.registered()).toBe(DOMAIN);
  });

  // mutant: publishDkimRecordStep does not verify current record against planned record
  it("fails at run time when post wants a different record content than planned", async () => {
    const dns = new FakeDnsProvider();
    dns.zones = [DKIM_ZONE];
    const dkimRecord = { name: DKIM_RECORD_NAME, type: "TXT", content: DKIM_RECORD_CONTENT };
    const post = fakePost({ dkimRecord });
    const h = await make({
      dkim: true,
      renders: DOMAIN,
      dns,
      post,
      answer: { status: 200, body: JSON.stringify({ domain: DOMAIN, signing: false }) },
      dkimWaitMs: 50,
      dkimPollMs: 5,
    });
    const { runId } = await h.executor.plan("tenant-set-sender-domain", { tenantId: "tnt_1", senderDomain: DOMAIN, previous: "" });
    dkimRecord.content = "v=DKIM1; p=changed";
    await h.executor.approve(runId);
    await h.executor.settle(runId);

    expect(getRun(h.db.db, runId)?.status).toBe("failed");
    expect(getRunEnding(h.db.db, runId)?.error).toContain("than the plan named");
    expect(dns.creates).toHaveLength(0);
  });

  // mutant: makeTenantSetSenderDomainDef preserves caller-supplied params.dkim
  it("ignores caller-supplied dkim parameter for a signed domain", async () => {
    const dns = new FakeDnsProvider();
    dns.zones = [DKIM_ZONE];
    const h = await make({
      dkim: true,
      renders: DOMAIN,
      dns,
      answer: { status: 200, body: JSON.stringify({ domain: DOMAIN, signing: true }) },
    });
    const { runId } = await h.executor.plan("tenant-set-sender-domain", {
      tenantId: "tnt_1",
      senderDomain: DOMAIN,
      previous: "",
      dkim: { name: "evil._domainkey.customer.test", content: "x", zone: DKIM_ZONE },
    } as unknown as TenantSetSenderDomainParams);

    expect(getRunParams(h.db.db, runId)?.params.dkim).toBeUndefined();
    await h.executor.approve(runId);
    await h.executor.settle(runId);

    expect(getRun(h.db.db, runId)?.status).toBe("succeeded");
    expect(dns.creates).toHaveLength(0);
  });

  // mutant: awaitDkimSigningStep ignores check error status and waits for deadline
  it("fails immediately when post's check answers 401", async () => {
    const dns = new FakeDnsProvider();
    dns.zones = [DKIM_ZONE];
    const post = fakePost({ checkStatus: 401 });
    const h = await make({
      dkim: true,
      renders: DOMAIN,
      dns,
      post,
      answer: { status: 200, body: JSON.stringify({ domain: DOMAIN, signing: false }) },
      dkimWaitMs: 60_000,
      dkimPollMs: 5,
    });
    const start = Date.now();
    const runId = await set(h, DOMAIN);
    expect(Date.now() - start).toBeLessThan(5000);

    expect(getRun(h.db.db, runId)?.status).toBe("failed");
    const ending = getRunEnding(h.db.db, runId);
    expect(ending?.error).toContain(DKIM_CHECK_URL);
    expect(ending?.error).toContain("401");
  });

  // mutant: planDkimRecord throws generic error instead of preserving original refusal when route is missing
  it("refuses at plan with unsigned refusal when senderDomainDkim is not declared", async () => {
    const h = await make({
      dkim: false,
      answer: { status: 200, body: JSON.stringify({ domain: DOMAIN, signing: false }) },
    });
    await expect(h.executor.plan("tenant-set-sender-domain", { tenantId: "tnt_1", senderDomain: DOMAIN, previous: "" }))
      .rejects.toThrow("is not signed yet");
  });
});
