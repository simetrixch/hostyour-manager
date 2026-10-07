import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDb, type DbHandle } from "../../db/client.ts";
import { findDnsWrite, recordDnsWrite } from "../../db/dns-writes.ts";
import { FakeDnsProvider } from "../../adapters/dns/testing/fake.ts";
import { makeMailDmarcPublishDef, withReportMailbox, type MailDmarcPublishParams } from "./defs/mail-dmarc-publish.ts";
import type { Cleanup, StepCtx } from "../../executor/types.ts";
import type { CredentialStore } from "../../security/store.ts";
import type { Logger } from "../../kernel/logger.ts";

let db: DbHandle;
beforeEach(() => { db = openDb(":memory:"); });
afterEach(() => { db.sqlite.close(); });

function ctx(logs: string[], params: MailDmarcPublishParams, cleanups?: Cleanup[]): StepCtx {
  return {
    runId: "run_mail_dmarc", stepName: "write-dmarc", db: db.db, creds: {} as unknown as CredentialStore, params: { ...params },
    secrets: { get: () => undefined, wipe: () => undefined }, signal: new AbortController().signal, logger: {} as unknown as Logger,
    ssh: () => Promise.reject(new Error("no ssh")), openPasswordSession: () => Promise.reject(new Error("no ssh")),
    closePasswordSession: () => undefined, attest: () => Promise.reject(new Error("no attest")),
    log: (_s, t) => logs.push(t), checkpoint: () => undefined, readCheckpoint: () => undefined,
    registerCleanup: (c) => cleanups?.push(c),
  };
}

describe("withReportMailbox", () => {
  it("keeps tag order and every other tag", () => {
    const original = "v=DMARC1; p=quarantine; pct=50; rua=mailto:old@example.net";
    expect(withReportMailbox(original, "new@example.net")).toBe(
      "v=DMARC1; p=quarantine; pct=50; rua=mailto:new@example.net",
    );
  });

  it("finds RUA= in upper case", () => {
    const original = "v=DMARC1; p=none; RUA=mailto:old@example.net; sp=none";
    expect(withReportMailbox(original, "new@example.net")).toBe(
      "v=DMARC1; p=none; RUA=mailto:new@example.net; sp=none",
    );
  });

  it("throws when no rua tag stands", () => {
    expect(() => withReportMailbox("v=DMARC1; p=none", "new@example.net")).toThrow(
      /carries no rua tag; publish the domain's mail DNS instead/,
    );
  });

  it("throws when two rua tags stand", () => {
    expect(() => withReportMailbox("v=DMARC1; rua=mailto:a@example.com; rua=mailto:b@example.com", "new@example.net")).toThrow(
      /carries 2 rua tags — refusing to pick one to rewrite/,
    );
  });
});

