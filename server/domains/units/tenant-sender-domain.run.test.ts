import { describe, it, expect, afterEach } from "vitest";
import { rmSync } from "node:fs";
import type { DbHandle } from "../../db/client.ts";
import { getRun, readEvents } from "../../executor/read.ts";
import {
  GUID,
  DOMAIN,
  ASKED,
  ISSUER,
  OTHER_ISSUER,
  KEPT,
  BOUND_AT,
  fakePost,
  make as makeFixture,
  set,
  type MakeOptions,
} from "./tenant-sender-domain.fixture.ts";
import { testMembers, TEST_QUOTA } from "./tenant-members.fixture.ts";

describe("tenant-set-sender-domain through the Executor", () => {
  const handles: DbHandle[] = [];
  const dirs: string[] = [];
  afterEach(() => {
    for (const h of handles.splice(0)) h.sqlite.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  const make = (opts: MakeOptions = {}) => makeFixture(opts, handles, dirs);

  it("asks the product's check at the tenant's stage apex, then records the domain and waits for every member", async () => {
    const h = await make({ renders: DOMAIN });
    const runId = await set(h, DOMAIN);
    expect(getRun(h.db.db, runId)?.status).toBe("succeeded");
    expect(h.probe.probed).toEqual([ASKED]);
    expect(h.row()).toBe(DOMAIN);
    expect(await h.registered()).toBe(DOMAIN);
  });

  it("clears the domain without asking anything", async () => {
    const h = await make({ senderDomain: DOMAIN, renders: "" });
    const runId = await set(h, "", DOMAIN);
    expect(getRun(h.db.db, runId)?.status).toBe("succeeded");
    expect(h.probe.probed).toEqual([]);
    expect(h.row()).toBe("");
  });

  it("does not take Synced for the new domain: an old render fails the wait, and the abort writes the previous one back", async () => {
    const h = await make({ renders: "" });
    const runId = await set(h, DOMAIN);
    expect(getRun(h.db.db, runId)?.status).toBe("failed");
    expect(h.row()).toBe(DOMAIN);
    await h.executor.abortWithCleanup(runId);
    await h.executor.settle(runId);
    expect(getRun(h.db.db, runId)?.status).toBe("cancelled");
    expect(h.row()).toBe("");
    expect(await h.registered()).toBe("");
  });

  it("PLANTED DEFECT: an abort after the registration was written and the row update failed writes the previous domain back to both", async () => {
    const h = await make();
    // The row update fails once the registration carries the new domain: the process dying between the two acts.
    h.db.sqlite.exec("CREATE TRIGGER planted_row_failure BEFORE UPDATE OF sender_domain ON tenants BEGIN SELECT RAISE(ABORT, 'planted row failure'); END");
    const runId = await set(h, DOMAIN);
    expect(getRun(h.db.db, runId)?.status).toBe("failed");
    expect([await h.registered(), h.row()]).toEqual([DOMAIN, ""]);
    h.db.sqlite.exec("DROP TRIGGER planted_row_failure");
    await h.executor.abortWithCleanup(runId);
    await h.executor.settle(runId);
    expect([await h.registered(), h.row()]).toEqual(["", ""]);
  });

  it("PLANTED INNOCENT: an abort leaves a domain another writer registered since as it is", async () => {
    const h = await make({ renders: "" });
    const runId = await set(h, DOMAIN);
    expect(getRun(h.db.db, runId)?.status).toBe("failed");
    await h.reg.setSenderDomain("prod", GUID, "other.test", "run_other");
    await h.executor.abortWithCleanup(runId);
    await h.executor.settle(runId);
    expect(await h.registered()).toBe("other.test");
  });

  describe("the stage's service issuer at the product's mail service", () => {
    it("binds it beside the issuers already there before the registration is written, with the kept key", async () => {
      const lists: Record<string, string[]> = { [DOMAIN]: [OTHER_ISSUER] };
      const h = await make({ issuers: true, renders: DOMAIN, post: fakePost(lists) });
      const runId = await set(h, DOMAIN);
      expect(getRun(h.db.db, runId)?.status).toBe("succeeded");
      expect(h.post.calls).toEqual([{ method: "PUT", url: BOUND_AT(DOMAIN), key: KEPT, body: { issuer: ISSUER } }]);
      expect(lists[DOMAIN]).toEqual([OTHER_ISSUER, ISSUER]);
      expect(getRun(h.db.db, runId)?.steps.map((st) => st.name)).toEqual([
        "attest-target",
        "publish-dkim-record",
        "publish-dmarc-record",
        "await-dkim-signing",
        "bind-issuer",
        "write-sender-domain",
        "watch-members",
        "unbind-previous-issuer",
      ]);
    });

    it("an abort takes back only the issuer this run added", async () => {
      const lists: Record<string, string[]> = { [DOMAIN]: [OTHER_ISSUER] };
      const h = await make({ issuers: true, renders: "", post: fakePost(lists) });
      const runId = await set(h, DOMAIN);
      expect(getRun(h.db.db, runId)?.status).toBe("failed");
      await h.executor.abortWithCleanup(runId);
      await h.executor.settle(runId);
      expect(getRun(h.db.db, runId)?.status).toBe("cancelled");
      expect(lists[DOMAIN]).toEqual([OTHER_ISSUER]);
      expect(await h.registered()).toBe("");
    });

    it("PLANTED INNOCENT: an abort leaves an issuer the domain already named before the run", async () => {
      const lists: Record<string, string[]> = { [DOMAIN]: [ISSUER] };
      const h = await make({ issuers: true, renders: "", post: fakePost(lists) });
      const runId = await set(h, DOMAIN);
      await h.executor.abortWithCleanup(runId);
      await h.executor.settle(runId);
      expect(lists[DOMAIN]).toEqual([ISSUER]);
    });

    it("moving to another domain binds it there and, once every member renders it, takes it from the previous one", async () => {
      const lists: Record<string, string[]> = { "old.test": [ISSUER, OTHER_ISSUER], [DOMAIN]: [] };
      const h = await make({ issuers: true, senderDomain: "old.test", renders: DOMAIN, post: fakePost(lists) });
      const runId = await set(h, DOMAIN, "old.test");
      expect(getRun(h.db.db, runId)?.status).toBe("succeeded");
      expect(h.post.calls.map((c) => [c.method, c.url])).toEqual([["PUT", BOUND_AT(DOMAIN)], ["DELETE", BOUND_AT("old.test")]]);
      expect(lists).toEqual({ "old.test": [OTHER_ISSUER], [DOMAIN]: [ISSUER] });
    });

    it("clearing the domain binds nothing and takes the issuer from the former domain; a product without the route is never called", async () => {
      const lists: Record<string, string[]> = { [DOMAIN]: [ISSUER] };
      const h = await make({ issuers: true, senderDomain: DOMAIN, renders: "", post: fakePost(lists) });
      expect(getRun(h.db.db, await set(h, "", DOMAIN))?.status).toBe("succeeded");
      expect(h.post.calls.map((c) => c.method)).toEqual(["DELETE"]);
      expect(lists[DOMAIN]).toEqual([]);
      const plain = await make({ renders: DOMAIN });
      expect(getRun(plain.db.db, await set(plain, DOMAIN))?.status).toBe("succeeded");
      expect(plain.post.calls).toEqual([]);
    });

    it("asks once more after a race inside the product (409)", async () => {
      const lists: Record<string, string[]> = {};
      const h = await make({ issuers: true, renders: DOMAIN, post: fakePost(lists, [409]) });
      expect(getRun(h.db.db, await set(h, DOMAIN))?.status).toBe("succeeded");
      expect(h.post.calls).toHaveLength(2);
      expect(lists[DOMAIN]).toEqual([ISSUER]);
    });

    it("refuses at the plan without a kept key, and fails naming the repair when the product refuses the key or holds none", async () => {
      await expect(set(await make({ issuers: true, kept: false }), DOMAIN)).rejects.toThrow(/keeps no key for post \(prod\).*"Secrets…" on post \(prod\)/);
      const clearing = await make({ issuers: true, senderDomain: DOMAIN, kept: false });
      await expect(set(clearing, "", DOMAIN)).rejects.toThrow(/keeps no key for post \(prod\)/);
      expect([await clearing.registered(), clearing.row()]).toEqual([DOMAIN, DOMAIN]);
      for (const [status, says] of [[401, /refused the key the Manager keeps for it \(401\)/], [503, /holds no Manager key yet \(503\)/], [404, /does not know customer\.test as a sender domain/], [200, /answered 200 without "added"/]] as const) {
        const h = await make({ issuers: true, renders: DOMAIN, post: fakePost({}, [status]) });
        const runId = await set(h, DOMAIN);
        expect(getRun(h.db.db, runId)?.status).toBe("failed");
        expect(readEvents(h.db.db, runId).map((e) => e.text).join("\n")).toMatch(says);
        expect(await h.registered()).toBe("");
      }
    });
  });

  it("refuses a domain whose mail is not signed, one the product does not know, and a product that declares no check", async () => {
    const plan = (h: Awaited<ReturnType<typeof make>>) => h.executor.plan("tenant-set-sender-domain", { tenantId: "tnt_1", senderDomain: DOMAIN, previous: "" });
    await expect(plan(await make({ answer: { status: 200, body: JSON.stringify({ domain: DOMAIN, signing: false }) } }))).rejects.toThrow(/is not signed yet/);
    await expect(plan(await make({ answer: { status: 404 } }))).rejects.toThrow(/does not know customer\.test/);
    await expect(plan(await make({ answer: { status: 200, body: "<html>" } }))).rejects.toThrow(/answered no JSON/);
    await expect(plan(await make({ check: null }))).rejects.toThrow(/declares no senderDomainCheck/);
  });

  it("refuses a request whose previous domain moved, and a suspended tenant", async () => {
    const h = await make({ senderDomain: "other.test" });
    await expect(h.executor.plan("tenant-set-sender-domain", { tenantId: "tnt_1", senderDomain: DOMAIN, previous: "" })).rejects.toThrow(/sends as other\.test/);
    const s = await make({ suspended: true });
    await expect(s.executor.plan("tenant-set-sender-domain", { tenantId: "tnt_1", senderDomain: DOMAIN, previous: "" })).rejects.toThrow(/suspended/);
  });

  it("refuses a sender domain another tenant of the same stage sends from, naming it", async () => {
    const h = await make();
    const otherGuid = "e2e8ymj86dk8";
    await h.reg.commitTenant({
      stage: "prod",
      guid: otherGuid,
      runId: "run_other",
      registration: {
        cluster: "s1",
        subdomain: "other",
        apps: [],
        members: testMembers(),
        identityProvider: "auth",
        ownDomain: "",
        ownDomainRedirects: [],
        approvedTags: {},
        senderDomain: DOMAIN,
        displayName: "",
        seedUsers: false,
        quota: TEST_QUOTA,
        resetNonce: "1",
        suspended: false,
        quiesced: false,
        appsImage: "",
        appsImageTag: "",
      },
    });
    await expect(
      h.executor.plan("tenant-set-sender-domain", { tenantId: "tnt_1", senderDomain: DOMAIN, previous: "" }),
    ).rejects.toThrow("tenant acme cannot send as customer.test — tenant other of prod already sends from it; a stage's tenants send from different domains");
  });

  it("PLANTED DEFECT: refuses in the write step a domain another tenant took after the plan", async () => {
    // The plan passed; another tenant of the stage takes the domain before this run writes. The step
    // asks again under the tenant locks, so the run fails instead of giving the domain away twice.
    const h = await make({ renders: DOMAIN });
    const { runId } = await h.executor.plan("tenant-set-sender-domain", { tenantId: "tnt_1", senderDomain: DOMAIN, previous: "" });
    await h.reg.commitTenant({
      stage: "prod", guid: "e2e8ymj86dk8", runId: "run_other",
      registration: {
        cluster: "s1", subdomain: "other", apps: [], members: testMembers(), identityProvider: "auth",
        ownDomain: "", ownDomainRedirects: [], approvedTags: {}, senderDomain: DOMAIN, displayName: "", seedUsers: false,
        quota: TEST_QUOTA, resetNonce: "1", suspended: false, quiesced: false, appsImage: "", appsImageTag: "",
      },
    });
    await h.executor.approve(runId);
    await h.executor.settle(runId);
    expect(getRun(h.db.db, runId)?.status).toBe("failed");
    expect(await h.registered()).not.toBe(DOMAIN);
    expect(h.row()).toBe("");
  });

  it("plans a tenant re-applying the sender domain it already sends from", async () => {
    // Its own registration carries the domain: only ANOTHER tenant's makes it taken.
    const h = await make({ senderDomain: DOMAIN });
    await expect(h.executor.plan("tenant-set-sender-domain", { tenantId: "tnt_1", senderDomain: DOMAIN, previous: DOMAIN })).resolves.toBeDefined();
  });

  it("plans a sender domain that another tenant sends from at another stage", async () => {
    const h = await make();
    const otherGuid = "e2e8ymj86dk8";
    await h.reg.commitTenant({
      stage: "test",
      guid: otherGuid,
      runId: "run_other_test",
      registration: {
        cluster: "s1",
        subdomain: "other",
        apps: [],
        members: testMembers(),
        identityProvider: "auth",
        ownDomain: "",
        ownDomainRedirects: [],
        approvedTags: {},
        senderDomain: DOMAIN,
        displayName: "",
        seedUsers: false,
        quota: TEST_QUOTA,
        resetNonce: "1",
        suspended: false,
        quiesced: false,
        appsImage: "",
        appsImageTag: "",
      },
    });
    const { runId } = await h.executor.plan("tenant-set-sender-domain", { tenantId: "tnt_1", senderDomain: DOMAIN, previous: "" });
    expect(runId).toMatch(/^run_/);
  });

  it("plans clearing the sender domain to empty", async () => {
    const h = await make({ senderDomain: DOMAIN });
    const { runId } = await h.executor.plan("tenant-set-sender-domain", { tenantId: "tnt_1", senderDomain: "", previous: DOMAIN });
    expect(runId).toMatch(/^run_/);
  });
});
