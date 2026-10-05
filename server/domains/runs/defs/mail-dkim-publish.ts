import { z } from "zod";
import type { RunDefinition, Step } from "../../../executor/types.ts";
import { errValidation } from "../../../kernel/errors.ts";
import { STAGE, isMasterRole, type Stage } from "../../../../shared/enums.ts";
import { MAIL_RECORD_TAG, mailRecordNames } from "../../../../shared/mail.ts";
import { activeClusterTarget } from "./deploy-slave.kit.ts";
import { attestClusterStep, loadActiveCluster } from "./live-cluster.kit.ts";
import { ansiwiseProgramStep, ANSIWISE_ELEVATION_SECRET, type ExtraAnswers } from "./ansiwise-run.kit.ts";
import { bookedTxtProgramStep, senderDomainsOf, type MailDnsPublishPorts, type TxtBooking } from "./mail-dns-publish.ts";

// mail-dkim-publish: publish the DKIM key the platform's mail transfer agent signs the platform domain
// with, by running the programs checkout's publish-mail-dkim program on the master. The platform
// domain's other mail records belong to its own mail service (mail-dns-publish refuses them), but the
// MTA of the stage's mail sender signs mail sent as that domain under the stage as its selector, and
// receivers verify that signature at <stage>._domainkey.<platform domain>. The program writes that one
// record and touches nothing else.
//
// WHAT IS ANSWERED, AND FROM WHERE. `stage` is the cluster row's (composeAnswers reads the inventory)
// and names the master's hand-filled input. `mail_domain` is the platformDomain of the master's map,
// never a parameter, so the run can name no other domain. `dkim_selector` is the run's stage, the
// stage of the signing MTA, which may differ from the master's. `dkim_public_key` is the key that
// stage's mail sender signs with, as the Mail page reads it (MailEgress); the relay's key in the store
// signs other mail and is never published here.
//
// WHAT THE BOOK OF DNS WRITES LEARNS: the difference of the one DKIM record, read at the provider
// before and after the program (bookedTxtProgramStep), entered as a mail record of the platform domain.

export const PLATFORM_DKIM_PROGRAM = "publish-mail-dkim";

export const MailDkimPublishParams = z.object({
  serverId: z.string().startsWith("srv_"),
  /** The stage whose mail sender signs: its key is published under this stage as the selector. */
  stage: z.enum(STAGE),
});
export type MailDkimPublishParams = z.infer<typeof MailDkimPublishParams>;

/** The stage's mail sender and the public key it signs the platform domain with. Fail-closed: a
 *  record without the signer's key makes receivers fail mail that is otherwise fine. */
async function signerKeyOf(ports: MailDnsPublishPorts, stage: Stage, masterDomain: string, platformDomain: string): Promise<{ unit: string; key: string }> {
  if (!ports.mailEgress) throw errValidation("no mail reading is wired into this manager — the signer's key has no other source");
  const out = await ports.mailEgress(stage, masterDomain);
  if (out.sender === null) {
    throw errValidation(`no unit declares an SMTP entry at ${stage}: nothing signs ${platformDomain}'s mail with a key of its own, so there is no key to publish`);
  }
  if (out.dkimPublicKey === null) {
    throw errValidation(
      `the mail sender ${out.sender.unit} at ${stage} holds no DKIM public key: it is kept at the onboarding that mints the pair, and a record without the signer's key makes receivers fail its mail`,
    );
  }
  return { unit: out.sender.unit, key: out.dkimPublicKey };
}

/** What `publish-mail-dkim` is answered with beyond the inventory: the platform domain, the selector
 *  and the signer's public key. */
export function platformDkimAnswers(params: MailDkimPublishParams, ports: MailDnsPublishPorts): ExtraAnswers {
  return async (ctx) => {
    const { cluster } = loadActiveCluster(ctx.db, params.serverId);
    const { platformDomain } = await senderDomainsOf(ports, cluster.domain);
    const signer = await signerKeyOf(ports, params.stage, cluster.domain, platformDomain);
    ctx.log(
      "meta",
      `${PLATFORM_DKIM_PROGRAM} is told mail_domain=${platformDomain}, dkim_selector=${params.stage}, the public key of ${signer.unit} (p=${signer.key.slice(0, 16)}…)`,
    );
    return { mail_domain: platformDomain, dkim_selector: params.stage, dkim_public_key: signer.key };
  };
}

/** The DKIM record under the signing stage's selector, booked as a mail record of the platform domain. */
export function platformDkimBooking(ports: MailDnsPublishPorts, stage: Stage): TxtBooking {
  return async (cluster) => {
    const { platformDomain } = await senderDomainsOf(ports, cluster.domain);
    return { owner: platformDomain, published: [{ name: mailRecordNames(platformDomain, stage).dkim, tag: MAIL_RECORD_TAG.dkim }] };
  };
}

function platformDkimSteps(params: MailDkimPublishParams, ports: MailDnsPublishPorts): Step[] {
  const target = activeClusterTarget(params.serverId);
  return [
    attestClusterStep(target),
    bookedTxtProgramStep(ports, params.serverId, platformDkimBooking(ports, params.stage), ansiwiseProgramStep(target, PLATFORM_DKIM_PROGRAM, ports, {
      extra: platformDkimAnswers(params, ports),
      // A program that dropped one would publish under another name, another selector or no key.
      requiredAnswers: ["mail_domain", "dkim_selector", "dkim_public_key"],
    })),
  ];
}

export function makeMailDkimPublishDef(ports: MailDnsPublishPorts): RunDefinition<MailDkimPublishParams> {
  return {
    kind: "mail-dkim-publish",
    paramsSchema: MailDkimPublishParams,
    mutating: true,
    plan: async (params, { db }) => {
      const { server, cluster } = loadActiveCluster(db, params.serverId);
      if (!isMasterRole(server.role)) {
        throw errValidation(
          `${server.name} is a ${server.role} — ${PLATFORM_DKIM_PROGRAM} runs on the master: the hand-filled input with the DNS token stands there`,
        );
      }
      const { platformDomain } = await senderDomainsOf(ports, cluster.domain);
      const signer = await signerKeyOf(ports, params.stage, cluster.domain, platformDomain);
      const name = mailRecordNames(platformDomain, params.stage).dkim;
      return {
        kind: "mail-dkim-publish",
        targetKind: "server",
        targetId: params.serverId,
        summary:
          `Publish the DKIM key the mail sender ${signer.unit} signs ${platformDomain}'s mail with at ${params.stage}, under ${name}, through the DNS provider, ` +
          `from the master "${server.name}" (${cluster.domain}, ${cluster.stage}): the programs checkout's ${PLATFORM_DKIM_PROGRAM} program writes that one record ` +
          `— proved dry, then run, on the master's own record. Nothing else of ${platformDomain} is touched: its apex SPF, its MX, its mail service's own DKIM ` +
          "selectors and its DMARC policy stay that service's. The password you enter raises the program's root commands and is stored nowhere.",
        steps: platformDkimSteps(params, ports).map((s) => ({ name: s.name, title: s.title })),
        targets: [{ serverId: server.id, ownsHost: true, label: `${server.name} (${server.role})` }],
        locks: [],
        warnings: [],
        requiredSecrets: [ANSIWISE_ELEVATION_SECRET],
      };
    },
    steps: (params) => platformDkimSteps(params, ports),
  };
}
