import { useEffect, useState, type ReactNode } from "react";
import type { RunView } from "../../../shared/api-types.ts";
import type { RunKind } from "../../../shared/enums.ts";
import { listRuns } from "../api.ts";
import { RunRows } from "./RunRows.tsx";

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** A section's runs tab: the ONE shared runs data path (listRuns → GET /api/runs, flat) filtered
 *  CLIENT-SIDE to the section's run kinds — the same house pattern Servers already uses. There is
 *  no second server route and no second implementation; every run still opens RunDetail at
 *  /runs/:id through the shared RunRows. Filter by KIND (see runKinds.ts), never by targetId. */
export function SectionRuns({ kinds, empty }: { kinds: ReadonlySet<RunKind>; empty: string }): ReactNode {
  const [runs, setRuns] = useState<RunView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    listRuns()
      .then((r) => {
        if (alive) setRuns(r);
      })
      .catch((e: unknown) => {
        if (alive) setError(msg(e));
      });
    return () => {
      alive = false;
    };
  }, []);

  if (error)
    return (
      <p role="alert" className="alert alert--danger">
        {error}
      </p>
    );
  if (!runs)
    return (
      <div className="loading">
        <span className="spinner" aria-hidden="true" />
        Loading runs…
      </div>
    );

  const shown = runs.filter((r) => kinds.has(r.kind));
  return <RunRows runs={shown} empty={<div className="empty"><p>{empty}</p></div>} />;
}
