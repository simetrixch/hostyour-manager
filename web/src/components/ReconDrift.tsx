import type { LiveDriftView } from "../../../shared/api-types.ts";
import { PINNED, DEPLOYED, sha7, driftReadout } from "../reconVocabulary.ts";

/** The revision half of a live reconciliation card, rendered ONCE for BOTH the Consumers page and the
 *  Tenants page. It exists as one component for the same reason the server builds the block in one
 *  function (driftOf, server/domains/units/api.ts): the two cards answer the same question about
 *  two unit kinds, and written twice they give different answers to the same situation —
 *  one card stops comparing the Manager's record at all while the other goes
 *  on pinning against it and cries "Drift" at converged consumers.
 *
 *  ONE row — the deployment question, and the only one worth a badge: what the Application TARGETS vs
 *  what the cluster RUNS. There is no second "Record" row (the Manager's own recorded revision
 *  vs that target): that column goes stale the moment a unit takes a single GitOps release after
 *  onboarding, so it would be lit on almost every card and warn of nothing. The consumer record
 *  still feeds the server's fallback for a Missing Application (driftOf);
 *  it is simply not a row of its own here.
 *
 *  This component states NO rule of its own — not the verdict, not the words, not the tones. It hands the
 *  server's answer to reconVocabulary.ts and prints what comes back. The neutral badges matter as much as
 *  the loud ones: BOTH "unknown" (ArgoCD unreadable) and "not deployed" (nothing pinned, nothing running,
 *  nothing compared) wear the bare tone rather than a green or a red one, because a facts panel that
 *  paints "we made no comparison" as either "it is fine" or "it is wrong" is lying in one direction or the
 *  other.
 *
 *  WHAT A SUSPENDED UNIT READS IS DELIBERATELY NOT THE SAME ON THE TWO CARDS, and that asymmetry is a
 *  fact about the two suspends, not an inconsistency waiting to be smoothed out here:
 *   - a suspended CONSUMER reads "not deployed · pinned none · deployed none". Its suspend git-mv's the
 *     pointer to suspended/, so the appset stops generating the Application at all — there is nothing
 *     left to pin and nothing left to run.
 *   - a suspended TENANT reads "in sync · pinned <sha> · deployed <sha>". Its suspend is a FIELD FLIP on
 *     the one tenant.yaml and the BASE Application survives BY DESIGN (which is why the suspend run's own
 *     prune-watch excludes it, tenant-lifecycle.run.ts), so a suspended tenant still has a pin, still has
 *     a deployed revision, and is still genuinely comparable — and a suspended tenant whose base is GONE
 *     is a real defect this card must go on reporting as drift.
 *  Both readings come from the server: it reads each unit's pin off that unit's own Application, so the
 *  asymmetry needs no rule of its own — it is what the two Applications actually do. */
export function ReconDrift({ drift }: { drift: LiveDriftView }) {
  const deployment = driftReadout(drift.verdict);
  return (
    <div className="recon__row">
      <span className="recon__label">Drift</span>
      <span className={`badge badge--${deployment.tone}`}>{deployment.word}</span>
      <span className="recon__sha">
        {PINNED} <span className="mono">{sha7(drift.pinned)}</span> · {DEPLOYED} <span className="mono">{sha7(drift.deployed)}</span>
      </span>
    </div>
  );
}
