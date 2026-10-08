import { useEffect, useState } from "react";
import type { LineMoveView } from "../../../shared/api-types-line-move.ts";
import { getTenantLineMoves } from "../api.ts";
import { versionLabel } from "../versionChoice.ts";

/** The engine line a tenant runs, and the move to a newer one where its platform and its bundle have
 *  released one at the tenant's stage. Moving only PLANS tenant-line-move: an online backup first, then
 *  the bundle and the platform part in one commit. A refused offer says why and cannot be planned. */
export function TenantLineMoveOffer(props: { tenantId: string; busy: boolean; onMove: (line: string) => void }) {
  const [view, setView] = useState<LineMoveView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { tenantId } = props;
  useEffect(() => {
    let alive = true;
    getTenantLineMoves(tenantId)
      .then((v) => { if (alive) setView(v); })
      .catch((e: unknown) => { if (alive) setError(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, [tenantId]);

  if (error) return <p role="alert" className="alert alert--danger">{error}</p>;
  if (view === null) return <p className="muted">Reading the engine line…</p>;
  if (view.line === null) return null;
  const offer = view.offer;
  return (
    <div>
      <p>Engine line: <strong>{view.line}</strong>{offer ? "" : ", the newest released at this stage."}</p>
      {offer && (
        <>
          <p>
            Line <strong>{offer.line}</strong> is released.{" "}
            {offer.toBundle && offer.part && offer.partTag
              ? <>The move writes the bundle {versionLabel(offer.fromBundle)} → {versionLabel(offer.toBundle)} and {offer.part} ({offer.builds.join(", ")}) → {versionLabel(offer.partTag)} in one commit, after an online backup. Once a member runs line {offer.line}, the way back is the Restore of that backup.</>
              : null}
          </p>
          {offer.refusals.length > 0 && (
            <ul role="alert" className="alert alert--danger">
              {offer.refusals.map((r) => <li key={r}>{r}</li>)}
            </ul>
          )}
          <p>
            <button type="button" className="btn" disabled={props.busy || offer.refusals.length > 0} onClick={() => props.onMove(offer.line)}>
              Move to line {offer.line}
            </button>
          </p>
        </>
      )}
    </div>
  );
}
