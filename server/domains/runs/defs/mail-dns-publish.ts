import { z } from "zod";
import type { Step, StepCtx, RunDefinition } from "../../../executor/types.ts";
import { errValidation } from "../../../kernel/errors.ts";
import { recordDnsWrite } from "../../../db/dns-writes.ts";
import { DMARC_POLICY, isMasterRole, type Stage } from "../../../../shared/enums.ts";
import { MAIL_RECORD_TAG, PUBLISHED_MAIL_RECORD, mailRecordNames, platformDomainRefusal, type MailEgress } from "../../../../shared/mail.ts";
import type { DnsProvider } from "../../../adapters/dns/port.ts";
import { resolveClusterMarking } from "../../inventory/cluster-marking.ts";
import { activeClusterTarget, requirePlatformRepo, type DeploySlavePorts } from "./deploy-slave.kit.ts";
import { attestClusterStep, loadActiveCluster } from "./live-cluster.kit.ts";
import { ansiwiseProgramStep, ANSIWISE_ELEVATION_SECRET, type AnsiwisePorts, type ExtraAnswers } from "./ansiwise-run.kit.ts";

// mail-dns-publish: publish the mail DNS of ONE sender domain of this installation — its SPF, its
// DKIM key, its DMARC policy — by running the
// programs checkout's `publish-mail-dns` program on the master, the way deploy-slave and redeploy run the
// machine's own programs. The program is the ONE writer of these records (its SPF merge keeps what
// another service published and refuses a domain that already carries two v=spf1 records), and a
// second writer of the same records would drift from it. The one exception is mail-dmarc-publish: it
// rewrites only the rua tag of a DMARC record this program published, at the provider, and keeps every
// other tag, so the program's next publish of that domain still writes the whole record.
//
// WHICH DOMAINS. An installation sends as exactly two: customer mail as its platform domain and
// alert mail as its unit apex — the two names deploy-branch writes into the relay's
// ALLOWED_SENDER_DOMAINS. Both stand on the master's cluster map (platformDomain, unitApex), so the
// plan reads them there and refuses any other name. The platform domain is refused as well: its mail
// runs on its own mail service, which controls its apex SPF, its DKIM selectors and its DMARC
// policy, and the program would write all three (shared/mail.ts platformDomainRefusal). What this
// platform owns under it is the envelope sender's SPF, which mail-envelope-spf-publish writes. One
// run publishes one domain, exactly as the program does.
//
// WHAT IS ANSWERED, AND FROM WHERE. `stage` is the cluster row's (composeAnswers reads the inventory);
// `mail_domain` is the run's; `egress_address` comes from the Mail page's own reading of where the
// stage's mail leaves (MailEgress) — the address the name mail leaves by resolves to at public DNS,
// never typed. No `dkim_public_key` is answered: the alert domain is signed by the relay, whose key
// the program reads out of the store. `dkim_selector` is left to the program's default, the stage;
// `dmarc_policy` and `dmarc_mailbox` are the operator's on the Mail page.
//
// WHAT THIS DOES NOT DO. It writes no address record: the mail name is its own name, given by the
// reverse DNS of the egress address where that address is rented. The plan says so in its warning
// and the Mail page measures both.
//
// WHAT THE BOOK OF DNS WRITES LEARNS. The Manager writes none of these records itself, so the only
// way it can say what the program did is the DIFFERENCE: what stood under the three published names
// before the program and what stands after it. A record absent before and standing after was
// inserted, one standing with other content was updated, and each enters the book (db/dns-writes.ts)
// with the sender domain as its owner. Both readings are taken AT THE PROVIDER and not at public
// resolvers, although the Mail page measures there: a resolver answers from its cache for the
// record's TTL, and a reading before the program would prime that cache with the old content, so a
// public reading after it could not see the write.

export const MAIL_DNS_PROGRAM = "publish-mail-dns";

export const senderDomain = z.string().regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/, "a DNS apex, lowercase");

