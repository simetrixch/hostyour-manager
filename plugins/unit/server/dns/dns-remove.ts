import { z } from "zod";
import type { RunDefinition, Step } from "#core/server/executor/types.ts";
import { ATTEST_TARGET_STEP } from "#core/server/executor/guards.ts";
import { DNS_RECORD_TYPE, type DnsRecordType } from "#core/shared/dns.ts";
import { deleteRecord, ownedRecords, ownerSentence, providerRemoval, removableRecord, removableRecords, removalSentence, requireDnsProvider, withBookedRows, type DnsRecordPorts } from "./dns-record.kit.ts";

// dns-remove: take records of this installation back at the DNS provider, one run for the whole
// list — the records an abandoned installation leaves in the zone when its machines are restored
// bare and its units are never offboarded (the leftover unit-dns.ts readStandingHost names: a host
// that still answers with the address of a machine that is gone). One run and one approve for the
// set, because a zone cleared one run at a time is a dozen approves for a dozen records.
//
// WHAT IT MAY DELETE is decided by the DNS inventory and never by the operator's typing: the plan
// resolves every (name, type) in it and refuses the WHOLE list when any record is a name this
// installation does not own or a row it lists read-only. The same resolution is taken AGAIN at
// attest-target, which is this run's fail-closed precondition: a plan can stand approved for a
// while, and a record that stopped being ours in the meantime must not be deleted on the strength
// of what was true then. Each remove step then resolves ITS record once more before the delete.
//
// IT REACHES NO MACHINE. The records are in the zone, so the target is this manager itself and the
// run carries no elevation password, no session and no program.

const DnsRemoveRecord = z.object({
  /** The record NAME exactly as the inventory carries it — a host, a zone, or a mail record's
   *  own name (`<stage>._domainkey.<domain>`, `_dmarc.<domain>`). */
  name: z.string().min(1),
  type: z.enum(DNS_RECORD_TYPE),
});
type DnsRemoveRecord = z.infer<typeof DnsRemoveRecord>;

const recordKey = (r: DnsRemoveRecord): string => `${r.type} ${r.name}`;

export const DnsRemoveParams = z.union([
  z
    .object({ records: z.array(DnsRemoveRecord).min(1) })
    // A record listed twice would be two steps of one name, and the executor keys a run's steps by name.
    .refine((p) => new Set(p.records.map(recordKey)).size === p.records.length, { message: "a record is listed twice" }),
  // The shape before #172, ONE record, lifted into the list of one: the executor stores the PARSED
  // params, so a run planned before the upgrade re-parses on a retry and every stored run carries
  // the list shape.
  DnsRemoveRecord.transform((record) => ({ records: [record] })),
]);
export type DnsRemoveParams = z.output<typeof DnsRemoveParams>;

/** The step that takes ONE record of the list back, named for the record so the run's step list
 *  reads as the records it removes. A colon and a space are admitted in a step name (the executor's
 *  own cleanup steps are `cleanup:<name>`), and a DNS name carries neither. */
const removeStepName = (r: { name: string; type: DnsRecordType }): string => `remove-record:${r.type} ${r.name}`;

function dnsRemoveSteps(params: DnsRemoveParams, ports: DnsRecordPorts): Step[] {
  // Read defensively: the armed check evaluates def.steps({}) with no params at all.
  const records = params.records ?? [];
  return [
    {
      name: ATTEST_TARGET_STEP,
      title: `Attest the ${records.length === 1 ? "record is" : `${records.length} records are`} this installation's and may be taken back`,
      run: async (ctx) => {
        const dns = requireDnsProvider(ports);
        const rows = removableRecords(await withBookedRows(ctx.db, dns, await ownedRecords(ports), records, ctx.signal), records);
        ctx.checkpoint({ records: rows.map((row) => ({ record: row.name, type: row.type, owner: row.owner, found: row.found, verdict: row.verdict })) });
        for (const row of rows) {
          ctx.log("meta", `${row.type} ${row.name} belongs to ${ownerSentence(row)} and stands at ${row.found ?? "nothing — it is already absent"}`);
        }
      },
    },
    ...records.map((record): Step => ({
      name: removeStepName(record),
      title: `Take back the ${record.type} record ${record.name}: delete at the DNS provider only what the plan names`,
      // Resolved in the inventory AGAIN rather than deleted by the params: a TXT goes by the content
      // this platform owns, which the row and the book decide (dns-record.kit.ts), never the name.
      run: async (ctx) => {
        const dns = requireDnsProvider(ports);
        const rows = await withBookedRows(ctx.db, dns, await ownedRecords(ports), [record], ctx.signal);
        return deleteRecord(ctx, dns, removableRecord(rows, record.name, record.type));
      },
    })),
  ];
}

export function makeDnsRemoveDef(ports: DnsRecordPorts): RunDefinition<DnsRemoveParams> {
  return {
    kind: "dns-remove",
    paramsSchema: DnsRemoveParams,
    mutating: true,
    plan: async (params, deps) => {
      const dns = requireDnsProvider(ports);
      const rows = removableRecords(await withBookedRows(deps.db, dns, await ownedRecords(ports), params.records), params.records);
      // What each step deletes, decided by the rule the step carries out, against what stands now:
      // the plan is what the DNS page's confirm shows, so it names what goes, never only what stands.
      const removals = await Promise.all(rows.map(async (row) => {
        const standing = await dns.listRecordContents({ name: row.name, type: row.type });
        return { row, standing, removal: providerRemoval(deps.db, row, standing) };
      }));
      const deleting = removals.filter((r) => r.removal.content !== null).length;
      return {
        kind: "dns-remove",
        targetKind: "self",
        targetId: "manager",
        summary:
          `Take back ${rows.length === 1 ? "one record" : `${rows.length} records`}, one step each; ${deleting === 0 ? "nothing is deleted at the DNS provider" : `${deleting === 1 ? "one is" : `${deleting} are`} deleted at the DNS provider`}: ` +
          `${removals.map((r) => removalSentence(r.row, r.standing, r.removal)).join("; ")}. ` +
          "Nothing on any machine is touched, and what stood at each record is written into this run's log before it goes.",
        steps: dnsRemoveSteps(params, ports).map((s) => ({ name: s.name, title: s.title })),
        warnings: removals
          .filter((r) => r.removal.content !== null && r.row.verdict === "standing")
          .map((r) => `${r.row.name} answers with exactly what ${ownerSentence(r.row)} needs — removing it takes a name that is in use right now out of DNS.`),
        requiredSecrets: [],
      };
    },
    steps: (params) => dnsRemoveSteps(params, ports),
  };
}
