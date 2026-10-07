import { z } from "zod";
import type { RunDefinition, Step } from "../../../executor/types.ts";
import { ATTEST_TARGET_STEP } from "../../../executor/guards.ts";
import { errValidation } from "../../../kernel/errors.ts";
import { findDnsWrite, recordDnsWrite, type DnsWrite } from "../../../db/dns-writes.ts";
import type { Db } from "../../../db/client.ts";
import type { DnsProvider } from "../../../adapters/dns/port.ts";
import { dmarcRecordName, MAIL_RECORD_TAG } from "../../../../shared/mail.ts";
import { requireDnsProvider, type DnsRecordPorts } from "#unit/server/dns/dns-record.kit.ts";
import { senderDomain } from "./mail-dns-publish.ts";

// mail-dmarc-publish: change only the report mailbox (rua) of ONE DMARC record this Manager once
// published, at the DNS provider.
//
// WHY ONLY THE REPORT MAILBOX. A sender domain's DMARC record names the mailbox receivers send their
// aggregate reports to. The normal writer of mail DNS (mail-dns-publish) writes all three records
// at once and merges the SPF, accepting only domains on the master's cluster map. This run kind
// allows rewriting just the rua tag of an existing DMARC record this Manager published, also for a
// former sender domain no longer on the map, leaving every other record and tag untouched.
//
// THE PERMISSION IS THE BOOK. Only a DMARC record whose row exists in the book of DNS writes with
// owner kind "mail" and owner name equal to the domain can be changed here.

export const MailDmarcPublishParams = z.object({
  /** One domain whose DMARC record this Manager once published. */
  domain: senderDomain,
  /** Where receivers send their aggregate reports — a mailbox somebody reads. */
  dmarcMailbox: z.string().email(),
});
export type MailDmarcPublishParams = z.infer<typeof MailDmarcPublishParams>;

export type MailDmarcPublishPorts = Pick<DnsRecordPorts, "dns">;

/** The book's row of the domain's DMARC record, REFUSED unless this Manager published it as mail DNS. */
function bookedDmarcOf(db: Db, domain: string): DnsWrite {
  const name = dmarcRecordName(domain);
  const row = findDnsWrite(db, { name, type: "TXT" });
  if (row === null || row.owner.kind !== "mail" || row.owner.name !== domain) {
    throw errValidation(
      `the book of DNS writes holds no DMARC record of ${domain} that a run of this Manager published — only such a record's report mailbox is changed here, and the DMARC records of any other domain are not this platform's to write`,
    );
  }
  return row;
}

/** Read what stands under the DMARC name at the provider, refusing unless exactly one DMARC record stands. */
async function readStandingDmarc(dns: DnsProvider, name: string, signal?: AbortSignal): Promise<string> {
  const contents = await dns.listRecordContents({ name, type: "TXT", ...(signal ? { signal } : {}) });
  if (contents.length !== 1) {
    throw errValidation(`${contents.length} TXT records stand under ${name} — refusing to pick one to rewrite`);
  }
  const stood = contents[0]!;
  if (!MAIL_RECORD_TAG.dmarc(stood)) {
    throw errValidation(`the TXT record under ${name} is not a DMARC record (v=DMARC1): ${stood}`);
  }
  return stood;
}

/** Pure helper: replace the rua tag's mailbox in a DMARC record string, keeping all other tags and order. */
export function withReportMailbox(record: string, mailbox: string): string {
  const tags = record
    .split(";")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  const ruaIndices: number[] = [];
  for (let i = 0; i < tags.length; i++) {
    const eq = tags[i]!.indexOf("=");
    if (eq !== -1 && tags[i]!.slice(0, eq).trim().toLowerCase() === "rua") {
      ruaIndices.push(i);
    }
  }
  if (ruaIndices.length === 0) {
    throw errValidation(`${record} carries no rua tag; publish the domain's mail DNS instead`);
  }
  if (ruaIndices.length > 1) {
    throw errValidation(`${record} carries ${ruaIndices.length} rua tags — refusing to pick one to rewrite`);
  }
  const idx = ruaIndices[0]!;
  const eq = tags[idx]!.indexOf("=");
  const key = tags[idx]!.slice(0, eq).trim();
  tags[idx] = `${key}=mailto:${mailbox}`;
  return tags.join("; ");
}