export const MailDnsPublishParams = z.object({
  serverId: z.string().startsWith("srv_"),
  /** The domain mail is sent AS — one of the two the master's map names. */
  senderDomain,
  dmarcPolicy: z.enum(DMARC_POLICY).default("none"),
  /** Where receivers send their aggregate DMARC reports — a mailbox somebody reads. */
  dmarcMailbox: z.string().email(),
});
export type MailDnsPublishParams = z.infer<typeof MailDnsPublishParams>;

export interface MailDnsPublishPorts extends DeploySlavePorts, AnsiwisePorts {
  /** The DNS provider the three published names are read at, before and after the program. */
  dns?: DnsProvider;
  /** Where the stage's mail leaves and the key its sender signs with — the Mail page's reading
   *  (domains/mail readMailEgress), bound by the composition root. */
  mailEgress?: (stage: Stage, masterDomain: string) => Promise<MailEgress>;
}

/** The two domains an installation sends as, off the master's map: customer mail as the platform
 *  domain, alert mail as the unit apex. Both are required: a map that names neither belongs to an
 *  installation that sends no mail, and this run has nothing to publish for it. */
export async function senderDomainsOf(ports: DeploySlavePorts, clusterDomain: string): Promise<{ platformDomain: string; unitApex: string }> {
  const marking = await resolveClusterMarking(requirePlatformRepo(ports), clusterDomain);
  if (marking.platformDomain === undefined || marking.unitApex === undefined) {
    throw errValidation(
      `the map of ${clusterDomain} names no ${marking.platformDomain === undefined ? "platformDomain" : "unitApex"} — ` +
        "the two sender domains of an installation (customer mail as the platform domain, alert mail as the unit apex) are read off " +
        "the master's map, and nothing else may state them; write the answer into the installation's config and regenerate the branch",
    );
  }
  return { platformDomain: marking.platformDomain, unitApex: marking.unitApex };
}

/** Which of the two roles a sender domain plays on this installation, or undefined for a name the
 *  installation does not send as. */
export function senderRoleOf(domain: string, sender: { platformDomain: string; unitApex: string }): "customer mail" | "alert mail" | undefined {
  if (domain === sender.platformDomain) return "customer mail";
  if (domain === sender.unitApex) return "alert mail";
  return undefined;
}

/** The role the run's domain plays, refused where it is no sender domain of the master's map and
 *  where it is the platform domain, whose mail records belong to its own mail service. The plan asks
 *  and the run asks again, because the map may have changed in between. */
async function publishableRole(ports: MailDnsPublishPorts, clusterDomain: string, domain: string): Promise<"alert mail"> {
  const sender = await senderDomainsOf(ports, clusterDomain);
  const role = senderRoleOf(domain, sender);
  if (role === undefined) {
    throw errValidation(
      `${domain} is not a sender domain of ${clusterDomain}: its map names ${sender.platformDomain} (customer mail, platformDomain) ` +
        `and ${sender.unitApex} (alert mail, unitApex), and mail leaves this installation as nothing else`,
    );
  }
  if (role === "customer mail") throw errValidation(platformDomainRefusal(domain));
  return role;
}

/** What `publish-mail-dns` is answered with beyond the inventory (composeAnswers reads `stage` off
 *  the cluster row): the run's domain and DMARC choices, and the address mail leaves from.
 *  Fail-closed where the name mail leaves by resolves to no address: a guessed address in the SPF
 *  makes receivers fail the mail. */
