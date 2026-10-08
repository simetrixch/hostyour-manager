import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router";
import type { RunDurationView, RunView } from "../../../shared/api-types.ts";
import { getRun, listRunDurations } from "../api.ts";
import { usualDurationOf, type BusyHolder } from "../runsBoard.ts";

/** What a refused approve collided with: the lock, the run holding it, and when such a run usually
 *  ends. The plan stays `planned`; the person approves again once the holder has ended. */
export function ResourceBusyCallout({ busy }: { busy: BusyHolder }): ReactNode {
  const [holder, setHolder] = useState<RunView | null>(null);
  const [durations, setDurations] = useState<RunDurationView[]>([]);

  useEffect(() => {
    let alive = true;
    // The holder's details only enrich the message; the lock and the holder's id already stand without them.
    getRun(busy.holderRunId).then((r) => alive && setHolder(r), () => undefined);
    listRunDurations().then((d) => alive && setDurations(d), () => undefined);
    return () => {
      alive = false;
    };
  }, [busy.holderRunId]);

  return (
    <div role="alert" className="alert alert--warn">
      <strong>Not started: {busy.resource} {busy.key} is held by another run.</strong>{" "}
      The holder is <Link to={`/runs/${busy.holderRunId}`}>{holder ? `${holder.kind} (${holder.status})` : busy.holderRunId}</Link>
      {holder?.status === "running" && <>, which ends {usualDurationOf(holder.kind, durations)}</>}
      {holder?.status === "failed" && <>, which failed and keeps its locks until it is retried, aborted or deleted</>}
      . This run stays planned; approve it again once the holder has ended.
    </div>
  );
}
