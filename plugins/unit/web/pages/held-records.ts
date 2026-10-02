import type { DnsInventoryView } from "#core/shared/dns.ts";
import { recordKey } from "./DnsWrites.tsx";

/** The records the inventory lists read-only, by record key, each with the party that keeps it — what
 *  the book's table may not offer for removal, such as the platform domain's apex SPF, which its own
 *  mail service keeps although this Manager once wrote it. Empty until the inventory is read; the
 *  run's own resolution in the inventory stays the permission. */
export function heldRecords(inventory: DnsInventoryView | null): ReadonlyMap<string, string> {
  return new Map((inventory?.rows ?? []).filter((row) => !row.removable).map((row) => [recordKey(row), `the ${row.owner.kind} "${row.owner.name}"`]));
}
