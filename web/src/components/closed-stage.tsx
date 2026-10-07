import type { ReactNode } from "react";

/** What a card says while its stage registration is quiesced: the unit serves nothing, and why. */
export const CLOSED_STAGE_LINE =
  "Closed: the stage registration is quiesced, so the unit runs no replicas and has no Ingress. A backup or a move closes it while it runs and opens it again when the run succeeds; a run that failed or was cancelled keeps it closed until it is aborted with cleanup, and a move aborted after its repoint keeps it closed on purpose. Open the unit's last run to see which.";

/** One row of the card's live block, only while the stage is closed. */
export function ClosedStageLine({ quiesced }: { quiesced: boolean | null }): ReactNode {
  if (quiesced !== true) return null;
  return (
    <div className="recon__row">
      <span className="recon__label">Access</span>
      <span className="recon__fact recon__fact--down">{CLOSED_STAGE_LINE}</span>
    </div>
  );
}
