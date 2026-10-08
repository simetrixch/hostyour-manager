import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { apps, clusters, servers } from "../../db/schema/inventory.ts";
import { listDnsWrites } from "../../db/dns-writes.ts";
import { errNotConfigured, errNotFound } from "../../kernel/errors.ts";
import { MASTER_ROLES, type Stage } from "../../../shared/enums.ts";
import { MAIL_RECORD_TAG, dmarcRecordName, envelopeDomainOf, mailRecordNames, platformDomainRefusal, spfHostMechanism, type FormerDmarcView, type MailDnsDomainView, type MailDnsRow, type MailDnsView, type MailEgress, type SenderRole } from "../../../shared/mail.ts";
import type { PlatformRepo } from "../../adapters/git/port.ts";
import type { PublicDns } from "../../adapters/dns/public-dns.ts";
import { resolveClusterMarking } from "../inventory/cluster-marking.ts";

// The mail DNS of the installation, MEASURED: what receivers find at public DNS, held against what the
// master's map and address say they must find. Read-only — the writer is the programs checkout's
// publish-mail-dns program, run by mail-dns-publish; this page is what tells the operator whether to
// run it, and what only the hosting provider can set (the reverse DNS).
//
// WHY MEASURED AND NOT REMEMBERED. The records live in a zone somebody else may edit (a domain whose
// mail already runs on another service), so nothing this manager stored about them would stay true.
// Every read asks public resolvers, never the machine's own: a record the master resolves through its
// cluster DNS and nobody else can is exactly the case this exists to show.

/** What the check needs to know about the installation before it asks DNS anything. */
export interface MailDnsNeed {
  domain: string;
  role: SenderRole;
  /** The key is published under the stage as its selector, so that is where it must stand. */
  stage: Stage;
  /** The name mail leaves by: the sender's cluster, or the master's identity where no unit sends. */
  egressName: string;
  /** The address that name resolves to — null where it resolves to none, which paints every
   *  address-bound row red with that one reason. */
  egress: string | null;
  /** The host an SPF record names the sender by: the one name the reverse DNS of `egress` gives,
   *  forward-confirmed (MailEgress.host); null where there is none. */
  egressHost: string | null;
  /** The key the sender signs THIS domain with, as the base64 a DKIM record carries in `p=` — where the
   *  Manager holds it (the platform domain of a unit that sends); null where the relay's own key is it. */
  dkimPublicKey: string | null;
  /** The name the platform's MTA sends its envelope from, whose SPF receivers check — the platform
   *  domain's (envelopeDomainOf); null for the alert domain, whose relay sends from the domain itself. */
  envelopeDomain: string | null;
  /** Whether the domain's mail runs on its own mail service, which keeps its apex SPF and its DMARC
   *  policy (the platform domain): mail-dns-publish is refused for it, so no row points at that run. */
  ownMailService: boolean;
}

const joined = (records: readonly string[]): string | null => (records.length === 0 ? null : records.join(" | "));

const noEgressNote = (egressName: string): { note: string } => ({ note: `give ${egressName} an address record first` });

/** The base64 a DKIM record carries in `p=`: the DER of the SubjectPublicKeyInfo, which is the body
 *  of the SPKI PEM the Manager keeps. */
export function dkimRecordKey(spkiPem: string): string {
  return spkiPem.replace(/-----(BEGIN|END) PUBLIC KEY-----/g, "").replace(/\s+/g, "");
}

/** The SPF row of one name: one v=spf1 record that names the sender by its host and not by its
 *  address, or the act that makes it so — `publish` names the run that writes it. No SPF record of ours
 *  names an address, so a change of the egress address never touches one. */