describe("mail-dmarc-publish plan", () => {
  const PARAMS: MailDmarcPublishParams = { domain: "example.com", dmarcMailbox: "new@example.net" };
  const STANDING = "v=DMARC1; p=quarantine; pct=50; rua=mailto:old@example.net";

  function seedBooked(): void {
    recordDnsWrite(db.db, {
      name: "_dmarc.example.com",
      type: "TXT",
      content: STANDING,
      act: "inserted",
      owner: { kind: "mail", name: "example.com" },
      runId: "run_prev",
    });
  }

  it("returns a plan with targetKind self, targetId manager, and names what stands and what it becomes", async () => {
    seedBooked();
    const dns = new FakeDnsProvider();
    dns.seed("_dmarc.example.com", "TXT", STANDING);
    const plan = await makeMailDmarcPublishDef({ dns }).plan(PARAMS, { db: db.db });
    expect(plan.targetKind).toBe("self");
    expect(plan.targetId).toBe("manager");
    expect(plan.requiredSecrets).toEqual([]);
    expect(plan.steps.map((s) => s.name)).toEqual(["attest-target", "write-dmarc"]);
    expect(plan.summary).toContain("Change the report mailbox of _dmarc.example.com");
    expect(plan.summary).toContain(STANDING);
    expect(plan.summary).toContain("v=DMARC1; p=quarantine; pct=50; rua=mailto:new@example.net");
  });

  it("is refused at the plan for a domain the book holds no DMARC row of", async () => {
    const dns = new FakeDnsProvider();
    dns.seed("_dmarc.example.com", "TXT", STANDING);
    await expect(makeMailDmarcPublishDef({ dns }).plan(PARAMS, { db: db.db })).rejects.toThrow(
      /the book of DNS writes holds no DMARC record of example\.com that a run of this Manager published/,
    );
  });

  it("is refused for a row whose owner is not mail/that domain", async () => {
    recordDnsWrite(db.db, {
      name: "_dmarc.example.com",
      type: "TXT",
      content: STANDING,
      act: "inserted",
      owner: { kind: "installer", name: "example.com" },
      runId: "run_prev",
    });
    const dns = new FakeDnsProvider();
    dns.seed("_dmarc.example.com", "TXT", STANDING);
    await expect(makeMailDmarcPublishDef({ dns }).plan(PARAMS, { db: db.db })).rejects.toThrow(
      /the book of DNS writes holds no DMARC record of example\.com that a run of this Manager published/,
    );

    recordDnsWrite(db.db, {
      name: "_dmarc.example.com",
      type: "TXT",
      content: STANDING,
      act: "inserted",
      owner: { kind: "mail", name: "other.com" },
      runId: "run_prev",
    });
    await expect(makeMailDmarcPublishDef({ dns }).plan(PARAMS, { db: db.db })).rejects.toThrow(
      /the book of DNS writes holds no DMARC record of example\.com that a run of this Manager published/,
    );
  });

  it("is refused when two TXT stand under _dmarc.example.com", async () => {
    seedBooked();
    const dns = new FakeDnsProvider();
    dns.seed("_dmarc.example.com", "TXT", STANDING, "v=DMARC1; p=none; rua=mailto:other@example.net");
    await expect(makeMailDmarcPublishDef({ dns }).plan(PARAMS, { db: db.db })).rejects.toThrow(
      /2 TXT records stand under _dmarc\.example\.com — refusing to pick one to rewrite/,
    );
  });

  it("is refused when the standing record has no rua tag", async () => {
    seedBooked();
    const dns = new FakeDnsProvider();
    dns.seed("_dmarc.example.com", "TXT", "v=DMARC1; p=none");
    await expect(makeMailDmarcPublishDef({ dns }).plan(PARAMS, { db: db.db })).rejects.toThrow(
      /carries no rua tag; publish the domain's mail DNS instead/,
    );
  });
});

