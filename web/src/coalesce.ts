// One call for a burst of reasons, in a pure module beside runScreen.ts / tailnetState.ts and for the
// same reason those are: vitest runs with environment "node" and includes no .tsx, so anything left
// inside a page cannot be tested — and what is left inside a page is exactly what nobody measures.
//
// WHY A RUN SCREEN NEEDS THIS. The screen re-reads the run whenever a meta line arrives, because a
// meta line means the run's status has likely moved. That is right while a run is happening and
// wrong the moment the screen opens: the event stream REPLAYS from the first line, so a run that
// wrote 1734 meta lines asks for the run 1734 times in one burst. The server answers HTTP/1.1, a
// browser holds six connections to a host, and past its own queue limit it abandons requests with a
// network error — which the screen renders as "Failed to fetch" on a run whose every byte is
// perfectly readable. Measured on a slave deployment: 1734 meta lines against 39, 11 and 5 on the
// runs beside it, which is why only one run in the list could not be opened.
//
// TRAILING AND NOT LEADING. What the caller wants is the LATEST state, so the read worth making is
// the one after the burst; a leading call would read the state as it stood before 1733 more reasons
// to read it again arrived. The wait is therefore a coalescing window and not a rate limit: a lone
// event still causes exactly one read, one window later.

/** A function that runs at most once per `waitMs`, `waitMs` after the last reason to run it. */
export interface Coalesced {
  /** Ask for a run. The call itself never runs it. */
  call(): void;
  /** Drop a pending run — what a screen does when it is taken down. */
  cancel(): void;
}

export function coalesced(fn: () => void, waitMs: number): Coalesced {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    call() {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        fn();
      }, waitMs);
    },
    cancel() {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
}

/** The window a run screen coalesces its re-reads over. Long enough that a replayed log of any
 *  length becomes one read, short enough that a live run's status still moves under the operator's
 *  eyes — the events of one machine step arrive milliseconds apart, and a step lasts seconds. */
export const RUN_REFRESH_WINDOW_MS = 200;
