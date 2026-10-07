// T6 — the secret sync order of every member, the rule the consumer gate G30 holds a consumer's chart to:
// a workload whose pod reads a Secret that a member's ServiceClaim or ExternalSecret has written stands in
// a later sync wave than that object, and no PreSync hook reads such a Secret. Each member is its own
// Argo CD Application, so each is read on its own; the reading is shared/secret-sync-order.ts.
import type { GateEvidence, GateResult } from "../../../../shared/gates.ts";
import { SYNC_ORDER_EXPECTED, readSyncOrder, syncOrderBreachFound, syncOrderBreachReason } from "../../../../shared/secret-sync-order.ts";
import { capGateText } from "#unit/server/unit-host-gate.ts";
import type { MemberDocs } from "./tenant-gates.ts";

const T6 = { id: "T6", title: "secret sync ordering", severity: "hard", expected: SYNC_ORDER_EXPECTED } as const;

export function gateT6SecretOrder(docsByMember: readonly MemberDocs[]): GateResult {
  let writtenSecrets = 0;
  let uses = 0;
  for (const m of docsByMember) {
    const reading = readSyncOrder(m.docs.map((doc, docIndex) => ({ ...doc, docIndex })));
    writtenSecrets += reading.writtenSecrets;
    uses += reading.uses;
    const { breach } = reading;
    if (!breach) continue;
    const evidence: GateEvidence[] = [{ source: "rendered", kind: breach.doc.kind, name: breach.doc.name, fieldPath: breach.fieldPath, value: breach.secret }];
    return {
      ...T6, status: "fail",
      found: capGateText(`member "${m.member}": ${syncOrderBreachFound(breach)}`),
      reason: capGateText(`member "${m.member}": ${syncOrderBreachReason(breach)}`),
      detail: "a workload reads a Secret before it is written", evidence,
    };
  }
  const found = writtenSecrets === 0
    ? "no member renders a ServiceClaim or an ExternalSecret, so there is no written Secret to order a workload after."
    : `${writtenSecrets} written Secret(s) across ${docsByMember.length} member(s); ${uses} use(s) by workloads, each in a later wave than the object that writes it.`;
  return { ...T6, status: "pass", found, reason: null, detail: "every written Secret is ready before a pod reads it" };
}