describe("mail-dmarc-publish steps", () => {
  const PARAMS: MailDmarcPublishParams = { domain: "example.com", dmarcMailbox: "new@example.net" };
  const STANDING = "v=DMARC1; p=quarantine; pct=50; rua=mailto:old@example.net";
  const UPDATED = "v=DMARC1; p=quarantine; pct=50; rua=mailto:new@example.net";
  const SPF = "v=spf1 ip4:203.0.113.9 -all";
  const NEIGHBOUR = "MS=ms12345678";

  it("rewrites the DMARC record, updates the book of writes, and leaves apex SPF and neighbour TXT unchanged", async () => {
    const dns = new FakeDnsProvider();
    dns.seed("_dmarc.example.com", "TXT", STANDING);
    dns.seed("example.com", "TXT", NEIGHBOUR, SPF);
    recordDnsWrite(db.db, {
      name: "_dmarc.example.com",
      type: "TXT",
      content: STANDING,
      act: "inserted",
      owner: { kind: "mail", name: "example.com" },
      runId: "run_prev",
    });

    const logs: string[] = [];
    const cleanups: Cleanup[] = [];
    const def = makeMailDmarcPublishDef({ dns });
    for (const step of def.steps(PARAMS)) {
      await step.run(ctx(logs, PARAMS, cleanups));
    }

    expect(await dns.listRecordContents({ name: "_dmarc.example.com", type: "TXT" })).toEqual([UPDATED]);
    expect(await dns.listRecordContents({ name: "example.com", type: "TXT" })).toEqual([NEIGHBOUR, SPF]);

    const bookRow = findDnsWrite(db.db, { name: "_dmarc.example.com", type: "TXT" });
    expect(bookRow).not.toBeNull();
    expect(bookRow?.content).toBe(UPDATED);
    expect(bookRow?.act).toBe("updated");
    expect(bookRow?.owner).toEqual({ kind: "mail", name: "example.com" });

    // Re-running the write step after it succeeded writes nothing (upserts count unchanged)
    const upsertsBefore = dns.upserts.length;
    const writeStep = def.steps(PARAMS)[1]!;
    await writeStep.run(ctx(logs, PARAMS));
    expect(dns.upserts.length).toBe(upsertsBefore);
    expect(logs).toContain("TXT _dmarc.example.com already stands");

    // Cleanups: compensating action restores the original content
    expect(cleanups.length).toBe(1);
    await cleanups[0]!.run(ctx(logs, PARAMS));
    expect(await dns.listRecordContents({ name: "_dmarc.example.com", type: "TXT" })).toEqual([STANDING]);
    const restoredRow = findDnsWrite(db.db, { name: "_dmarc.example.com", type: "TXT" });
    expect(restoredRow?.content).toBe(STANDING);
  });
});

describe("mail-dmarc-publish re-entered after a crash", () => {
  const PARAMS: MailDmarcPublishParams = { domain: "example.com", dmarcMailbox: "new@example.net" };
  const STANDING = "v=DMARC1; p=none; rua=mailto:old@example.net";
  const UPDATED = "v=DMARC1; p=none; rua=mailto:new@example.net";

  it("completes the book and the undo from its checkpoint when its own write already stands", async () => {
    const dns = new FakeDnsProvider();
    // The write reached the provider; the crash came before the book learned it.
    dns.seed("_dmarc.example.com", "TXT", UPDATED);
    recordDnsWrite(db.db, { name: "_dmarc.example.com", type: "TXT", content: STANDING, act: "inserted", owner: { kind: "mail", name: "example.com" }, runId: "run_prev" });
    const logs: string[] = [];
    const cleanups: Cleanup[] = [];
    const reentered: StepCtx = { ...ctx(logs, PARAMS, cleanups), readCheckpoint: <T>() => ({ stood: STANDING, next: UPDATED }) as T };

    await makeMailDmarcPublishDef({ dns }).steps(PARAMS)[1]!.run(reentered);

    expect(dns.upserts).toEqual([]);
    expect(findDnsWrite(db.db, { name: "_dmarc.example.com", type: "TXT" })?.content).toBe(UPDATED);
    expect(cleanups).toHaveLength(1);
    await cleanups[0]!.run(ctx(logs, PARAMS));
    expect(await dns.listRecordContents({ name: "_dmarc.example.com", type: "TXT" })).toEqual([STANDING]);
  });

  it("leaves a record a hand changed after the write when the run is aborted", async () => {
    const dns = new FakeDnsProvider();
    dns.seed("_dmarc.example.com", "TXT", STANDING);
    recordDnsWrite(db.db, { name: "_dmarc.example.com", type: "TXT", content: STANDING, act: "inserted", owner: { kind: "mail", name: "example.com" }, runId: "run_prev" });
    const logs: string[] = [];
    const cleanups: Cleanup[] = [];
    await makeMailDmarcPublishDef({ dns }).steps(PARAMS)[1]!.run(ctx(logs, PARAMS, cleanups));
    const handChanged = "v=DMARC1; p=reject; rua=mailto:someone@example.net";
    await dns.upsertRecord({ name: "_dmarc.example.com", type: "TXT", content: handChanged });

    await cleanups[0]!.run(ctx(logs, PARAMS));

    expect(await dns.listRecordContents({ name: "_dmarc.example.com", type: "TXT" })).toEqual([handChanged]);
  });
});