function mailDmarcPublishSteps(params: MailDmarcPublishParams, ports: MailDmarcPublishPorts): Step[] {
  return [
    {
      name: ATTEST_TARGET_STEP,
      title: "Attest the DMARC record is one this Manager published",
      run: async (ctx) => {
        const dns = requireDnsProvider(ports);
        bookedDmarcOf(ctx.db, params.domain);
        const name = dmarcRecordName(params.domain);
        const stood = await readStandingDmarc(dns, name, ctx.signal);
        const next = withReportMailbox(stood, params.dmarcMailbox);
        ctx.checkpoint({ name, stood, next });
        ctx.log("meta", `TXT ${name} stands at ${stood}; the report mailbox becomes ${params.dmarcMailbox}, every other tag stays`);
      },
    },
    {
      name: "write-dmarc",
      title: "Write the DMARC record with the new report mailbox at the DNS provider",
      run: async (ctx) => {
        const dns = requireDnsProvider(ports);
        const name = dmarcRecordName(params.domain);
        const standing = await readStandingDmarc(dns, name, ctx.signal);
        // A step re-entered after a crash finds its own write standing. The checkpoint taken before the
        // write still names what stood, so the book and the undo are completed from it, not skipped.
        const held = ctx.readCheckpoint<{ stood: string; next: string }>();
        const stood = held?.next === standing ? held.stood : standing;
        const next = withReportMailbox(stood, params.dmarcMailbox);
        if (stood === next) {
          ctx.log("meta", `TXT ${name} already stands`);
          return;
        }
        ctx.checkpoint({ stood, next });
        ctx.registerCleanup({
          name: "restore-dmarc",
          title: `Restore the DMARC record of ${params.domain} at the DNS provider`,
          run: async (c) => {
            const d = requireDnsProvider(ports);
            const contents = await d.listRecordContents({ name, type: "TXT", signal: c.signal });
            if (contents.length === 1 && contents[0] === next) {
              await d.upsertRecord({ name, type: "TXT", content: stood, signal: c.signal });
              recordDnsWrite(c.db, {
                name,
                type: "TXT",
                content: stood,
                act: "updated",
                owner: { kind: "mail", name: params.domain },
                runId: c.runId,
              });
              c.log("meta", `TXT ${name} restored from ${next} → ${stood} — entered into the book of DNS writes`);
            }
          },
        });
        if (standing !== next) await dns.upsertRecord({ name, type: "TXT", content: next, signal: ctx.signal });
        recordDnsWrite(ctx.db, {
          name,
          type: "TXT",
          content: next,
          act: "updated",
          owner: { kind: "mail", name: params.domain },
          runId: ctx.runId,
        });
        ctx.log("meta", `TXT ${name} updated from ${stood} → ${next} — entered into the book of DNS writes`);
      },
    },
  ];
}

export function makeMailDmarcPublishDef(ports: MailDmarcPublishPorts): RunDefinition<MailDmarcPublishParams> {
  return {
    kind: "mail-dmarc-publish",
    paramsSchema: MailDmarcPublishParams,
    mutating: true,
    plan: async (params, { db }) => {
      const dns = requireDnsProvider(ports);
      bookedDmarcOf(db, params.domain);
      const name = dmarcRecordName(params.domain);
      const stood = await readStandingDmarc(dns, name);
      const next = withReportMailbox(stood, params.dmarcMailbox);
      const steps = mailDmarcPublishSteps(params, ports);
      return {
        kind: "mail-dmarc-publish",
        targetKind: "self",
        targetId: "manager",
        summary:
          `Change the report mailbox of ${name}: it stands at ${stood} and becomes ${next} at the DNS provider. ` +
          "The policy and every other tag stay, and no other record is written: not the domain's SPF, not its DKIM key, not its address record.",
        steps: steps.map((s) => ({ name: s.name, title: s.title })),
        warnings: [],
        requiredSecrets: [],
      };
    },
    steps: (params) => mailDmarcPublishSteps(params, ports),
  };
}
