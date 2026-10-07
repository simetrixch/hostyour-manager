// gate-runner/src/gates/secret-sync-ordering.gate.ts
// G30 "secret sync ordering" (HARD). A workload whose pod reads a Secret that a controller writes, the
// service-provisioner for a ServiceClaim or ESO for an ExternalSecret, stands in a LATER sync wave than
// the object that has it written, and no PreSync hook reads such a Secret. The reading, and why Argo CD
// needs it, is shared/secret-sync-order.ts, which the tenant gate T6 holds every member to as well.
//
// Pure and synchronous over the read-only GateContext.
import type { CheckGate, GateContext } from "./gate.ts";
import type { GateEvidence, GateResult } from "../../../shared/gates.ts";
import { SYNC_ORDER_EXPECTED, readSyncOrder, syncOrderBreachFound, syncOrderBreachReason } from "../../../shared/secret-sync-order.ts";
import { fail, pass } from "./result.ts";

const ID = "G30";
const TITLE = "secret sync ordering";
const SEVERITY = "hard" as const;

export const secretSyncOrderingGate: CheckGate = {
  id: ID,
  title: TITLE,
  severity: SEVERITY,
  check(ctx: GateContext): GateResult {
    const { writtenSecrets, uses, breach } = readSyncOrder(ctx.rendered);
    if (writtenSecrets === 0) {
      return pass({ id: ID, title: TITLE, severity: SEVERITY, expected: SYNC_ORDER_EXPECTED, found: "no ServiceClaim or ExternalSecret is rendered, so there is no written Secret to order a workload after." });
    }
    if (breach) {
      const { doc } = breach;
      const evidence: GateEvidence = { source: "rendered", docIndex: doc.docIndex, kind: doc.kind, name: doc.name, fieldPath: breach.fieldPath, value: breach.secret };
      return fail({ id: ID, title: TITLE, severity: SEVERITY, expected: SYNC_ORDER_EXPECTED, found: syncOrderBreachFound(breach), reason: syncOrderBreachReason(breach), evidence: [evidence] });
    }
    return pass({
      id: ID, title: TITLE, severity: SEVERITY, expected: SYNC_ORDER_EXPECTED,
      found: `${writtenSecrets} written Secret(s); ${uses} use(s) by workloads, each in a later wave than the object that writes it.`,
    });
  },
};
