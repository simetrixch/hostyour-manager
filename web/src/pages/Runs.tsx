import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router";
import type { LockView, QueuedRunView, RunDurationView, RunView } from "../../../shared/api-types.ts";
import { RUN_STATUS } from "../../../shared/enums.ts";
import { listLocks, listQueue, listRunDurations, listRuns } from "../api.ts";
import { RunRows } from "../components/RunRows.tsx";
import { currentStepOf, formatElapsed, isOpenRun, locksHeldBy, queueLine, usualDurationOf } from "../runsBoard.ts";

const fmtWhen = (ts: number): string =>
  new Date(ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

interface Board {
  runs: RunView[];
  locks: LockView[];
  durations: RunDurationView[];
  queue: QueuedRunView[];
}

/** Every run of every kind: the open ones first, with where each stands and what it holds, then the
 *  finished ones, newest first. Reads only; every act on a run stays on its run page. */
export function Runs(): ReactNode {
  const [board, setBoard] = useState<Board | null>(null);
  const [error, setError] = useState<string | null>(null); // the last read failed; the last good board stays
  const [kind, setKind] = useState("");
  const [status, setStatus] = useState("");
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(() => {
    Promise.all([listRuns(), listLocks(), listRunDurations(), listQueue()])
      .then(([runs, locks, durations, queue]) => {
        setBoard({ runs, locks, durations, queue });
        setNow(Date.now());
        setError(null);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, 10_000);
    return () => clearInterval(timer);
  }, [load]);

  const failure = error !== null && (
    <p role="alert" className="alert alert--danger">
      {board ? `The last refresh failed, so this list may be out of date: ${error}` : error}
    </p>
  );
  if (!board && failure) return failure;
  if (!board)
    return (
      <div className="loading">
        <span className="spinner" aria-hidden="true" />
        Loading runs…
      </div>
    );

  const open = board.runs.filter((r) => isOpenRun(r, board.locks));
  const finished = board.runs.filter((r) => !isOpenRun(r, board.locks));
  const kinds = [...new Set(finished.map((r) => r.kind))].sort();
  const shown = finished.filter((r) => (kind === "" || r.kind === kind) && (status === "" || r.status === status));

  return (
    <section className="page">
      <header className="page__head">
        <div>
          <h2 className="page__title">Runs</h2>
          <p className="page__desc">Every open run of every kind, the queued ones with their place in line, then the newest finished ones.</p>
        </div>
        <button type="button" className="btn" onClick={load}>
          Refresh
        </button>
      </header>
      {failure}

      <header className="panel__head">
        <h3 className="panel__title">Open</h3>
        <span className="panel__count">{open.length}</span>
      </header>
      {open.length === 0 ? (
        <div className="empty">
          <p>No run is open, and no run holds a lock.</p>
        </div>
      ) : (
        <div className="table__wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Run</th>
                <th>Target</th>
                <th>Started by</th>
                <th>Started</th>
                <th>Elapsed</th>
                <th>Now</th>
                <th>Holds</th>
                <th>Ends</th>
              </tr>
            </thead>
            <tbody>
              {open.map((r) => {
                const since = r.startedAt;
                const held = locksHeldBy(r.id, board.locks);
                const q = r.status === "queued" ? board.queue.find((item) => item.runId === r.id) : undefined;
                const where = q ? `place ${q.place}: ${queueLine(q)}` : currentStepOf(r);
                return (
                  <tr key={r.id}>
                    <td>
                      <span className={`badge badge--${r.status}`}>{r.status}</span>{" "}
                      <Link to={`/runs/${r.id}`}>{r.kind}</Link>
                    </td>
                    <td className="mono">{r.targetKind} {r.targetId}</td>
                    <td>{r.owner}</td>
                    <td>{since === null ? `not started, planned ${fmtWhen(r.creation)}` : fmtWhen(since)}</td>
                    <td>{since === null ? "" : formatElapsed(now - since)}</td>
                    <td>{where}</td>
                    <td className="mono">{held.length > 0 ? held.join(", ") : "nothing"}</td>
                    <td>{r.status === "running" ? usualDurationOf(r.kind, board.durations) : ""}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <header className="panel__head">
        <h3 className="panel__title">Finished</h3>
        <span className="panel__count">{shown.length}</span>
      </header>
      <div className="form-grid">
        <label className="field">
          <span className="field__label">Kind</span>
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">Every kind</option>
            {kinds.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field__label">Status</span>
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Every status</option>
            {RUN_STATUS.filter((s) => s === "succeeded" || s === "failed" || s === "cancelled").map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
      </div>
      <RunRows runs={shown} empty={<div className="empty"><p>No finished run matches.</p></div>} />
    </section>
  );
}
