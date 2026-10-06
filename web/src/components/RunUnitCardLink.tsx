import { useEffect, useState } from "react";
import { Link } from "react-router";
import type { RunUnitCardView } from "../../../shared/api-types.ts";
import { getRunUnitCard } from "../api-run-unit-card.ts";
import { unitCardHref } from "../runScreen.ts";

/** The way back from a run to the card of the unit it acted on, opened on the run's stage (unitCardHref).
 *  Nothing shows for a run that acts on no consumer or tenant stage; a failed lookup says so. */
export function RunUnitCardLink({ runId }: { runId: string }) {
  const [card, setCard] = useState<RunUnitCardView | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setCard(null);
    setError(null);
    getRunUnitCard(runId)
      .then((c) => { if (alive) setCard(c); })
      .catch((e: unknown) => { if (alive) setError(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, [runId]);
  if (error !== null) return <span className="runhead__back">The unit's card could not be found: {error}</span>;
  return card ? <Link className="runhead__back" to={unitCardHref(card)}>← {card.label} ({card.stage})</Link> : null;
}
