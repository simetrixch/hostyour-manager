import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { apps, clusters, servers } from "../../db/schema/inventory.ts";
import { errNotConfigured, errNotFound } from "../../kernel/errors.ts";
import { MASTER_ROLES, type Stage } from "../../../shared/enums.ts";
import { MAIL_RECORD_TAG, mailRecordNames, type MailDnsDomainView, type MailDnsRow, type MailDnsView, type MailEgress, type SenderRole } from "../../../shared/mail.ts";
import type { PlatformRepo } from "../../adapters/git/port.ts";
import type { PublicDns } from "../../adapters/dns/public-dns.ts";
import { resolveClusterMarking } from "../inventory/cluster-marking.ts";

// The mail DNS of the installation, MEASURED: what receivers find at public DNS, held against what the
// master's map and address say they must find. Read-only — the writer is the catalogue's
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
  /** The key the sender signs THIS domain with, as the base64 a DKIM record carries in `p=` — where the
   *  Manager holds it (the platform domain of a unit that sends); null where the relay's own key is it. */
  dkimPublicKey: string | null;
}

const joined = (records: readonly string[]): string | null => (records.length === 0 ? null : records.join(" | "));

/** The base64 a DKIM record carries in `p=`: the DER of the SubjectPublicKeyInfo, which is the body
 *  of the SPKI PEM the Manager keeps. */
export function dkimRecordKey(spkiPem: string): string {
  return spkiPem.replace(/-----(BEGIN|END) PUBLIC KEY-----/g, "").replace(/\s+/g, "");
}

/** The five rows of one sender domain. Pure over the lookups, so a test scripts DNS and reads verdicts.
 *  A red row's note is ONE sentence naming the act: publish, remove a record by hand, set the reverse
 *  DNS at the provider, or point the mail name back at the address. What the publish does is the run's
 *  summary, not this page's.
 *
 *  THE MAIL NAME IS ITS OWN NAME (decided 2026-09-23): the reverse DNS of the address gives a name,
 *  and that name must resolve back to the address — the forward confirmation receivers check. The
 *  sender domain's apex is not asked to answer the address; it stays free for whatever it serves. */
export async function mailDnsRows(need: MailDnsNeed, dns: PublicDns): Promise<MailDnsRow[]> {
  const { domain, stage, egress, egressName, dkimPublicKey } = need;
  const noEgress = { note: `give ${egressName} an address record first` };
  const publish = { note: "publish" };

  const names = mailRecordNames(domain, stage);
  const spf = (await dns.txt(names.spf)).filter(MAIL_RECORD_TAG.spf);
  const spfRow: MailDnsRow = {
    record: "spf",
    name: names.spf,
    expected: egress === null ? `one v=spf1 record naming the address ${egressName} resolves to` : `one v=spf1 record naming ip4:${egress}`,
    found: joined(spf),
    ok: egress !== null && spf.length === 1 && spf[0]!.includes(`ip4:${egress}`),
    ...(egress === null
      ? noEgress
      : spf.length === 0
        ? publish
        : spf.length > 1
          ? { note: `remove ${spf.length - 1} of the ${spf.length} v=spf1 records by hand, then publish` }
          : spf[0]!.includes(`ip4:${egress}`)
            ? {}
            : { note: "publish; the address is merged into the record that stands" }),
  };

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

  return [spfRow, aRow, dkimRow, dmarcRow, ptrRow];
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

/** Where the stage's mail leaves. THE SENDER, where a unit declares one — G29 keeps it at one per
 *  stage: mail then leaves by the cluster it stands on, and the platform domain is signed with the
 *  unit's key. Where no unit sends, by the master's identity, whose relay delivers and signs. The name
 *  is resolved the way DNS resolves it: a CNAME — a master identity onto one of two machines — is
 *  followed to its address, which is where mail leaves from. */
export async function readMailEgress(deps: Pick<MailDnsDeps, "db" | "publicDns" | "smtpSenders">, stage: Stage, masterDomain: string): Promise<MailEgress> {
  const sender = (deps.smtpSenders ? await deps.smtpSenders(stage) : [])[0];
  if (sender === undefined) return { sender: null, name: masterDomain, address: (await deps.publicDns.a(masterDomain))[0] ?? null, dkimPublicKey: null };
  const on = deps.db.select({ domain: clusters.domain }).from(clusters).where(eq(clusters.name, sender.cluster)).get();
  if (!on) throw errNotFound(`the mail sender ${sender.unit} stands on cluster "${sender.cluster}", which is no cluster of this Manager`);
  const row = deps.db.select({ key: apps.dkimPublicKey }).from(apps).where(and(eq(apps.name, sender.unit), eq(apps.stage, stage))).get();
  return {
    sender: { unit: sender.unit, cluster: on.domain },
    name: on.domain,
    address: (await deps.publicDns.a(on.domain))[0] ?? null,
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
    domains.push({
      ...s,
      rows: await mailDnsRows(
        { ...s, stage: cluster.stage, egressName: out.name, egress: out.address, dkimPublicKey: s.role === "customer mail" ? out.dkimPublicKey : null },
        deps.publicDns,
      ),
    });
  }
  return {
    master: { serverId: master.id, name: master.name, fqdn: cluster.domain, stage: cluster.stage },
    sender: out.sender,
    egress: { name: out.name, address: out.address },
    domains,
    measuredAt: new Date().toISOString(),
  };
}
