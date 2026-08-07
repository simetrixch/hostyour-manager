import type { DriftVerdict } from "../../shared/enums.ts";

// The WORDS the product is allowed to use for the two revisions a live reconciliation card compares —
// declared ONCE here and imported by every surface that prints one, the same way tenantRows.ts holds the
// tenants-page status rule and tenantPlacement.ts the create wizard's placement read-out. Pure, so it is
// stated and tested here rather than through a component (vitest.config.ts runs web/**/*.test.ts in the
// node environment; there is no DOM harness in this repo).
//
// WHY THE WORDS NEED A HOME OF THEIR OWN. The two revisions look alike — they are both short SHAs of the
// same repo — and telling them apart is the ONLY thing that makes the reconciliation surfaces truthful:
//
//   pinned    what the GitOps POINTER pins, read off the Application's own spec as ArgoCD sees it (server
//             targetedRevisionFor). This is what the platform will converge on.
//   deployed  what the cluster actually RUNS right now (server syncedRevisionFor / singleSourceRevision).
//
// Both are read off the APPLICATION and off nothing else. The Controller keeps no record of a unit's
// revision: the registration states none, and the delivery branch's own pin is the release cycle's to
// write. The words are therefore not copy — they are the claim each surface makes — and a claim that
// lives in two files drifts in two files.
//
// This module holds ONLY the vocabulary + the rendering of it. WHICH verdict a revision pair earns is the
// SERVER's answer, computed once in driftOf (server/domains/onboarding/api.ts) so the two cards can never
// disagree; the browser only names what it was handed — which is why the readout below takes the server's
// answer and returns a word plus a badge tone, and decides nothing itself.

/** What the GitOps POINTER pins, as ArgoCD sees it. Never a name for a DB column. */
export const PINNED = "pinned";

/** What the cluster actually RUNS. */
export const DEPLOYED = "deployed";

/** A revision rendered the ONE way every surface renders it: the first 7 characters, or the word "none"
 *  when there is no revision to show. "none" is deliberate and load-bearing — an empty span would read as
 *  a rendering glitch, while "none" states the fact (nothing pinned / nothing deployed), which is exactly
 *  what a suspended unit's pruned Application looks like. */
export function sha7(revision: string | null): string {
  return revision ? revision.slice(0, 7) : "none";
}

/** How ONE verdict is shown: the word the operator reads, and the badge tone it wears. `tone` is a
 *  ds/ui.css badge modifier — "healthy" (green ✓), "degraded" (amber !) and "bare", the NEUTRAL hollow
 *  dot every badge that makes no claim already uses. */
export interface ReconReadout {
  word: string;
  tone: "healthy" | "degraded" | "bare";
}

/** The DEPLOYMENT verdict — what runs vs what is pinned (server driftOf). Four answers, and only ONE of
 *  them is green, because green is a claim about a comparison that took place:
 *   - "converged"    ✓ the two revisions were compared and agree.
 *   - "drift"        ! they were compared and disagree (pinned-but-not-deployed included).
 *   - "not-deployed" · NEUTRAL. Nothing is pinned, nothing runs, so nothing was compared. This is what
 *     a finished consumer suspend/offboard and a settled tenant read — and equally what a lifecycle run
 *     that died half-way leaves behind (deploymentVerdict spells out the resume
 *     case). The word states the fact and stops there; the CARD HEAD's own status badge says whether
 *     that absence was asked for, which is the only place the product knows it from.
 *   - "unknown"      · NEUTRAL. ArgoCD could not be read at all.
 *  Both neutral answers share the "bare" tone and keep DIFFERENT words on purpose: they are two
 *  different reasons for having no verdict, and "unknown" said of a suspended unit would claim the
 *  product cannot see something it can see perfectly well. */
const DRIFT_READOUT: Record<DriftVerdict, ReconReadout> = {
  converged: { word: "in sync", tone: "healthy" },
  drift: { word: "drift", tone: "degraded" },
  "not-deployed": { word: "not deployed", tone: "bare" },
  unknown: { word: "unknown", tone: "bare" },
};

export function driftReadout(verdict: DriftVerdict): ReconReadout {
  return DRIFT_READOUT[verdict];
}
