import { z } from "zod";
import type { RunDefinition, Step } from "../../../executor/types.ts";
import { errValidation } from "../../../kernel/errors.ts";
import { isMasterRole } from "../../../../shared/enums.ts";
import { MAIL_RECORD_TAG, envelopeDomainOf, spfHostMechanism } from "../../../../shared/mail.ts";
import { activeClusterTarget } from "./deploy-slave.kit.ts";
import { attestClusterStep, loadActiveCluster } from "./live-cluster.kit.ts";
import { ansiwiseProgramStep, ANSIWISE_ELEVATION_SECRET, type ExtraAnswers } from "./ansiwise-run.kit.ts";
import { bookedTxtProgramStep, requireMailEgress, senderDomainsOf, type MailDnsPublishPorts, type TxtBooking } from "./mail-dns-publish.ts";

// mail-envelope-spf-publish: publish the SPF of the name the platform's mail transfer agent sends its
// envelope from, mail.<platform domain> (shared/mail.ts envelopeDomainOf), by running the programs
// checkout's publish-envelope-spf program on the master. Receivers check SPF for the envelope sender's
// domain, so this record is what authorises the egress address for the platform's customer mail. The
// platform domain's own records belong to its own mail service (mail-dns-publish refuses them); the
// program writes the one record at the envelope name and touches nothing else.
//
// WHAT IS ANSWERED, AND FROM WHERE. `stage` is the cluster row's (composeAnswers reads the inventory);
// `envelope_domain` is composed from the platformDomain of the master's map; `egress_address` is the
// Mail page's reading of where the stage's mail leaves (MailEgress), resolved at public DNS and never
// typed; `egress_host` comes from the reverse DNS of the egress address, forward-confirmed.
//
// WHAT THE BOOK OF DNS WRITES LEARNS: the difference of the SPF at the envelope name, read at the
// provider before and after the program (bookedTxtProgramStep), entered as a mail record of the
// platform domain.

export const ENVELOPE_SPF_PROGRAM = "publish-envelope-spf";

export const MailEnvelopeSpfPublishParams = z.object({
  serverId: z.string().startsWith("srv_"),
});
export type MailEnvelopeSpfPublishParams = z.infer<typeof MailEnvelopeSpfPublishParams>;

/** What `publish-envelope-spf` is answered with beyond the inventory: the envelope name and the
 *  address mail leaves from. Fail-closed where the name mail leaves by resolves to no address: a
 *  guessed address in the SPF makes receivers fail the mail. */
export function envelopeSpfAnswers(params: MailEnvelopeSpfPublishParams, ports: MailDnsPublishPorts): ExtraAnswers {
  return async (ctx) => {
    const { cluster } = loadActiveCluster(ctx.db, params.serverId);
    const { platformDomain } = await senderDomainsOf(ports, cluster.domain);
    const out = await requireMailEgress(ports, cluster.stage, cluster.domain);
    const envelope = envelopeDomainOf(platformDomain);
    ctx.log(
      "meta",
      `${ENVELOPE_SPF_PROGRAM} is told envelope_domain=${envelope}, egress_address=${out.address} (${out.name}` +
        `${out.sender !== null ? `, where the mail sender ${out.sender.unit} stands` : ", the master"}), ` +
        `egress_host=${out.host}`,
    );
    return { envelope_domain: envelope, egress_address: out.address, egress_host: out.host };
  };
}

/** The SPF at the envelope name, booked as a mail record of the platform domain. */
export function envelopeSpfBooking(ports: MailDnsPublishPorts): TxtBooking {
  return async (cluster) => {
    const { platformDomain } = await senderDomainsOf(ports, cluster.domain);
    return { owner: platformDomain, published: [{ name: envelopeDomainOf(platformDomain), tag: MAIL_RECORD_TAG["envelope-spf"] }] };
  };
}

function envelopeSpfSteps(params: MailEnvelopeSpfPublishParams, ports: MailDnsPublishPorts): Step[] {
  const target = activeClusterTarget(params.serverId);
  return [
    attestClusterStep(target),
    bookedTxtProgramStep(ports, params.serverId, envelopeSpfBooking(ports), ansiwiseProgramStep(target, ENVELOPE_SPF_PROGRAM, ports, {
      extra: envelopeSpfAnswers(params, ports),
      // A program that dropped either would write the SPF at another name or for another address.
      requiredAnswers: ["envelope_domain", "egress_address", "egress_host"],
    })),
  ];
}

export function makeMailEnvelopeSpfPublishDef(ports: MailDnsPublishPorts): RunDefinition<MailEnvelopeSpfPublishParams> {
  return {
    kind: "mail-envelope-spf-publish",
    paramsSchema: MailEnvelopeSpfPublishParams,
    mutating: true,
    plan: async (params, { db }) => {
      const { server, cluster } = loadActiveCluster(db, params.serverId);
      if (!isMasterRole(server.role)) {
        throw errValidation(
          `${server.name} is a ${server.role} — ${ENVELOPE_SPF_PROGRAM} runs on the master: the hand-filled input with the DNS token stands there`,
        );
      }
      const { platformDomain } = await senderDomainsOf(ports, cluster.domain);
      const envelope = envelopeDomainOf(platformDomain);
      const out = await requireMailEgress(ports, cluster.stage, cluster.domain);
      return {
        kind: "mail-envelope-spf-publish",
        targetKind: "server",
        targetId: params.serverId,
        summary:
          `Publish the SPF of ${envelope}, the name the platform's mail transfer agent sends its envelope from, through the DNS provider, ` +
          `from the master "${server.name}" (${cluster.domain}, ${cluster.stage}): the programs checkout's ${ENVELOPE_SPF_PROGRAM} program sets ` +
          `the SPF of ${envelope} to name the host mail leaves by, ${out.host}, as ${spfHostMechanism(envelope, out.host)} (a fresh record reads ` +
          `v=spf1 ${spfHostMechanism(envelope, out.host)} -all; the mechanism costs one of the ten DNS lookups SPF allows). ` +
          `It replaces an ip4 of the egress address where one stands, and creates the record closing with -all where none stands — proved dry, ` +
          `then run, on the master's own record. Nothing of ${platformDomain} itself is touched. The password you enter raises the program's root ` +
          "commands and is stored nowhere.",
        steps: envelopeSpfSteps(params, ports).map((s) => ({ name: s.name, title: s.title })),
        targets: [{ serverId: server.id, ownsHost: true, label: `${server.name} (${server.role})` }],
        locks: [],
        warnings: [
          `${envelope} must keep its own address record and the reverse DNS of the egress address, which are set where the address is rented, not here.`,
        ],
        requiredSecrets: [ANSIWISE_ELEVATION_SECRET],
      };
    },
    steps: (params) => envelopeSpfSteps(params, ports),
  };
}
