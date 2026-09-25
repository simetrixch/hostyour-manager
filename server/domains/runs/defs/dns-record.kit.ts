// What the two run kinds that TAKE A DNS RECORD BACK share: the provider they delete at, the
// inventory they are allowed to delete by, and the one deletion itself.
//
// THE INVENTORY IS THE PERMISSION. Neither run kind may delete a name an operator types: the
// records this installation owns are exactly the ones server/domains/dns/dns-inventory.ts derives
// from the registrations, the cluster rows and the sender domains, and everything else in the zone
// belongs to somebody — the installer, the customer's own mail service, another installation. So
// both defs resolve their target IN the inventory, at the plan and again at the run's fail-closed
// first step, and refuse anything the inventory does not carry as removable.
//
// It arrives as a FUNCTION rather than as an import: the run definitions are assembled in this
// domain and the inventory lives in the DNS domain, which no module of another domain may import
// (.dependency-cruiser.cjs domains-no-crosstalk). server/boot/wire.ts binds it.
//
// A TXT IS DELETED BY CONTENT, NEVER BY NAME ALONE. A sender domain's apex carries other services'
// TXT beside the SPF (a mailbox provider's verification, a search console's), and a deletion by
// (name, type) would take them all. The content this platform owns is what the book of DNS writes
// says it wrote; for a record published before the book existed, it is the record the mail
// record's tag picks among those standing at the provider now. Where neither names a record,
// nothing is deleted and the log says what stands and stays. An A record is a unit's own name and
// is deleted as before.
import type { StepCtx } from "../../../executor/types.ts";
import { errValidation } from "../../../kernel/errors.ts";
import { findDnsWrite, forgetDnsWrite } from "../../../db/dns-writes.ts";
import type { DnsProvider } from "../../../adapters/dns/port.ts";
import type { DnsInventoryView, DnsRecordRow, DnsRecordType, DnsRowType } from "../../../../shared/dns.ts";
import { MAIL_RECORD_TAG, PUBLISHED_MAIL_RECORD, type PublishedMailRecord } from "../../../../shared/mail.ts";

/** A row of the inventory this Manager may take back — never a PTR, which stands where the egress
 *  address is rented rather than in the zone. */
export type RemovableRecordRow = DnsRecordRow & { type: DnsRecordType };

export interface DnsRecordPorts {
  /** The provider the record is deleted at. Absent on a manager with no DNS token: the run kind
   *  then refuses at its plan rather than reporting a removal nobody made. */
  dns?: DnsProvider;
  /** The DNS inventory, read now — the one statement of which records this installation owns. */
  readDnsInventory?: () => Promise<DnsInventoryView>;
}

export function requireDnsProvider(ports: DnsRecordPorts): DnsProvider {
  if (!ports.dns) {
    throw errValidation(
      "no DNS provider is wired into this manager (CLOUDFLARE_DNS_API_TOKEN unset) — the record stands at the provider and nothing else can take it back",
    );
  }
  return ports.dns;
}

/** The inventory as the refusal reads it. A manager without the DNS domain wired owns no statement
 *  of what it owns, and a removal decided without one would be a deletion by typed name. */
export async function ownedRecords(ports: DnsRecordPorts): Promise<DnsRecordRow[]> {
  if (!ports.readDnsInventory) {
    throw errValidation("the DNS inventory is not wired into this manager — which records this installation owns is what decides whether a removal is allowed at all");
  }
  return (await ports.readDnsInventory()).rows;
}

/** Whose record this is, in the sentence the plan and the log both use. */
export function ownerSentence(row: DnsRecordRow): string {
  const stage = row.owner.stage === undefined ? "" : ` at ${row.owner.stage}`;
  return `the ${row.owner.kind} "${row.owner.name}"${stage}`;
}

/** The rows for a LIST of (name, type), REFUSED AS A WHOLE unless this installation owns every one
 *  and may take every one back. The operator ticked a set, and a plan that quietly dropped the
 *  records it may not touch and deleted the rest would remove something other than what was asked.
 *  The one sentence counts the refused records and names each with its own reason, because a name
 *  nobody here wrote and a record this platform lists but does not own are two different mistakes,
 *  and one reason for both would send the operator looking in the wrong place. */