function spfRow(record: "spf" | "envelope-spf", name: string, found: readonly string[], egress: string | null, egressName: string, egressHost: string | null, publish: string): MailDnsRow {
  const mechanism = egressHost === null ? null : spfHostMechanism(name, egressHost);
  // Each mechanism as a term of its own, never as a prefix of a longer one (ip4:1.2.3.4 in ip4:1.2.3.45).
  const terms = (txt: string): string[] => txt.trim().split(/\s+/);
  // The host's own name may carry the bare `a` or spell itself out; without a host no term names it.
  const hostTerms = mechanism === null ? [] : [mechanism, `a:${egressHost}`];
  const namesHost = (txt: string): boolean => terms(txt).some((term) => hostTerms.includes(term));
  const namesAddress = (txt: string): boolean => terms(txt).some((term) => term === `ip4:${egress}` || term === `ip4:${egress}/32`);
  const holds = (txt: string): boolean => namesHost(txt) && !namesAddress(txt);
  return {
    record,
    name,
    expected: mechanism === null ? `one v=spf1 record naming the host the reverse DNS of ${egressName}'s address gives` : `one v=spf1 record naming the host ${egressHost} (${mechanism}), and no address`,
    found: joined(found),
    ok: found.length === 1 && holds(found[0]!),
    ...(egress === null
      ? noEgressNote(egressName)
      : mechanism === null
        ? { note: "set the reverse DNS first; the name it gives must resolve back to the address" }
        : found.length === 0
          ? { note: publish }
          : found.length > 1
            ? { note: `remove ${found.length - 1} of the ${found.length} v=spf1 records by hand, then ${publish}` }
            : holds(found[0]!)
              ? {}
              : namesAddress(found[0]!)
                ? { note: `${publish}; it replaces ip4:${egress} with ${mechanism}` }
                : { note: `${publish}; ${mechanism} is merged into the record that stands` }),
  };
}

/** The rows of one sender domain: its SPF, the envelope sender's SPF where it has one, the mail name's
 *  address record, its DKIM key, its DMARC policy and the reverse DNS. Pure over the lookups, so a test
 *  scripts DNS and reads verdicts. A red row's note is ONE sentence naming the act: publish, remove a
 *  record by hand, set the reverse DNS at the provider, or point the mail name back at the address — or,
 *  for a domain no run of this platform publishes, why not. What the publish does is the run's summary,
 *  not this page's.
 *
 *  THE MAIL NAME IS ITS OWN NAME (decided 2026-09-23): the reverse DNS of the address gives a name,
 *  and that name must resolve back to the address — the forward confirmation receivers check. The
 *  sender domain's apex is not asked to answer the address; it stays free for whatever it serves. */
