import { z } from "zod";
import type { RunDefinition, Step } from "../../../executor/types.ts";
import { ATTEST_TARGET_STEP } from "../../../executor/guards.ts";
import { DNS_RECORD_TYPE, type DnsRecordType } from "../../../../shared/dns.ts";
import { deleteRecord, ownedRecords, ownerSentence, removableRecord, removableRecords, requireDnsProvider, type DnsRecordPorts, type RemovableRecordRow } from "./dns-record.kit.ts";

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
  /** The record NAME exactly as the inventory carries it — a host, a wildcard, or a mail record's
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
        const rows = removableRecords(await ownedRecords(ports), records);
        ctx.checkpoint({ records: rows.map((row) => ({ record: row.name, type: row.type, owner: row.owner, found: row.found, verdict: row.verdict })) });
        for (const row of rows) {
          ctx.log("meta", `${row.type} ${row.name} belongs to ${ownerSentence(row)} and stands at ${row.found ?? "nothing — it is already absent"}`);
        }
      },
    },
    ...records.map((record): Step => ({
      name: removeStepName(record),
      title: `Remove the ${record.type} record ${record.name} at the DNS provider`,
      // Resolved in the inventory AGAIN rather than deleted by the params: a TXT goes by the content
      // this platform owns, which the row and the book decide (dns-record.kit.ts), never the name.
      run: async (ctx) => deleteRecord(ctx, requireDnsProvider(ports), removableRecord(await ownedRecords(ports), record.name, record.type)),
    })),
  ];
}

/** ONE record's line of the plan summary: whose it is, what stands, what the owner expects. */
function recordSentence(row: RemovableRecordRow): string {
  return (
    `the ${row.type} record ${row.name} — the record of ${ownerSentence(row)}, standing at ` +
    `${row.found ?? "nothing (it is already absent, and the removal is then a no-op)"}, where that owner's state says ${row.expected}`
  );
}

export function makeDnsRemoveDef(ports: DnsRecordPorts): RunDefinition<DnsRemoveParams> {
  return {
    kind: "dns-remove",
    paramsSchema: DnsRemoveParams,
    mutating: true,
    plan: async (params) => {
      const rows = removableRecords(await ownedRecords(ports), params.records);
      requireDnsProvider(ports);
      return {
        kind: "dns-remove",
        targetKind: "self",
        targetId: "manager",
        summary:
          `Remove ${rows.length === 1 ? "one record" : `${rows.length} records`} at the DNS provider, one step each: ${rows.map(recordSentence).join("; ")}. ` +
          "Nothing on any machine is touched: the records are in the zone, and what stood at each is written into this run's log before it goes.",
        steps: dnsRemoveSteps(params, ports).map((s) => ({ name: s.name, title: s.title })),
        warnings: rows
          .filter((row) => row.verdict === "standing")
          .map((row) => `${row.name} answers with exactly what ${ownerSentence(row)} needs — removing it takes a name that is in use right now out of DNS.`),
        requiredSecrets: [],
      };
    },
    steps: (params) => dnsRemoveSteps(params, ports),
  };
}
