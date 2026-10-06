// Following a run's log over its event stream, in a pure module for the reason coalesce.ts gives: vitest
// includes no .tsx, so what stays inside RunDetail.tsx is what nobody measures.
//
// A DROPPED STREAM IS NOT AN ENDED ONE. A hop between the browser and the Manager may close a stream
// the run left silent (the sandbox gates write nothing for half a minute), and the browser reports that
// close exactly as it reports the server's own. So the server says when a stream is over, with an `end`
// event (server/domains/runs/api.ts), and every other close reopens the stream from the last line held.
import type { RunEventView } from "../../shared/api-types.ts";
import { EPHEMERAL_STREAM, EVENT_STREAM } from "../../shared/enums.ts";

/** The part of an EventSource this module uses, so a test can play the server. */
export interface RunLogSource {
  addEventListener(type: string, listener: (e: MessageEvent) => void): void;
  close(): void;
}

const LINE_STREAMS = [...EVENT_STREAM, EPHEMERAL_STREAM];

/** How long a dropped stream waits before it reopens: no reconnect storm while the Manager restarts. */
export const RUN_LOG_RETRY_MS = 2_000;

/** Follow a run's log until the server ends it: `open(after)` opens the stream past the line `after`;
 *  each line reaches `line` once, in order; `ended` fires when the server says nothing more comes.
 *  Returns the stop that closes it. */
export function followRunLog(
  open: (after: number) => RunLogSource,
  on: { line: (e: RunEventView) => void; ended: () => void },
  schedule: (fn: () => void, ms: number) => void = (fn, ms) => void setTimeout(fn, ms),
): () => void {
  let after = -1;
  let stopped = false;
  let source: RunLogSource;
  const connect = (): void => {
    if (stopped) return;
    source = open(after);
    const onLine = (m: MessageEvent): void => {
      const e = JSON.parse(m.data as string) as RunEventView;
      if (e.seq <= after) return;
      after = e.seq;
      on.line(e);
    };
    for (const s of LINE_STREAMS) source.addEventListener(s, onLine);
    source.addEventListener("end", () => {
      stopped = true;
      source.close();
      on.ended();
    });
    source.addEventListener("error", () => {
      source.close();
      if (!stopped) schedule(connect, RUN_LOG_RETRY_MS);
    });
  };
  connect();
  return () => {
    stopped = true;
    source.close();
  };
}