export async function mailDnsRows(need: MailDnsNeed, dns: PublicDns): Promise<MailDnsRow[]> {
  const { domain, stage, egress, egressName, egressHost, dkimPublicKey, envelopeDomain, ownMailService } = need;
  const noEgress = noEgressNote(egressName);
  const publish = { note: "publish" };
  // A red row of a domain whose mail runs on its own mail service points at no run here for its apex SPF
  // and DMARC, which are that service's. The key under the platform's selector has a run of its own
  // (mail-dkim-publish), which publishes the key the stage's mail sender signs with; where no unit sends,
  // nothing here holds a key to publish.
  const serviceNote = { note: `${domain}'s own mail service keeps this record` };
  const serviceKeeps = (row: MailDnsRow): MailDnsRow => (row.note === undefined ? row : { ...row, ...serviceNote });
  // A doubled key keeps its act, a removal by hand at the provider: no run here chooses between two keys.
  const platformKey = (row: MailDnsRow): MailDnsRow =>
    row.note === undefined || row.note.startsWith("remove ")
      ? row
      : { ...row, note: dkimPublicKey === null ? `no run here publishes this key: no unit signs ${domain}'s mail with a key of its own` : row.note.replace(/^publish/, "publish the DKIM key") };

  const names = mailRecordNames(domain, stage);
  const apexSpf = (await dns.txt(names.spf)).filter(MAIL_RECORD_TAG.spf);
  // The service's own SPF need not name this platform's address: receivers check the platform's mail
  // at the envelope name. What it must be is one record, the rule of SPF itself.
  const spf: MailDnsRow = ownMailService
    ? { record: "spf", name: names.spf, expected: "one v=spf1 record, kept by the domain's own mail service", found: joined(apexSpf), ok: apexSpf.length === 1, ...(apexSpf.length === 1 ? {} : serviceNote) }
    : spfRow("spf", names.spf, apexSpf, egress, egressName, egressHost, "publish");
  const envelope = envelopeDomain === null
    ? []
    : [spfRow("envelope-spf", envelopeDomain, (await dns.txt(envelopeDomain)).filter(MAIL_RECORD_TAG["envelope-spf"]), egress, egressName, egressHost, "publish the envelope SPF")];

  // The reverse DNS and its forward confirmation, the same for every sender domain: one address, one name.
  const ptrNames = egress === null ? [] : await dns.ptr(egress);
  const mailName = ptrNames[0] ?? null;
  const back = mailName === null ? [] : await dns.a(mailName);

  const aRow: MailDnsRow = {
    record: "a",
    name: mailName ?? egressName,
    expected: egress ?? `the address ${egressName} resolves to`,
    found: joined(back),
    ok: egress !== null && back.includes(egress),
    ...(egress === null
      ? noEgress
      : mailName === null
        ? { note: "set the reverse DNS first; the name it gives must resolve back to the address" }
        : back.includes(egress)
          ? {}
          : { note: `point ${mailName} at ${egress}` }),
  };

  const dkim = (await dns.txt(names.dkim)).filter(MAIL_RECORD_TAG.dkim);
  const carriesKey = (txt: string): boolean => dkimPublicKey !== null && txt.replace(/\s+/g, "").includes(`p=${dkimPublicKey}`);
  const dkimRow: MailDnsRow = {
    record: "dkim",
    name: names.dkim,
    expected: dkimPublicKey === null ? "one v=DKIM1 record carrying the relay's public key" : `one v=DKIM1 record carrying the sender's public key (p=${dkimPublicKey.slice(0, 16)}…)`,
    found: joined(dkim),
    ok: dkim.length === 1 && (dkimPublicKey === null || carriesKey(dkim[0]!)),
    ...(dkim.length === 0
      ? { note: dkimPublicKey === null ? "publish; the key is published where the relay holds one" : "publish" }
      : dkim.length > 1
        ? { note: `remove ${dkim.length - 1} of the ${dkim.length} records under this selector by hand` }
        : dkimPublicKey !== null && !carriesKey(dkim[0]!)
          ? { note: "publish; the record carries another key than the sender signs with" }
          : {}),
  };

  const dmarc = (await dns.txt(names.dmarc)).filter(MAIL_RECORD_TAG.dmarc);
  const dmarcRow: MailDnsRow = {
    record: "dmarc",
    name: names.dmarc,
    expected: "one v=DMARC1 record with a policy and a report mailbox",
    found: joined(dmarc),
    ok: dmarc.length === 1,
    ...(dmarc.length === 0 ? publish : dmarc.length > 1 ? { note: `remove ${dmarc.length - 1} of the ${dmarc.length} DMARC records by hand, then publish` } : {}),
  };

  const ptrRow: MailDnsRow = {
    record: "ptr",
    name: egress ?? egressName,
    expected: "a name that resolves back to this address",
    found: joined(ptrNames),
    ok: egress !== null && mailName !== null,
    ...(egress === null ? noEgress : mailName === null ? { note: `set the reverse DNS of ${egress} to the mail name at the hosting provider` } : {}),
  };

  return [spf, ...envelope, aRow, ownMailService ? platformKey(dkimRow) : dkimRow, ownMailService ? serviceKeeps(dmarcRow) : dmarcRow, ptrRow];
}

export interface MailDnsDeps {
  db: Db;
  platformRepo?: PlatformRepo;
  publicDns: PublicDns;
  /** The units whose registration at a stage carries an SMTP entry, with the SHORT name of the cluster
   *  each stands on — the registrations of domains/units, bound by the composition root. Absent, no
   *  sender is read and the master's relay is taken as the one that delivers. */
  smtpSenders?: (stage: Stage) => Promise<{ unit: string; cluster: string }[]>;
}

/** The name the reverse DNS of `address` gives, when exactly one name is given and it resolves
 *  back to `address`; null otherwise. Lowercased, because DNS names are case-insensitive and the
 *  SPF step accepts a host only in lowercase. */
async function forwardConfirmedHost(publicDns: PublicDns, address: string | null): Promise<string | null> {
  if (address === null) return null;
  const ptr = await publicDns.ptr(address);
  if (ptr.length !== 1) return null;
  const host = ptr[0]!.toLowerCase();
  return (await publicDns.a(host)).includes(address) ? host : null;
}

/** Where the stage's mail leaves. THE SENDER, where a unit declares one — G29 keeps it at one per
 *  stage: mail then leaves by the cluster it stands on, and the platform domain is signed with the
 *  unit's key. Where no unit sends, by the master's identity, whose relay delivers and signs. The name
 *  is resolved the way DNS resolves it: a CNAME — a master identity onto one of two machines — is
 *  followed to its address, which is where mail leaves from. */
