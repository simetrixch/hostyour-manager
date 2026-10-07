import { describe, it, expect, afterEach } from "vitest";
import { clusters } from "../../db/schema/inventory.ts";
import { listDnsWrites } from "../../db/dns-writes.ts";
import { FakeDnsProvider } from "../../adapters/dns/testing/fake.ts";
import type { Step, StepCtx } from "../../executor/types.ts";
import type { CredentialStore } from "../../security/store.ts";
import type { Logger } from "../../kernel/logger.ts";
import { makeHarness, disposeHarnesses, seedMasterCluster, MASTER_ID, SLAVE_ID, type Harness } from "./deploy-slave.fixture.ts";
import { MASTER_FQDN } from "./cluster-maps.fixture.ts";
import { ANSIWISE_ELEVATION_SECRET } from "./defs/ansiwise-run.kit.ts";
import type { MailEgress } from "../../../shared/mail.ts";
import { bookedTxtProgramStep, type MailDnsPublishPorts } from "./defs/mail-dns-publish.ts";
import { envelopeSpfAnswers, envelopeSpfBooking, makeMailEnvelopeSpfPublishDef, type MailEnvelopeSpfPublishParams } from "./defs/mail-envelope-spf-publish.ts";

// mail-envelope-spf-publish runs publish-envelope-spf on the master for the envelope sender's name under
// the platform domain. What these tests hold: the plan stands only on a master and names that one name;
// the program is answered with the name and the egress address the Mail page reads, never typed; and
// the book of DNS writes learns the SPF the program wrote there, and nothing of the platform domain's
// apex, as a mail record of the platform domain.

const EGRESS = "203.0.113.9";
/** The fixture map's platformDomain is example.com. */
const ENVELOPE = "mail.example.com";
const PARAMS: MailEnvelopeSpfPublishParams = { serverId: MASTER_ID };
const SPF = `v=spf1 ip4:${EGRESS} -all`;

afterEach(disposeHarnesses);

function ports(h: Harness, over: Partial<MailDnsPublishPorts> = {}): MailDnsPublishPorts {
  return { ...h.runPorts, ...over };
}

/** The Mail page's reading, scripted: without a sender, mail leaves by the master's identity. */
function egressOf(over: Partial<MailEgress> = {}): NonNullable<MailDnsPublishPorts["mailEgress"]> {
  return async (_stage, masterDomain) => ({ sender: null, name: masterDomain, address: EGRESS, host: "mail.example.org", dkimPublicKey: null, ...over });
}

function ctx(h: Harness, logs: string[]): StepCtx {
  let slot: unknown;
  return {
    runId: "run_envelope", stepName: "run-publish-envelope-spf", db: h.db.db, creds: {} as unknown as CredentialStore, params: { ...PARAMS },
    secrets: { get: () => undefined, wipe: () => undefined }, signal: new AbortController().signal, logger: {} as unknown as Logger,
    ssh: () => Promise.reject(new Error("no ssh")), openPasswordSession: () => Promise.reject(new Error("no ssh")),
    closePasswordSession: () => undefined, attest: () => Promise.reject(new Error("no attest")),
    log: (_s, t) => logs.push(t), checkpoint: (d) => { slot = d; }, readCheckpoint: <T,>() => slot as T | undefined, registerCleanup: () => undefined,
  };
}

/** What the program leaves in the zone, played by a step that writes the fake provider the way
 *  publish-envelope-spf writes Cloudflare: one SPF at the envelope name, nothing else. */
function programWriting(dns: FakeDnsProvider, spf: string): Step {
  return { name: "run-publish-envelope-spf", title: "the program", run: async () => { dns.seed(ENVELOPE, "TXT", spf); } };
}

describe("mail-envelope-spf-publish plan", () => {
  it("stands on the master and names the one record it writes: attest, then the program step, the elevation password required", async () => {
    const h = await makeHarness();
    seedMasterCluster(h);
    const plan = await makeMailEnvelopeSpfPublishDef(ports(h, { mailEgress: egressOf() })).plan(PARAMS, { db: h.db.db });
    expect(plan.steps.map((s) => s.name)).toEqual(["attest-target", "run-publish-envelope-spf"]);
    expect(plan.targets).toEqual([{ serverId: MASTER_ID, ownsHost: true, label: "m1 (master)" }]);
    expect(plan.requiredSecrets).toEqual([ANSIWISE_ELEVATION_SECRET]);
    expect(plan.summary).toContain(`Publish the SPF of ${ENVELOPE}`);
    expect(plan.summary).toContain("Nothing of example.com itself is touched");
  });

  it("with the host equal to the envelope name, the summary contains v=spf1 a -all", async () => {
    const h = await makeHarness();
    seedMasterCluster(h);
    const plan = await makeMailEnvelopeSpfPublishDef(ports(h, { mailEgress: egressOf({ host: ENVELOPE }) })).plan(PARAMS, { db: h.db.db });
    expect(plan.summary).toContain("v=spf1 a -all");
  });

  it("refuses an egress with host: null at the plan, naming the address", async () => {
    const h = await makeHarness();
    seedMasterCluster(h);
    await expect(makeMailEnvelopeSpfPublishDef(ports(h, { mailEgress: egressOf({ host: null }) })).plan(PARAMS, { db: h.db.db }))
      .rejects.toThrow(new RegExp(`${EGRESS} has no reverse DNS name that resolves back to it`));
  });

  it("refuses a slave: the DNS token is the master's", async () => {
    const h = await makeHarness();
    h.db.db.insert(clusters).values({ id: "cls_s1", serverId: SLAVE_ID, stage: "prod", domain: "s1.example.com", name: "s1", status: "active", slaveId: 1 }).run();
    await expect(makeMailEnvelopeSpfPublishDef(ports(h)).plan({ serverId: SLAVE_ID }, { db: h.db.db })).rejects.toThrow(/s1 is a slave — publish-envelope-spf runs on the master/);
  });
});

