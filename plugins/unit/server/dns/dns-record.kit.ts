// What the two run kinds that TAKE A DNS RECORD BACK share: the provider they delete at, the
// inventory they are allowed to delete by, and the one deletion itself.
//
// THE INVENTORY IS THE PERMISSION. Neither run kind may delete a name an operator types: the
// records this installation owns are exactly the ones dns-inventory.ts derives
// from the registrations, the cluster rows and the sender domains, and everything else in the zone
// belongs to somebody — the installer, the customer's own mail service, another installation. So
// both defs resolve their target IN the inventory, at the plan and again at the run's fail-closed
// first step, and refuse anything the inventory does not carry as removable. The book of DNS writes
// is the second permission: a record this Manager's own run wrote may be taken back after the
// inventory stopped deriving its name.
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
// nothing is deleted and the log says what stands and stays. Every record the book names is deleted
// by its booked content, and where that content stands nowhere the provider is not asked to delete
// at all: the book proves only what this Manager wrote, and a name that carries other content since
// is somebody else's now. Any other A or CNAME is a unit's own name and is deleted by name.
// `providerRemoval` is that rule, and the plan states its answer for each record.
import type { Db } from "#core/server/db/client.ts";
import type { StepCtx } from "#core/server/executor/types.ts";
import { errValidation } from "#core/server/kernel/errors.ts";
import { findDnsWrite, forgetDnsWrite } from "#core/server/db/dns-writes.ts";
import type { DnsProvider } from "#core/server/adapters/dns/port.ts";
import { DNS_WRITE_OWNER_KIND } from "#core/shared/enums.ts";
import type { DnsInventoryView, DnsOwner, DnsOwnerKind, DnsRecordRow, DnsRecordType, DnsRowType } from "#core/shared/dns.ts";
import { MAIL_RECORD_TAG, MAIL_TXT_RECORD, type MailTxtRecord } from "#core/shared/mail.ts";
import { judge } from "./dns-writes-view.ts";

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
        `The DNS inventory names ${rows.length} record(s); a name neither the inventory nor the book of DNS writes names belongs to somebody — the installer, the customer's own mail ` +
        "service, or an installation this one knows nothing about — and a read-only row is one this Manager may not take back: the sender " +
        "domain's address record is the installer's, the reverse DNS is set where the egress address is rented, and the platform domain's apex " +
        "SPF and DMARC are kept by its own mail service",
    );
  }
  return mine;
}

/** The row for ONE (name, type): the list of one. */
export function removableRecord(rows: DnsRecordRow[], name: string, type: DnsRowType): RemovableRecordRow {
  return removableRecords(rows, [{ name, type }])[0]!;
}

function asOwnerKind(kind: string): DnsOwnerKind {
  if ((DNS_WRITE_OWNER_KIND as readonly string[]).includes(kind)) {
    return kind as DnsOwnerKind;
  }
  throw errValidation(`unknown DNS write owner kind "${kind}" in the book of DNS writes`);
}

/** The booked write is the proof that this installation wrote the record, so a record whose name the
 *  inventory no longer derives is still this installation's to take back; a name neither the
 *  inventory nor the book names stays refused. */
export async function withBookedRows(
  db: Db,
  dns: DnsProvider,
  rows: DnsRecordRow[],
  records: ReadonlyArray<{ name: string; type: DnsRowType }>,
  signal?: AbortSignal,
): Promise<DnsRecordRow[]> {
  const result = [...rows];
  for (const { name, type } of records) {
    if (type === "PTR") continue;
    if (result.some((r) => r.name === name && r.type === type)) continue;
    const write = findDnsWrite(db, { name, type });
    if (!write) continue;
    const standing = await dns.listRecordContents({ name, type, ...(signal === undefined ? {} : { signal }) });
    const found = standing.length === 0 ? null : standing.join(" | ");
    const verdict = judge(standing, write.content);
    const owner: DnsOwner = {
      kind: asOwnerKind(write.owner.kind),
      name: write.owner.name,
      ...(write.owner.stage === undefined ? {} : { stage: write.owner.stage }),
    };
    result.push({
      owner,
      name,
      type,
      expected: write.content,
      found,
      verdict,
      removable: true,
    });
  }
  return result;
}

const isPublished = (record: DnsRecordRow["record"]): record is MailTxtRecord =>
  record !== undefined && (MAIL_TXT_RECORD as readonly string[]).includes(record);

