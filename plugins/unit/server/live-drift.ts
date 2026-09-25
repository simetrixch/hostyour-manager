// The deployment question of every unit's live card: does what the cluster RUNS match what the
// unit's Application TARGETS? One answer for every card, so no two cards can describe the same live
// situation differently.
import type { DriftVerdict, ArgoSync } from "#core/shared/enums.ts";
import type { LiveDriftView } from "#core/shared/api-types.ts";

/** The revision block of a live card: `pinned` is what the unit's chart source TARGETS as ArgoCD sees it
 *  — the delivery branch for a consumer, the books branch for a tenant, a SHA only where a pin says one
 *  — `deployed` is the commit ArgoCD synced from that source, and `verdict` is ArgoCD's own comparison
 *  of the two (deploymentVerdict). There is no second source and no fallback: the registration states
 *  no revision, and the revision the delivery branch stands on is the release cycle's to write. A unit
 *  whose Application cannot be read has nothing targeted, and that is what the card then says rather
 *  than promoting a Manager-side guess to a pin. `argoRead` says whether ArgoCD answered AT ALL. */
export function driftOf(input: { targeted: string | null; deployed: string | null; sync: ArgoSync | null; argoRead: boolean }): LiveDriftView {
  const { targeted, deployed, sync, argoRead } = input;
  return {
    pinned: targeted,
    deployed,
    verdict: deploymentVerdict({ pinned: targeted, deployed, sync, argoRead }),
  };
}

/** The ONE deployment question: does what the cluster RUNS match what the Application TARGETS?
 *  (DRIFT_VERDICT, shared/enums.ts.) The answer is ARGOCD'S OWN COMPARISON, `status.sync.status`, and
 *  never a string comparison of the two revisions: what a consumer Application targets is the delivery
 *  BRANCH `deploy/<stage>` (a literal, by design — the registration pins no revision, the release
 *  cycle moves the branch), and what it runs is a commit, so `deployed === pinned` was false on every
 *  converged consumer and painted every card "drift" (hostyour-manager#141). ArgoCD resolved the branch
 *  when it compared; Synced means the cluster carries that head, OutOfSync means it does not.
 *
 *  "unknown" comes first because an unread ArgoCD leaves both revisions unknown rather than absent, so
 *  it must not fall through to a claim about them; "not-deployed" is the neutral answer where there is
 *  no Application at all — nothing targeted, nothing running, nothing compared (a suspended consumer,
 *  or a resume that died before its Application existed) — and never "converged", which is a
 *  statement about a comparison that must have taken place. One side missing is drift: a source that
 *  targets nothing of the unit's own repository any more (a foreign source written over the pin) or a
 *  target nothing has been synced from yet. A sync status ArgoCD itself calls Unknown (the repository
 *  unreachable, the comparison not made) is reported as exactly that. */
function deploymentVerdict(input: { pinned: string | null; deployed: string | null; sync: ArgoSync | null; argoRead: boolean }): DriftVerdict {
  const { pinned, deployed, sync, argoRead } = input;
  if (!argoRead) return "unknown";
  if (pinned === null && deployed === null) return "not-deployed";
  if (pinned === null || deployed === null) return "drift";
  if (sync === "Synced") return "converged";
  if (sync === "OutOfSync") return "drift";
  return "unknown";
}