export function mailDnsAnswers(params: MailDnsPublishParams, ports: MailDnsPublishPorts): ExtraAnswers {
  return async (ctx) => {
    const { cluster } = loadActiveCluster(ctx.db, params.serverId);
    const role = await publishableRole(ports, cluster.domain, params.senderDomain);
    if (!ports.mailEgress) throw errValidation("no mail reading is wired into this manager — the egress address has no other source");
    const out = await ports.mailEgress(cluster.stage, cluster.domain);
    if (out.address === null) {
      throw errValidation(`${out.name} resolves to no address at public DNS — mail leaves from that address, and the SPF names it`);
    }
    ctx.log(
      "meta",
      `${MAIL_DNS_PROGRAM} is told mail_domain=${params.senderDomain} (${role}), egress_address=${out.address} (${out.name}` +
        `${out.sender !== null ? `, where the mail sender ${out.sender.unit} stands` : ", the master"}), ` +
        "no dkim_public_key (the relay's key is read out of the store), " +
        `dmarc_policy=${params.dmarcPolicy}, dmarc_mailbox=${params.dmarcMailbox}; dkim_selector is left to the stage`,
    );
    return {
      mail_domain: params.senderDomain,
      egress_address: out.address,
      dmarc_policy: params.dmarcPolicy,
      dmarc_mailbox: params.dmarcMailbox,
    };
  };
}

/** One TXT record a program may write: its name, and the tag that picks it among the TXT of that
 *  name (an apex carries other services' TXT beside the SPF). */
export interface PublishedTxt {
  name: string;
  tag: (txt: string) => boolean;
}

/** What stands under each published name at the provider, picked by its tag — null where no such
 *  record stands. Keyed by the name. */
export async function readPublishedTxt(dns: DnsProvider, published: readonly PublishedTxt[], signal: AbortSignal): Promise<Record<string, string | null>> {
  const standing: Record<string, string | null> = {};
  for (const { name, tag } of published) standing[name] = (await dns.listRecordContents({ name, type: "TXT", signal })).find(tag) ?? null;
  return standing;
}

/** The three records publish-mail-dns writes for a sender domain, under their names at `stage`. */
export function senderDomainTxt(domain: string, stage: Stage): PublishedTxt[] {
  const names = mailRecordNames(domain, stage);
  return PUBLISHED_MAIL_RECORD.map((record) => ({ name: names[record], tag: MAIL_RECORD_TAG[record] }));
}

/** The program step's checkpoint and, beside it, the reading this decoration took before the
 *  program ran — one slot, because a step has one. */
interface BookedCheckpoint {
  before?: Record<string, string | null>;
  program?: unknown;
}

/** What a booked program step books: the sender domain its records belong to, and the TXT records
 *  the program may write. Resolved at the run, against the active cluster, because the platform
 *  domain is read off the master's map. */
export type TxtBooking = (cluster: { domain: string; stage: Stage }) => Promise<{ owner: string; published: PublishedTxt[] }>;

/** A program step with the book around it: the TXT records the program may write are read at the
 *  provider before the program and after it, and every one it changed enters the book of DNS writes
 *  as the mail records of the booking's owner. The reading before is checkpointed the moment it is taken and the
 *  program's own checkpoint is kept under `program`, so a step re-entered after a crash judges
 *  against what stood before the FIRST attempt rather than against what the program has already
 *  written. Both readings are taken at the provider, not at public resolvers, which answer from a
 *  cache for the record's TTL. */
export function bookedTxtProgramStep(ports: Pick<MailDnsPublishPorts, "dns">, serverId: string, booking: TxtBooking, program: Step): Step {
  return {
    name: program.name,
    title: program.title,
    run: async (ctx: StepCtx) => {
      const dns = requireMailDns(ports);
      const { cluster } = loadActiveCluster(ctx.db, serverId);
      const { owner, published } = await booking(cluster);
      const cp = ctx.readCheckpoint<BookedCheckpoint>() ?? {};
      // A reading in another shape (one keyed by record kind, taken before the names became the keys)
      // would answer null for every name and book every record as inserted; it is read again instead,
      // which can at worst book a write the program made as no change.
      const held = cp.before !== undefined && published.every(({ name }) => name in cp.before!) ? cp.before : undefined;
      const before = held ?? (await readPublishedTxt(dns, published, ctx.signal));
      cp.before = before;
      ctx.checkpoint(cp);
      await program.run({
        ...ctx,
        checkpoint: (data) => { cp.program = data; ctx.checkpoint(cp); },
        readCheckpoint: <T>() => cp.program as T | undefined,
      });
      const after = await readPublishedTxt(dns, published, ctx.signal);
      for (const { name } of published) {
        const stands = after[name] ?? null;
        const stood = before[name] ?? null;
        if (stands === null || stands === stood) continue;
        const act = stood === null ? "inserted" : "updated";
        recordDnsWrite(ctx.db, { name, type: "TXT", content: stands, act, owner: { kind: "mail", name: owner }, runId: ctx.runId });
        ctx.log("meta", `TXT ${name} ${act === "inserted" ? "inserted" : `updated from ${stood}`} → ${stands} — entered into the book of DNS writes`);
      }
    },
  };
}

