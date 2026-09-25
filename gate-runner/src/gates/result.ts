// gate-runner/src/gates/result.ts
// Gate-result authoring. Every gate states, in full sentences, what was EXPECTED and what was
// FOUND, and — only on a non-pass — WHY that is a rejection, so a rejection never requires reading
// gate source. The helpers make the fail-closed refinement (shared/gates.ts: reason is null IFF
// status is "pass") STRUCTURAL: `pass` cannot carry a reason; `fail`/`warn` require one. `detail`
// defaults to `found` for the collapsed-row rendering PreflightCheck shares.
import type { GateEvidence, GateResult, GateSeverity } from "../../../shared/gates.ts";

interface GateFacts {
  id: string;
  title: string;
  severity: GateSeverity;
  expected: string; // the rule as one checkable sentence + its contract anchor
  found: string; // observed facts only, no judgment
  evidence?: GateEvidence[]; // concrete jump-to observations (runner-truncated), max 20
  hint?: string;
  detail?: string; // collapsed-row text; defaults to `found`
}

function make(f: GateFacts, status: GateResult["status"], reason: string | null): GateResult {
  return {
    id: f.id,
    title: f.title,
    severity: f.severity,
    status,
    expected: f.expected,
    found: f.found,
    reason,
    detail: f.detail ?? f.found,
    ...(f.evidence && f.evidence.length > 0 ? { evidence: f.evidence } : {}),
    ...(f.hint !== undefined ? { hint: f.hint } : {}),
  };
}

export const pass = (f: GateFacts): GateResult => make(f, "pass", null);
export const fail = (f: GateFacts & { reason: string }): GateResult => make(f, "fail", f.reason);
