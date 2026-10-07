import { describe, it, expect, afterEach } from "vitest";
import { listDnsWrites } from "../../db/dns-writes.ts";
import { FakeDnsProvider } from "../../adapters/dns/testing/fake.ts";
import type { Step, StepCtx } from "../../executor/types.ts";
import type { CredentialStore } from "../../security/store.ts";
import type { Logger } from "../../kernel/logger.ts";
import { makeHarness, disposeHarnesses, seedMasterCluster, MASTER_ID, type Harness } from "./deploy-slave.fixture.ts";
import { MASTER_FQDN } from "./cluster-maps.fixture.ts";
import { ANSIWISE_ELEVATION_SECRET } from "./defs/ansiwise-run.kit.ts";
import type { MailEgress } from "../../../shared/mail.ts";
import { bookedTxtProgramStep, type MailDnsPublishPorts } from "./defs/mail-dns-publish.ts";
import { MailDkimPublishParams, makeMailDkimPublishDef, platformDkimAnswers, platformDkimBooking } from "./defs/mail-dkim-publish.ts";

// mail-dkim-publish runs publish-mail-dkim on the master for the platform domain, whose other mail
// records belong to its own mail service. What these tests hold: the run writes the one record under
// the signing stage's selector with the key the stage's mail sender signs with; it takes no domain,
// so it can name nothing but the platform domain; and the book learns that one record and nothing of
// the apex, the DMARC policy or the mail service's own selectors.

/** The fixture map's platformDomain is example.com. */
const KEY = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAplatform";
const PARAMS: MailDkimPublishParams = { serverId: MASTER_ID, stage: "test" };
const DKIM_NAME = "test._domainkey.example.com";
const DKIM = `v=DKIM1; k=rsa; p=${KEY}`;
/** The names the domain's own mail service keeps, which no write of this run may reach. */
const SERVICE_NAMES = ["example.com", "_dmarc.example.com", "selector1._domainkey.example.com", "selector2._domainkey.example.com", "autodiscover.example.com"];

afterEach(disposeHarnesses);

function ports(h: Harness, over: Partial<MailDnsPublishPorts> = {}): MailDnsPublishPorts {
  return { ...h.runPorts, ...over };
}

/** The Mail page's reading, scripted: the stage's sender and the key it signs with. */
function egressOf(over: Partial<MailEgress> = {}): NonNullable<MailDnsPublishPorts["mailEgress"]> {
  return async () => ({ sender: { unit: "post", cluster: "a1.example.com" }, name: "a1.example.com", address: "203.0.113.9", host: "mail.example.org", dkimPublicKey: KEY, ...over });
}

function ctx(h: Harness, logs: string[]): StepCtx {
  let slot: unknown;
  return {
    runId: "run_dkim", stepName: "run-publish-mail-dkim", db: h.db.db, creds: {} as unknown as CredentialStore, params: { ...PARAMS },
    secrets: { get: () => undefined, wipe: () => undefined }, signal: new AbortController().signal, logger: {} as unknown as Logger,
    ssh: () => Promise.reject(new Error("no ssh")), openPasswordSession: () => Promise.reject(new Error("no ssh")),
    closePasswordSession: () => undefined, attest: () => Promise.reject(new Error("no attest")),
    log: (_s, t) => logs.push(t), checkpoint: (d) => { slot = d; }, readCheckpoint: <T,>() => slot as T | undefined, registerCleanup: () => undefined,
  };
}

/** What the program leaves in the zone, played by a step that writes the fake provider. */
function programWriting(write: () => void): Step {
  return { name: "run-publish-mail-dkim", title: "the program", run: async () => { write(); } };
}

