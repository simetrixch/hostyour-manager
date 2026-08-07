import { Link } from "react-router";
import type { ReactNode } from "react";
import type { RunView } from "../../../shared/api-types.ts";
import { IconChevronRight } from "./icons.tsx";

const fmtWhen = (ts: number): string =>
  new Date(ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** The shared runs row list — lifted verbatim from the (now removed) global Runs page so every
 *  section that shows runs renders ONE identical row block instead of a hand-copied one. Dumb: it
 *  renders the runs it is given; the caller does the filtering and supplies the empty state. Each
 *  row links to RunDetail at /runs/:id (the only surviving runs route). */
export function RunRows({ runs, empty }: { runs: RunView[]; empty: ReactNode }): ReactNode {
  if (runs.length === 0) return empty;
  return (
    <ul className="rows">
      {runs.map((r) => (
        <li key={r.id}>
          <Link className="row" to={`/runs/${r.id}`}>
            <span className={`badge badge--${r.status}`}>{r.status}</span>
            <span className="row__title">{r.kind}</span>
            <span className="row__meta">{r.id}</span>
            <span className="row__end">
              <span className="row__time">{fmtWhen(r.createdAt)}</span>
              <span className="row__chevron" aria-hidden="true">
                <IconChevronRight />
              </span>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
