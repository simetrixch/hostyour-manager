// The book of DNS writes as the DNS page shows it first: every row db/dns-writes.ts holds, each
// read at the provider NOW and judged against the content the book recorded. The reading is taken
// at the provider for every row, the mail rows included, although the inventory measures those at
// public resolvers: the book's question is "does what this Manager wrote still stand where it wrote
// it", and the provider is where it wrote it — a public resolver answers the receiver's question
// and lags a write by the record's TTL, which would paint a row absent minutes after its run.
import type { Db } from "../../db/client.ts";
import { listDnsWrites } from "../../db/dns-writes.ts";
import type { DnsProvider } from "../../adapters/dns/port.ts";
import type { DnsVerdict, DnsWriteRow, DnsWritesView } from "../../../shared/dns.ts";

export interface DnsWritesDeps {
  db: Db;
  /** Absent on a manager with no DNS token: the rows are then listed without a reading, and the
   *  view says so — the book is the Manager's own record and stands whether the zone can be asked. */
  dns?: DnsProvider;
}

/** Standing where the recorded content is among the records of the name; absent where none stands;
 *  other where records stand and none of them is the one this Manager wrote. */
function judge(found: string[], content: string): DnsVerdict {
  return found.length === 0 ? "absent" : found.includes(content) ? "standing" : "other";
}

export async function readDnsWrites(deps: DnsWritesDeps): Promise<DnsWritesView> {
  const rows: DnsWriteRow[] = [];
  const skipped: string[] = [];
  if (!deps.dns) {
    skipped.push("the rows are listed without a reading: this manager has no DNS provider wired (CLOUDFLARE_DNS_API_TOKEN unset), so what stands at the provider now cannot be asked");
  }
  for (const write of listDnsWrites(deps.db)) {
    const found = deps.dns ? await deps.dns.listRecordContents({ name: write.name, type: write.type }) : null;
    rows.push({
      ...write,
      writtenAt: write.writtenAt.toISOString(),
      found: found === null || found.length === 0 ? null : found.join(" | "),
      verdict: found === null ? null : judge(found, write.content),
    });
  }
  return { rows, skipped, readAt: new Date().toISOString() };
}