describe("mail-dkim-publish plan", () => {
  it("stands on the master and names the one record it writes under the signing stage's selector", async () => {
    const h = await makeHarness();
    seedMasterCluster(h);
    const plan = await makeMailDkimPublishDef(ports(h, { mailEgress: egressOf() })).plan(PARAMS, { db: h.db.db });
    expect(plan.steps.map((s) => s.name)).toEqual(["attest-target", "run-publish-mail-dkim"]);
    expect(plan.requiredSecrets).toEqual([ANSIWISE_ELEVATION_SECRET]);
    expect(plan.summary).toContain(`Publish the DKIM key the mail sender post signs example.com's mail with at test, under ${DKIM_NAME}`);
    expect(plan.summary).toContain("its apex SPF, its MX, its mail service's own DKIM selectors and its DMARC policy stay that service's");
  });

  it("refuses a stage where no unit sends, and a sender that holds no key, naming the unit", async () => {
    const h = await makeHarness();
    seedMasterCluster(h);
    await expect(makeMailDkimPublishDef(ports(h, { mailEgress: egressOf({ sender: null, dkimPublicKey: null }) })).plan(PARAMS, { db: h.db.db }))
      .rejects.toThrow(/no unit declares an SMTP entry at test: nothing signs example\.com's mail with a key of its own/);
    await expect(makeMailDkimPublishDef(ports(h, { mailEgress: egressOf({ dkimPublicKey: null }) })).plan(PARAMS, { db: h.db.db }))
      .rejects.toThrow(/the mail sender post at test holds no DKIM public key/);
    await expect(makeMailDkimPublishDef(ports(h)).plan(PARAMS, { db: h.db.db })).rejects.toThrow(/no mail reading is wired/);
  });

  it("PLANTED: takes no domain and no selector but a stage, so neither the mail service's selectors nor another domain can be named", () => {
    expect(MailDkimPublishParams.safeParse({ ...PARAMS, stage: "selector1" }).success).toBe(false);
    expect(MailDkimPublishParams.strict().safeParse({ ...PARAMS, senderDomain: "example.org" }).success).toBe(false);
    expect(Object.keys(MailDkimPublishParams.shape).sort()).toEqual(["serverId", "stage"]);
  });
});

describe("what publish-mail-dkim is answered with", () => {
  it("the map's platform domain, the stage as the selector and the key the stage's sender signs with", async () => {
    const h = await makeHarness();
    seedMasterCluster(h);
    const logs: string[] = [];
    expect(await platformDkimAnswers(PARAMS, ports(h, { mailEgress: egressOf() }))(ctx(h, logs)))
      .toEqual({ mail_domain: "example.com", dkim_selector: "test", dkim_public_key: KEY });
    expect(logs.join(" ")).toContain("publish-mail-dkim is told mail_domain=example.com, dkim_selector=test, the public key of post");
  });
});

describe("what the book of DNS writes learns from the DKIM publish", () => {
  it("a selector with no key: the record is inserted, owned by the platform domain, by this run", async () => {
    const h = await makeHarness();
    seedMasterCluster(h);
    const dns = new FakeDnsProvider();
    await bookedTxtProgramStep({ dns }, MASTER_ID, platformDkimBooking(ports(h), "test"), programWriting(() => dns.seed(DKIM_NAME, "TXT", DKIM))).run(ctx(h, []));
    expect(listDnsWrites(h.db.db).map((r) => `${r.act} ${r.type} ${r.name} → ${r.content} for ${r.owner.kind} ${r.owner.name} by ${r.runId}`))
      .toEqual([`inserted TXT ${DKIM_NAME} → ${DKIM} for mail example.com by run_dkim`]);
  });

  it("PLANTED INNOCENT: the mail service's apex SPF, DMARC and selectors are neither read as written nor booked", async () => {
    const h = await makeHarness();
    seedMasterCluster(h);
    const dns = new FakeDnsProvider();
    await bookedTxtProgramStep({ dns }, MASTER_ID, platformDkimBooking(ports(h), "test"), programWriting(() => {
      dns.seed(DKIM_NAME, "TXT", DKIM);
      // A program that also changed the service's records would show up here; this booking does not look there.
      dns.seed("example.com", "TXT", "v=spf1 ip4:198.51.100.4 -all");
      dns.seed("_dmarc.example.com", "TXT", "v=DMARC1; p=reject");
      dns.seed("selector1._domainkey.example.com", "TXT", "v=DKIM1; k=rsa; p=MIIBother");
    })).run(ctx(h, []));
    expect(listDnsWrites(h.db.db).map((r) => r.name)).toEqual([DKIM_NAME]);
  });

  it("books exactly the stage's selector for every stage, and never a name the mail service keeps", async () => {
    const h = await makeHarness();
    seedMasterCluster(h);
    for (const stage of ["dev", "test", "prod"] as const) {
      const { owner, published } = await platformDkimBooking(ports(h), stage)({ domain: MASTER_FQDN, stage: "prod" });
      expect(owner).toBe("example.com");
      expect(published.map((p) => p.name)).toEqual([`${stage}._domainkey.example.com`]);
      for (const name of SERVICE_NAMES) expect(published.map((p) => p.name)).not.toContain(name);
    }
  });
});
