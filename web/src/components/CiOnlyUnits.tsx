import { useEffect, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import type { CiOnlyUnitView } from "../../../shared/api-types-onboard.ts";
import { listCiOnlyUnits, offboardCiOnlyUnit } from "../api.ts";

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The units that only run CI. They have no apps row, so the consumer list cannot show them;
 *  Offboard plans the removal of their webhook, registration and token and opens the run. */
export function CiOnlyTable(props: { rows: CiOnlyUnitView[]; onOffboard: (name: string) => void }): ReactNode {
  if (props.rows.length === 0) return null;
  return (
    <>
      <h3 className="steps-panel__title">CI only</h3>
      <div className="table__wrap">
        <table className="table">
          <thead>
            <tr>
              <th>#</th>
              <th>Unit</th>
              <th>Repository</th>
              <th>Owner</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {props.rows.map((r, i) => (
              <tr key={r.name}>
                <td>{i + 1}</td>
                <td>{r.name}</td>
                <td>{r.repoUrl}</td>
                <td>{r.owner ?? "—"}</td>
                <td>
                  <button type="button" className="btn btn--danger" onClick={() => props.onOffboard(r.name)}>
                    Offboard
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

export function CiOnlyUnits(): ReactNode {
  const nav = useNavigate();
  const [rows, setRows] = useState<CiOnlyUnitView[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    listCiOnlyUnits()
      .then(setRows)
      .catch((e: unknown) => setError(msg(e)));
  }, []);
  const offboard = (name: string): void => {
    setError(null);
    offboardCiOnlyUnit(name)
      .then(({ runId }) => nav(`/runs/${runId}`))
      .catch((e: unknown) => setError(msg(e)));
  };
  return (
    <>
      {error && (
        <p role="alert" className="alert alert--danger">
          {error}
        </p>
      )}
      <CiOnlyTable rows={rows} onOffboard={offboard} />
    </>
  );
}