/** What taking ONE record back deletes at the provider, the one rule the plan states and the remove
 *  step carries out, read against what stands at the name now (`standing`):
 *  - a booked record: exactly the booked content where it stands, and NOTHING where it stands nowhere,
 *    because whatever stands at the name then is content no run here wrote; the book only forgets
 *    its row;
 *  - an unbooked TXT: the record its mail record's tag picks, a record published before the book
 *    existed, and only where the mail measurement judged what stands this platform's (`standing`);
 *    a tagged record the measurement judged `other` is somebody's hand, and nothing is deleted;
 *  - an unbooked A or CNAME: every record of the name, which is the unit's own.
 *  `content` is what goes; undefined goes by name; null deletes nothing. */
export interface ProviderRemoval {
  content: string | null | undefined;
  booked: boolean;
}

export function providerRemoval(db: Db, row: RemovableRecordRow, standing: string[]): ProviderRemoval {
  const write = findDnsWrite(db, { name: row.name, type: row.type });
  if (write) return { content: standing.includes(write.content) ? write.content : null, booked: true };
  if (standing.length === 0) return { content: null, booked: false };
  if (row.type !== "TXT") return { content: undefined, booked: false };
  if (!isPublished(row.record)) {
    throw errValidation(
      `the inventory does not say which mail record TXT ${row.name} is, so nothing here can pick this installation's own among the records of the name — refusing to delete by name alone`,
    );
  }
  if (row.verdict !== "standing") return { content: null, booked: false };
  return { content: standing.find(MAIL_RECORD_TAG[row.record]) ?? null, booked: false };
}

/** The plan's sentence for what taking the record back does at the provider, from `providerRemoval`. */
export function removalSentence(row: RemovableRecordRow, standing: string[], removal: ProviderRemoval): string {
  const record = `the ${row.type} record ${row.name} (${ownerSentence(row)})`;
  if (removal.content === null) {
    if (standing.length === 0) return `${record}: nothing stands there, so nothing is deleted${removal.booked ? " and the book forgets its row" : ""}`;
    return `${record}: NOTHING is deleted at the provider — what stands there (${standing.join(" | ")}) is content no run here wrote, and it stays${removal.booked ? "; the book forgets its row" : ""}`;
  }
  if (removal.content === undefined) return `${record}: deletes every ${row.type} record of the name (${standing.join(" | ")})`;
  const left = standing.filter((c) => c !== removal.content);
  return `${record}: deletes ${removal.content}${left.length > 0 ? `, and ${left.join(" | ")} stays` : ""}`;
}

/** Delete ONE record and say what stood there. What stands is read BEFORE the deletion, because
 *  afterwards nothing anywhere can say what the zone carried — the run log is the only record of it.
 *  What goes is `providerRemoval`'s answer; where it deletes nothing, the provider is not asked to
 *  delete at all, so a resumed run is safe. The book of DNS writes loses its row on every removal,
 *  because the operator asked to take the write back and a write whose content stands nowhere is
 *  gone either way; the other records of the name stay and the log names them. */
export async function deleteRecord(ctx: StepCtx, dns: DnsProvider, row: RemovableRecordRow): Promise<void> {
  const standing = await dns.listRecordContents({ name: row.name, type: row.type, signal: ctx.signal });
  const { content, booked } = providerRemoval(ctx.db, row, standing);
  if (content === null) {
    forgetDnsWrite(ctx.db, { name: row.name, type: row.type });
    ctx.checkpoint({ record: row.name, type: row.type, standing, deleted: 0 });
    ctx.log(
      "meta",
      standing.length === 0
        ? `no ${row.type} record ${row.name} to remove — already absent${booked ? "; the book forgets the write" : ""}`
        : `no ${row.type} record ${row.name} of this installation's to remove — the ${standing.length} record(s) of the name (${standing.join(", ")}) carry content no run here wrote and stay, and the provider was not asked to delete anything${booked ? "; the book forgets the write" : ""}`,
    );
    return;
  }
  const { deleted } = await dns.deleteRecord({ name: row.name, type: row.type, ...(content === undefined ? {} : { content }), signal: ctx.signal });
  const left = standing.length - deleted;
  forgetDnsWrite(ctx.db, { name: row.name, type: row.type });
  ctx.checkpoint({ record: row.name, type: row.type, stood: content ?? standing[0] ?? null, deleted, left });
  ctx.log(
    "meta",
    deleted > 0
      ? `${row.type} ${row.name} stood at ${content ?? standing[0] ?? "content the provider did not answer"} and is gone (${deleted} removed${left > 0 ? `, ${left} other record(s) of the name left standing` : ""})`
      : `no ${row.type} record ${row.name} to remove — it went between the reading and the deletion`,
  );
}