/** The publish-mail-dns step with the book around it, over the sender domain's three records. */
export function bookedProgramStep(params: MailDnsPublishParams, ports: MailDnsPublishPorts, program: Step): Step {
  return bookedTxtProgramStep(ports, params.serverId, async ({ stage }) => ({ owner: params.senderDomain, published: senderDomainTxt(params.senderDomain, stage) }), program);
}

function requireMailDns(ports: Pick<MailDnsPublishPorts, "dns">): DnsProvider {
  if (!ports.dns) {
    throw errValidation("no DNS provider is wired into this manager — the published records are read there before and after the program, for the book of DNS writes");
  }
  return ports.dns;
}

function mailDnsPublishSteps(params: MailDnsPublishParams, ports: MailDnsPublishPorts): Step[] {
  const target = activeClusterTarget(params.serverId);
  return [
    attestClusterStep(target),
    bookedProgramStep(params, ports, ansiwiseProgramStep(target, MAIL_DNS_PROGRAM, ports, {
      extra: mailDnsAnswers(params, ports),
      // Silent degradation this run may not produce: a program that dropped one of these would
      // publish a record for the wrong domain, a wrong address, or reports to nobody.
      requiredAnswers: ["mail_domain", "egress_address", "dmarc_mailbox"],
    })),
  ];
}

export function makeMailDnsPublishDef(ports: MailDnsPublishPorts): RunDefinition<MailDnsPublishParams> {
  return {
    kind: "mail-dns-publish",
    paramsSchema: MailDnsPublishParams,
    mutating: true,
    plan: async (params, { db }) => {
      const { server, cluster } = loadActiveCluster(db, params.serverId);
      if (!isMasterRole(server.role)) {
        throw errValidation(
          `${server.name} is a ${server.role} — ${MAIL_DNS_PROGRAM} runs on the master: the relay stands there, the hand-filled input ` +
            "with the DNS token stands there, and the egress address the records name is the master's",
        );
      }
      const role = await publishableRole(ports, cluster.domain, params.senderDomain);
      const stepDefs = mailDnsPublishSteps(params, ports);
      return {
        kind: "mail-dns-publish",
        targetKind: "server",
        targetId: params.serverId,
        summary:
          `Publish the mail DNS of ${params.senderDomain} (${role}) through the DNS provider, from the master "${server.name}" ` +
          `(${cluster.domain}, ${cluster.stage}): the programs checkout's ${MAIL_DNS_PROGRAM} program merges the address mail leaves from into the ` +
          `domain's SPF (one v=spf1 record, everything already in it kept), publishes the DKIM key it is signed with, and sets ` +
          `DMARC ${params.dmarcPolicy} with reports to ${params.dmarcMailbox} — proved dry, then run, on the master's own record. ` +
          `The password you enter raises the program's root commands and is stored nowhere.`,
        steps: stepDefs.map((s) => ({ name: s.name, title: s.title })),
        targets: [{ serverId: server.id, ownsHost: true, label: `${server.name} (${server.role})` }],
        locks: [],
        warnings: [
          "The reverse DNS of the address mail leaves from is set at the hosting provider, not here — it gives the mail name, which must resolve back to that address.",
        ],
        requiredSecrets: [ANSIWISE_ELEVATION_SECRET],
      };
    },
    steps: (params) => mailDnsPublishSteps(params, ports),
  };
}