export async function readMailEgress(deps: Pick<MailDnsDeps, "db" | "publicDns" | "smtpSenders">, stage: Stage, masterDomain: string): Promise<MailEgress> {
  const sender = (deps.smtpSenders ? await deps.smtpSenders(stage) : [])[0];
  if (sender === undefined) {
    const address = (await deps.publicDns.a(masterDomain))[0] ?? null;
    return { sender: null, name: masterDomain, address, host: await forwardConfirmedHost(deps.publicDns, address), dkimPublicKey: null };
  }
  const on = deps.db.select({ domain: clusters.domain }).from(clusters).where(eq(clusters.name, sender.cluster)).get();
  if (!on) throw errNotFound(`the mail sender ${sender.unit} stands on cluster "${sender.cluster}", which is no cluster of this Manager`);
  const row = deps.db.select({ key: apps.dkimPublicKey }).from(apps).where(and(eq(apps.name, sender.unit), eq(apps.stage, stage))).get();
  const address = (await deps.publicDns.a(on.domain))[0] ?? null;
  return {
    sender: { unit: sender.unit, cluster: on.domain },
    name: on.domain,
    address,
    host: await forwardConfirmedHost(deps.publicDns, address),
    dkimPublicKey: row?.key ? dkimRecordKey(row.key) : null,
  };
}

/** The installation's mail DNS, measured now. The master is the one role=master server and its
 *  cluster row; the sender domains are its map's platformDomain (customer mail) and unitApex
 *  (alert mail) — one block when the two are the same name. */
export async function readMailDns(deps: MailDnsDeps): Promise<MailDnsView> {
  const master = deps.db.select().from(servers).where(inArray(servers.role, [...MASTER_ROLES])).get();
  if (!master) throw errNotFound("no master server is registered — the mail leaves the master, and there is none to measure");
  const cluster = deps.db.select().from(clusters).where(eq(clusters.serverId, master.id)).get();
  if (!cluster) throw errNotFound(`the master ${master.name} carries no cluster row — boot seeds it from MASTER_FQDN (boot/seed-master.ts)`);
  if (!deps.platformRepo) throw errNotConfigured("no platform repository is configured — the sender domains are read off the master's cluster map there");
  const marking = await resolveClusterMarking(deps.platformRepo, cluster.domain);
  if (marking.platformDomain === undefined || marking.unitApex === undefined) {
    throw errNotFound(
      `the map of ${cluster.domain} names no ${marking.platformDomain === undefined ? "platformDomain" : "unitApex"} — ` +
        "the two sender domains are read off it; write the answer into the installation's config and regenerate the branch",
    );
  }
  const out = await readMailEgress(deps, cluster.stage, cluster.domain);
  const senderDomains: Array<{ domain: string; role: SenderRole }> = [{ domain: marking.platformDomain, role: "customer mail" }];
  if (marking.unitApex !== marking.platformDomain) senderDomains.push({ domain: marking.unitApex, role: "alert mail" });
  const domains: MailDnsDomainView[] = [];
  for (const s of senderDomains) {
    const platform = s.role === "customer mail";
    domains.push({
      ...s,
      rows: await mailDnsRows(
        {
          ...s, stage: cluster.stage, egressName: out.name, egress: out.address, egressHost: out.host, dkimPublicKey: platform ? out.dkimPublicKey : null,
          envelopeDomain: platform ? envelopeDomainOf(s.domain) : null, ownMailService: platform,
        },
        deps.publicDns,
      ),
      publishRefusal: platform ? platformDomainRefusal(s.domain) : null,
    });
  }
  const senderDomainNames = new Set(senderDomains.map((s) => s.domain));
  const formerDmarcRows = listDnsWrites(deps.db).filter(
    (r) => r.type === "TXT" && r.owner.kind === "mail" && r.name === dmarcRecordName(r.owner.name) && !senderDomainNames.has(r.owner.name),
  );
  const formerDmarc: FormerDmarcView[] = [];
  for (const row of formerDmarcRows) {
    const dmarc = (await deps.publicDns.txt(row.name)).filter(MAIL_RECORD_TAG.dmarc);
    formerDmarc.push({
      domain: row.owner.name,
      name: row.name,
      found: joined(dmarc),
      publishedAt: row.writtenAt.toISOString(),
    });
  }
  formerDmarc.sort((a, b) => a.domain.localeCompare(b.domain));
  return {
    master: { serverId: master.id, name: master.name, fqdn: cluster.domain, stage: cluster.stage },
    sender: out.sender,
    egress: { name: out.name, address: out.address },
    domains,
    formerDmarc,
    measuredAt: new Date().toISOString(),
  };
}
