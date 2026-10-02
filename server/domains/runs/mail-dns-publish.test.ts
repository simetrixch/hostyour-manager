import { describe, it, expect, afterEach } from "vitest";
import { clusters } from "../../db/schema/inventory.ts";
import { listDnsWrites, recordDnsWrite } from "../../db/dns-writes.ts";
import { clusterMapPath } from "../../../shared/cluster-values.ts";
import { FakeDnsProvider } from "../../adapters/dns/testing/fake.ts";
import type { Step, StepCtx } from "../../executor/types.ts";
import type { CredentialStore } from "../../security/store.ts";
import type { Logger } from "../../kernel/logger.ts";
import { makeHarness, disposeHarnesses, seedMasterCluster, MASTER_ID, SLAVE_ID, MASTER_MARKING_YAML, type Harness } from "./deploy-slave.fixture.ts";
import { MASTER_FQDN } from "./cluster-maps.fixture.ts";
import { ANSIWISE_ELEVATION_SECRET } from "./defs/ansiwise-run.kit.ts";
import type { MailEgress } from "../../../shared/mail.ts";
import { bookedProgramStep, makeMailDnsPublishDef, mailDnsAnswers, readPublishedTxt, senderDomainTxt, senderRoleOf, type MailDnsPublishParams, type MailDnsPublishPorts } from "./defs/mail-dns-publish.ts";

// mail-dns-publish runs the programs checkout's publish-mail-dns on the master for the alert domain the
// master's map names. What these tests hold: the plan stands only on a master and only for that name —
// the platform domain is refused, its mail records being its own mail service's — the program is
// answered with the Mail page's reading of where the stage's mail leaves (never typed), the two DMARC
// choices travel from the params to the answers, and the book of DNS writes learns what the program
// changed from the difference of the three published names read at the provider before and after it.

const EGRESS = "203.0.113.9";
/** The alert domain: the map's unit apex, set apart from its platform domain example.com. */
const ALERT = "apps.example.net";
const PARAMS: MailDnsPublishParams = { serverId: MASTER_ID, senderDomain: ALERT, dmarcPolicy: "none", dmarcMailbox: "dmarc@example.com" };

/** The master with a map whose unit apex is ALERT and whose platform domain stays example.com. */
function seedMaster(h: Harness): void {
  seedMasterCluster(h);
  h.platformRepo.seed(h.platformRepo.booksBranch, clusterMapPath(MASTER_FQDN), MASTER_MARKING_YAML.replace("unitApex: example.com", `unitApex: ${ALERT}`));
}

afterEach(disposeHarnesses);

function ports(h: Harness, dns?: FakeDnsProvider): MailDnsPublishPorts {
  return { ...h.runPorts, ...(dns ? { dns } : {}) };
}

/** The Mail page's reading, scripted: without a sender, mail leaves by the master's identity. */
function egressOf(over: Partial<MailEgress> = {}, asked: string[] = []): NonNullable<MailDnsPublishPorts["mailEgress"]> {
  return async (stage, masterDomain) => {
    asked.push(`${stage} ${masterDomain}`);
    return { sender: null, name: masterDomain, address: EGRESS, dkimPublicKey: null, ...over };
  };
}

const SENDER: Partial<MailEgress> = { sender: { unit: "post", cluster: "a1.example.com" }, name: "a1.example.com", dkimPublicKey: "MIIBsenderKey" };

function ctx(h: Harness, logs: string[], slot: { checkpoint?: unknown } = {}): StepCtx {
  return {
    runId: "run_mail", stepName: "run-publish-mail-dns", db: h.db.db, creds: {} as unknown as CredentialStore, params: { ...PARAMS },
    secrets: { get: () => undefined, wipe: () => undefined }, signal: new AbortController().signal, logger: {} as unknown as Logger,
    ssh: () => Promise.reject(new Error("no ssh")), openPasswordSession: () => Promise.reject(new Error("no ssh")),
    closePasswordSession: () => undefined, attest: () => Promise.reject(new Error("no attest")),
    log: (_s, t) => logs.push(t), checkpoint: (d) => { slot.checkpoint = d; }, readCheckpoint: <T,>() => slot.checkpoint as T | undefined, registerCleanup: () => undefined,
  };
}