describe("what publish-envelope-spf is answered with", () => {
  it("the envelope name under the map's platform domain and the address mail leaves from, where the sender stands", async () => {
    const h = await makeHarness();
    seedMasterCluster(h);
    const logs: string[] = [];
    const sender = { sender: { unit: "post", cluster: "a1.example.com" }, name: "a1.example.com" };
    expect(await envelopeSpfAnswers(PARAMS, ports(h, { mailEgress: egressOf(sender) }))(ctx(h, logs))).toEqual({
      envelope_domain: ENVELOPE,
      egress_address: EGRESS,
      egress_host: "mail.example.org",
    });
    expect(logs.join(" ")).toContain(`envelope_domain=${ENVELOPE}, egress_address=${EGRESS} (a1.example.com, where the mail sender post stands), egress_host=mail.example.org`);
  });

  it("refuses where the name mail leaves by resolves to no address, and without the mail reading wired", async () => {
    const h = await makeHarness();
    seedMasterCluster(h);
    await expect(envelopeSpfAnswers(PARAMS, ports(h, { mailEgress: egressOf({ address: null }) }))(ctx(h, []))).rejects.toThrow(new RegExp(`${MASTER_FQDN.replaceAll(".", "\\.")} resolves to no address at public DNS`));
    await expect(envelopeSpfAnswers(PARAMS, ports(h))(ctx(h, []))).rejects.toThrow(/no mail reading is wired/);
  });

  it("refuses where the egress address has no forward-confirmed host", async () => {
    const h = await makeHarness();
    seedMasterCluster(h);
    await expect(envelopeSpfAnswers(PARAMS, ports(h, { mailEgress: egressOf({ host: null }) }))(ctx(h, [])))
      .rejects.toThrow(new RegExp(`${EGRESS} has no reverse DNS name that resolves back to it`));
  });
});

describe("what the book of DNS writes learns from the envelope publish", () => {
  it("an envelope name with no SPF: the record is inserted, owned by the platform domain, by this run", async () => {
    const h = await makeHarness();
    seedMasterCluster(h);
    const dns = new FakeDnsProvider();
    const logs: string[] = [];
    await bookedTxtProgramStep({ dns }, MASTER_ID, envelopeSpfBooking(ports(h)), programWriting(dns, SPF)).run(ctx(h, logs));
    expect(listDnsWrites(h.db.db).map((r) => `${r.act} ${r.type} ${r.name} → ${r.content} for ${r.owner.kind} ${r.owner.name} by ${r.runId}`))
      .toEqual([`inserted TXT ${ENVELOPE} → ${SPF} for mail example.com by run_envelope`]);
    expect(logs.some((l) => l.includes("entered into the book"))).toBe(true);
  });

  it("PLANTED INNOCENT: the platform domain's apex SPF, another service's, is neither read as written nor booked", async () => {
    const h = await makeHarness();
    seedMasterCluster(h);
    const dns = new FakeDnsProvider();
    dns.seed("example.com", "TXT", "v=spf1 include:spf.protection.outlook.com -all");
    await bookedTxtProgramStep({ dns }, MASTER_ID, envelopeSpfBooking(ports(h)), {
      name: "run-publish-envelope-spf", title: "the program",
      // A program that also changed the apex would show up here; this booking does not look there.
      run: async () => { dns.seed(ENVELOPE, "TXT", SPF); dns.seed("example.com", "TXT", "v=spf1 ip4:198.51.100.4 -all"); },
    }).run(ctx(h, []));
    expect(listDnsWrites(h.db.db).map((r) => r.name)).toEqual([ENVELOPE]);
  });

  it("a re-publish over a changed address: the SPF is updated from what stood", async () => {
    const h = await makeHarness();
    seedMasterCluster(h);
    const dns = new FakeDnsProvider();
    dns.seed(ENVELOPE, "TXT", "v=spf1 ip4:198.51.100.4 -all");
    const logs: string[] = [];
    await bookedTxtProgramStep({ dns }, MASTER_ID, envelopeSpfBooking(ports(h)), programWriting(dns, SPF)).run(ctx(h, logs));
    expect(listDnsWrites(h.db.db).map((r) => `${r.act} ${r.name}`)).toEqual([`updated ${ENVELOPE}`]);
    expect(logs.find((l) => l.includes("entered into the book"))).toContain("updated from v=spf1 ip4:198.51.100.4 -all");
  });
});