export function removableRecords(rows: DnsRecordRow[], records: ReadonlyArray<{ name: string; type: DnsRowType }>): RemovableRecordRow[] {
  const mine: RemovableRecordRow[] = [];
  const refused: string[] = [];
  for (const { name, type } of records) {
    const row = rows.find((r) => r.name === name && r.type === type);
    if (!row) refused.push(`this installation owns no ${type} record ${name}`);
    else if (!row.removable || row.type === "PTR") refused.push(`the ${type} record ${name} is listed read-only: it is ${ownerSentence(row)}'s`);
    else mine.push({ ...row, type: row.type });
  }
  if (refused.length > 0) {
    throw errValidation(
      `${refused.length} of the ${records.length} record(s) cannot be taken back, so none is: ${refused.join("; ")}. ` +
        `The DNS inventory names ${rows.length} record(s); a name not among them belongs to somebody — the installer, the customer's own mail ` +
        "service, or an installation this one knows nothing about — and a read-only row is one no run of this Manager wrote: the sender " +
        "domain's address record is the installer's and the reverse DNS is set where the egress address is rented",
    );
  }
  return mine;
}

/** The row for ONE (name, type): the list of one. */
export function removableRecord(rows: DnsRecordRow[], name: string, type: DnsRowType): RemovableRecordRow {
  return removableRecords(rows, [{ name, type }])[0]!;
}

const isPublished = (record: DnsRecordRow["record"]): record is PublishedMailRecord =>
  record !== undefined && (PUBLISHED_MAIL_RECORD as readonly string[]).includes(record);

/** The content of OUR record under a TXT name, or null where none of ours stands: what the book says
 *  this Manager wrote, else the record the mail record's tag picks among `standing` — a record
 *  published before the book existed. */
function ownedTxtContent(ctx: StepCtx, row: RemovableRecordRow, standing: string[]): string | null {
  const booked = findDnsWrite(ctx.db, { name: row.name, type: row.type });
  if (booked) return booked.content;
  if (!isPublished(row.record)) {
    throw errValidation(
      `the inventory does not say which mail record TXT ${row.name} is, so nothing here can pick this installation's own among the records of the name — refusing to delete by name alone`,
    );
  }
  return standing.find(MAIL_RECORD_TAG[row.record]) ?? null;
}

/** Delete ONE record and say what stood there. What stands is read BEFORE the deletion, because
 *  afterwards nothing anywhere can say what the zone carried — the run log is the only record of it.
 *  Absent is the idempotent no-op (a delete resolves 0), so a resumed run is safe. A TXT is deleted
 *  by the content this platform owns (the header states the rule), and the other records of the
 *  name are counted and left. The book of DNS writes loses its row here, the one place both run
 *  kinds delete through — unless the name still carries content this Manager did not write, in
 *  which case the row stays and the DNS page keeps showing what became of the write. */
export async function deleteRecord(ctx: StepCtx, dns: DnsProvider, row: RemovableRecordRow): Promise<void> {
  const standing = await dns.listRecordContents({ name: row.name, type: row.type, signal: ctx.signal });
  let content: string | undefined;
  if (row.type === "TXT") {
    const owned = ownedTxtContent(ctx, row, standing);
    if (owned === null) {
      ctx.checkpoint({ record: row.name, type: row.type, standing, deleted: 0 });
      ctx.log("meta", standing.length === 0
        ? `no TXT record ${row.name} to remove — already absent`
        : `no TXT record ${row.name} of this installation's to remove — the ${standing.length} record(s) of the name carry content no run here wrote and stay`);
      return;
    }
    content = owned;
  }
  const { deleted } = await dns.deleteRecord({ name: row.name, type: row.type, ...(content === undefined ? {} : { content }), signal: ctx.signal });
  const left = standing.length - deleted;
  if (deleted > 0 || left === 0) forgetDnsWrite(ctx.db, { name: row.name, type: row.type });
  ctx.checkpoint({ record: row.name, type: row.type, stood: content ?? standing[0] ?? null, deleted, left });
  ctx.log(
    "meta",
    deleted > 0
      ? `${row.type} ${row.name} stood at ${content ?? standing[0] ?? "content the provider did not answer"} and is gone (${deleted} removed${left > 0 ? `, ${left} other record(s) of the name left standing` : ""})`
      : left > 0
        ? `no ${row.type} record ${row.name} at ${content} to remove — the ${left} record(s) of the name carry other content and stay`
        : `no ${row.type} record ${row.name} to remove — already absent`,
  );
}