describe("mail-dns-publish plan", () => {
  it("stands on the master: attest, then the ONE program step, the elevation password required, the master the only target", async () => {
    const h = await makeHarness();
    seedMaster(h);
    const plan = await makeMailDnsPublishDef(ports(h)).plan(PARAMS, { db: h.db.db });
    expect(plan.steps.map((s) => s.name)).toEqual(["attest-target", "run-publish-mail-dns"]);
    expect(plan.targets).toEqual([{ serverId: MASTER_ID, ownsHost: true, label: "m1 (master)" }]);
    expect(plan.requiredSecrets).toEqual([ANSIWISE_ELEVATION_SECRET]);
    expect(plan.summary).toContain(`${ALERT} (alert mail)`);
    // The PTR is the provider's to set; the plan says so rather than pretending to.
    expect(plan.warnings.join(" ")).toMatch(/reverse DNS of the address mail leaves from .* resolve back to that address/);
    expect(plan.summary).not.toMatch(/address record/);
    expect(senderRoleOf("nobody.example", { platformDomain: "example.com", unitApex: ALERT })).toBeUndefined();
  });

  it("PLANTED DEFECT: refuses the platform domain, whose apex SPF, DKIM selectors and DMARC policy are its own mail service's", async () => {
    const h = await makeHarness();
    seedMaster(h);
    await expect(makeMailDnsPublishDef(ports(h)).plan({ ...PARAMS, senderDomain: "example.com" }, { db: h.db.db }))
      .rejects.toThrow(/example\.com is the platform domain: its mail runs on its own mail service, .* the runs that write and delete the apex SPF and the DMARC policy are refused for it/);
  });

  it("refuses the platform domain also where the map names it as the unit apex too, so the one block is the platform's", async () => {
    const h = await makeHarness();
    seedMasterCluster(h);
    await expect(makeMailDnsPublishDef(ports(h)).plan({ ...PARAMS, senderDomain: "example.com" }, { db: h.db.db })).rejects.toThrow(/is the platform domain/);
  });

  it("refuses a domain the master's map does not name — mail leaves the installation as nothing else", async () => {
    const h = await makeHarness();
    seedMaster(h);
    await expect(makeMailDnsPublishDef(ports(h)).plan({ ...PARAMS, senderDomain: "foreign.example" }, { db: h.db.db }))
      .rejects.toThrow(/foreign\.example is not a sender domain of m1\.example\.com: its map names example\.com \(customer mail/);
  });

  it("refuses a slave: the relay, the token and the egress address are the master's", async () => {
    const h = await makeHarness();
    h.db.db.insert(clusters).values({ id: "cls_s1", serverId: SLAVE_ID, stage: "prod", domain: "s1.example.com", name: "s1", status: "active", slaveId: 1 }).run();
    await expect(makeMailDnsPublishDef(ports(h)).plan({ ...PARAMS, serverId: SLAVE_ID }, { db: h.db.db }))
      .rejects.toThrow(/s1 is a slave — publish-mail-dns runs on the master/);
  });
});

describe("what publish-mail-dns is answered with", () => {
  it("without a sender: the run's domain, the DMARC choices and the address the master's identity resolves to — no key, the relay's stands in the store", async () => {
    const h = await makeHarness();
    seedMaster(h);
    const asked: string[] = [];
    const logs: string[] = [];
    const answers = await mailDnsAnswers({ ...PARAMS, dmarcPolicy: "quarantine" }, { ...ports(h), mailEgress: egressOf({}, asked) })(ctx(h, logs));
    expect(answers).toEqual({ mail_domain: ALERT, egress_address: EGRESS, dmarc_policy: "quarantine", dmarc_mailbox: "dmarc@example.com" });
    expect(asked).toEqual([`prod ${MASTER_FQDN}`]);
    // dkim_selector is NOT answered: the program defaults it to the stage, which is what the signers sign with.
    expect(logs.join(" ")).toContain("dkim_selector is left to the stage");
  });

  it("with a sender: mail leaves where it stands, and no key is answered — the relay signs the alert domain", async () => {
    const h = await makeHarness();
    seedMaster(h);
    const logs: string[] = [];
    const answers = await mailDnsAnswers(PARAMS, { ...ports(h), mailEgress: egressOf(SENDER) })(ctx(h, logs));
    expect(answers).toMatchObject({ egress_address: EGRESS });
    expect(answers).not.toHaveProperty("dkim_public_key");
    expect(logs.join(" ")).toContain("a1.example.com, where the mail sender post stands");
  });

  it("refuses the platform domain at the run as well, where the plan's map may have changed since", async () => {
    const h = await makeHarness();
    seedMaster(h);
    await expect(mailDnsAnswers({ ...PARAMS, senderDomain: "example.com" }, { ...ports(h), mailEgress: egressOf() })(ctx(h, []))).rejects.toThrow(/example\.com is the platform domain/);
  });

  it("refuses where the name mail leaves by resolves to no address, rather than announcing a guessed one", async () => {
    const h = await makeHarness();
    seedMaster(h);
    await expect(mailDnsAnswers(PARAMS, { ...ports(h), mailEgress: egressOf({ address: null }) })(ctx(h, [])))
      .rejects.toThrow(/m1\.example\.com resolves to no address at public DNS/);
  });

  it("refuses without the mail reading wired — the address has no other source", async () => {
    const h = await makeHarness();
    seedMaster(h);
    await expect(mailDnsAnswers(PARAMS, ports(h))(ctx(h, []))).rejects.toThrow(/no mail reading is wired/);
  });
});

/** What the programs checkout's program leaves in the zone, played by a step that writes the fake provider
 *  the way publish-mail-dns writes Cloudflare: the SPF merged at the apex beside whatever TXT stands
 *  there, the key under the selector, the policy under _dmarc. It checkpoints, so the test can see
 *  the decoration keep its checkpoint apart from the program's. */
function programWriting(dns: FakeDnsProvider, records: Partial<Record<"spf" | "dkim" | "dmarc", string>>): Step & { ran: number } {
  const step = {
    name: "run-publish-mail-dns", title: "the program", ran: 0,
    run: async (c: StepCtx) => {
      step.ran += 1;
      c.checkpoint({ program: "publish-mail-dns", machineRunId: "mr_1" });
      expect(c.readCheckpoint()).toEqual({ program: "publish-mail-dns", machineRunId: "mr_1" });
      const other = (await dns.listRecordContents({ name: ALERT, type: "TXT" })).filter((t) => !t.startsWith("v=spf1"));
      if (records.spf) dns.seed(ALERT, "TXT", ...other, records.spf);
      if (records.dkim) dns.seed(`prod._domainkey.${ALERT}`, "TXT", records.dkim);
      if (records.dmarc) dns.seed(`_dmarc.${ALERT}`, "TXT", records.dmarc);
    },
  };
  return step;
}

describe("what the book of DNS writes learns from the publish", () => {
  const SPF = `v=spf1 ip4:${EGRESS} -all`;
  const DKIM = "v=DKIM1; k=rsa; p=MIIB";
  const DMARC = "v=DMARC1; p=none; rua=mailto:dmarc@example.com";

  it("reads the three published names at the provider, picking each record by its tag among the TXT of the name", async () => {
    const dns = new FakeDnsProvider();
    dns.seed(ALERT, "TXT", "MS=ms12345678", SPF, "google-site-verification=abc");
    dns.seed(`_dmarc.${ALERT}`, "TXT", DMARC);
    expect(await readPublishedTxt(dns, senderDomainTxt(ALERT, "prod"), new AbortController().signal)).toEqual({ [ALERT]: SPF, [`prod._domainkey.${ALERT}`]: null, [`_dmarc.${ALERT}`]: DMARC });
  });

  it("a domain with nothing published: all three are inserted, owned by the sender domain, by this run", async () => {
    const h = await makeHarness();
    seedMaster(h);
    const dns = new FakeDnsProvider();
    dns.seed(ALERT, "TXT", "MS=ms12345678"); // another service's TXT at the apex, which is not a write of ours
    const logs: string[] = [];
    await bookedProgramStep(PARAMS, ports(h, dns), programWriting(dns, { spf: SPF, dkim: DKIM, dmarc: DMARC })).run(ctx(h, logs));
    const rows = listDnsWrites(h.db.db);
    expect(rows.map((r) => `${r.act} ${r.type} ${r.name} → ${r.content}`).sort()).toEqual([
      `inserted TXT _dmarc.${ALERT} → ${DMARC}`,
      `inserted TXT ${ALERT} → ${SPF}`,
      `inserted TXT prod._domainkey.${ALERT} → ${DKIM}`,
    ]);
    expect(rows.every((r) => r.runId === "run_mail" && r.owner.kind === "mail" && r.owner.name === ALERT && r.owner.stage === undefined)).toBe(true);
    expect(logs.filter((l) => l.includes("entered into the book"))).toHaveLength(3);
  });

  it("a re-publish over a changed address: the SPF is updated, the unchanged key and policy enter nothing", async () => {
    const h = await makeHarness();
    seedMaster(h);
    const dns = new FakeDnsProvider();
    dns.seed(ALERT, "TXT", "v=spf1 ip4:198.51.100.4 -all");
    dns.seed(`prod._domainkey.${ALERT}`, "TXT", DKIM);
    dns.seed(`_dmarc.${ALERT}`, "TXT", DMARC);
    // The key was booked by an earlier publish; the row must survive a publish that leaves it as it is.
    recordDnsWrite(h.db.db, { name: `prod._domainkey.${ALERT}`, type: "TXT", content: DKIM, act: "inserted", owner: { kind: "mail", name: ALERT }, runId: "run_earlier" });
    const logs: string[] = [];
    await bookedProgramStep(PARAMS, ports(h, dns), programWriting(dns, { spf: SPF, dkim: DKIM, dmarc: DMARC })).run(ctx(h, logs));
    expect(listDnsWrites(h.db.db).map((r) => `${r.act} ${r.name} by ${r.runId}`).sort()).toEqual([
      `inserted prod._domainkey.${ALERT} by run_earlier`,
      `updated ${ALERT} by run_mail`,
    ]);
    expect(logs.find((l) => l.includes("entered into the book"))).toContain("updated from v=spf1 ip4:198.51.100.4 -all");
  });

  it("a program that publishes no key (the store holds no pair) enters no DKIM row — the book never records a write nobody made", async () => {
    const h = await makeHarness();
    seedMaster(h);
    const dns = new FakeDnsProvider();
    await bookedProgramStep(PARAMS, ports(h, dns), programWriting(dns, { spf: SPF, dmarc: DMARC })).run(ctx(h, []));
    expect(listDnsWrites(h.db.db).map((r) => r.name).sort()).toEqual([`_dmarc.${ALERT}`, ALERT]);
  });

  it("re-entered after a crash, the step judges against what stood before the FIRST attempt — the checkpoint holds it beside the program's own", async () => {
    const h = await makeHarness();
    seedMaster(h);
    const dns = new FakeDnsProvider();
    const slot: { checkpoint?: unknown } = {};
    const failing = programWriting(dns, { spf: SPF, dkim: DKIM, dmarc: DMARC });
    const crash = { ...failing, run: async (c: StepCtx) => { await failing.run(c); throw new Error("the session dropped after the program wrote"); } };
    await expect(bookedProgramStep(PARAMS, ports(h, dns), crash).run(ctx(h, [], slot))).rejects.toThrow(/session dropped/);
    expect(listDnsWrites(h.db.db)).toEqual([]);
    expect(slot.checkpoint).toEqual({ before: { [ALERT]: null, [`prod._domainkey.${ALERT}`]: null, [`_dmarc.${ALERT}`]: null }, program: { program: "publish-mail-dns", machineRunId: "mr_1" } });
    // The re-entry finds the records already standing; without the checkpointed reading it would book nothing.
    await bookedProgramStep(PARAMS, ports(h, dns), programWriting(dns, { spf: SPF, dkim: DKIM, dmarc: DMARC })).run(ctx(h, [], slot));
    expect(listDnsWrites(h.db.db).map((r) => r.act)).toEqual(["inserted", "inserted", "inserted"]);
  });

  it("PLANTED DEFECT: a checkpoint keyed by record kind, from before the names were the keys, is read again and books no write nobody made", async () => {
    const h = await makeHarness();
    seedMaster(h);
    const dns = new FakeDnsProvider();
    dns.seed(ALERT, "TXT", SPF);
    dns.seed(`prod._domainkey.${ALERT}`, "TXT", DKIM);
    dns.seed(`_dmarc.${ALERT}`, "TXT", DMARC);
    // The run crashed before this release, after the earlier attempt's program had written all three.
    const slot: { checkpoint?: unknown } = { checkpoint: { before: { spf: null, dkim: null, dmarc: null }, program: { program: "publish-mail-dns", machineRunId: "mr_1" } } };
    await bookedProgramStep(PARAMS, ports(h, dns), programWriting(dns, { spf: SPF, dkim: DKIM, dmarc: DMARC })).run(ctx(h, [], slot));
    expect(listDnsWrites(h.db.db)).toEqual([]);
  });

  it("refuses without a DNS provider before the program runs — the reading has no other source", async () => {
    const h = await makeHarness();
    seedMaster(h);
    const program = programWriting(new FakeDnsProvider(), {});
    await expect(bookedProgramStep(PARAMS, ports(h), program).run(ctx(h, []))).rejects.toThrow(/no DNS provider is wired/);
    expect(program.ran).toBe(0);
  });
});
