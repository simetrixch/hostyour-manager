import type { MiddlewareHandler } from "hono";
import type { Logger } from "../../kernel/logger.ts";
import { now } from "../../kernel/clock.ts";
import { toApiError } from "./error-shape.ts";

// ONE LINE PER REQUEST, WRITTEN WHEN THE REQUEST IS OVER.
//
// WHAT ITS ABSENCE COST. A run screen answered `Failed to fetch` and stayed unopenable, and the
// manager's whole log for that pod was six boot lines. Silence there means "no request arrived" and
// "every request was answered" equally, so the server side had to be reconstructed from the outside
// one probe at a time — reachability, the certificate, every endpoint unauthenticated, the pod's
// restart count, the sizes of the run's own rows, and finally a break-glass session minted over
// admin.sock to reproduce the authenticated request. The cause was in the browser (a replayed event
// stream asking for one run 1734 times), and nothing on the server could say so or rule it out. The
// burst is one `grep` in this line; so is its absence.
//
// WHAT IT MAY CARRY, and this is a rule and not a preference. The method, the path, the status, how
// long it took, and the run or server the path names. NEVER a body, never a query string and never a
// header: this manager is held to keeping credentials out of its log (security/redact.ts, the
// blocking `redact.canary` boot check), and an operator's secret rides a request body while a
// resume cursor and a token ride a query. `c.req.path` is the path alone — Hono keeps the query out
// of it — so what is written here cannot carry one.
//
// THE LINE IS WRITTEN AT THE END. A line at the start would say a request arrived and never what
// became of it, and the duration is the fact an operator reads first: a burst of fast 200s and a
// handful of slow ones are different faults. A long-lived stream therefore says nothing until it
// closes, which is what it means for it to be still open.

/** The two probes, at `debug` and not `info`. Kubernetes dials both on a schedule of its own, so at
 *  `info` they would be most of this log and the request that matters would sit between two probe
 *  lines. They stay in the log rather than being dropped, because "the probes stopped" is itself an
 *  answer and one level is all it takes to see them. */
const PROBE_PATHS: ReadonlySet<string> = new Set(["/healthz", "/readyz"]);

/** The id prefixes a path can carry, and the field each is written under (kernel/ids.ts mints them).
 *  Only these two: a run and a server are what an operator follows a request by, and matching on a
 *  known prefix is what keeps every other path segment out of the log. */
const SUBJECT_FIELD: Readonly<Record<string, string>> = { run: "run", srv: "server" };

/** The run or server a path names, as its own field, so a burst can be counted per subject rather
 *  than by reading ids out of paths. Answers nothing where the path carries neither. */
export function requestSubject(path: string): Record<string, string> {
  for (const segment of path.split("/")) {
    const underscore = segment.indexOf("_");
    if (underscore <= 0) continue;
    const field = SUBJECT_FIELD[segment.slice(0, underscore)];
    if (field !== undefined) return { [field]: segment };
  }
  return {};
}

/** Is this response one whose body outlives the handler? A run's event stream is answered the
 *  moment it opens and then writes for as long as the run lasts, so the handler returning is not
 *  the end of the request — and a duration measured there would report the time to open as the time
 *  the stream took. */
function isStreamed(contentType: string | undefined): boolean {
  return contentType !== undefined && contentType.startsWith("text/event-stream");
}

export function requestLog(logger: Logger): MiddlewareHandler {
  return async (c, next) => {
    const started = now();
    const method = c.req.method;
    const path = c.req.path;
    let written = false;
    const write = (status: number): void => {
      if (written) return;
      written = true;
      const line = { method, path, status, ms: now() - started, ...requestSubject(path) };
      if (PROBE_PATHS.has(path)) logger.debug(line, "request");
      else logger.info(line, "request");
    };

    try {
      await next();
    } catch (err) {
      // The chain threw: app.ts's onError turns this into the response the caller gets, and the
      // status it will answer with comes from the ONE module that decides it. Written here because
      // a middleware sees the rejection before onError has made a response out of it, and a request
      // that failed is the one an operator most needs the line for.
      write(toApiError(err).status);
      throw err;
    }

    const res = c.res;
    if (!isStreamed(res.headers.get("content-type") ?? undefined) || res.body === null) {
      write(res.status);
      return;
    }
    // The stream's own end, whichever way it comes: `flush` when the writer closes it, `cancel` when
    // the client goes away mid-stream. Both are the request ending, and one line is written either
    // way. The body is passed through untouched — nothing here reads, buffers or delays a byte of it.
    //
    // `cancel` is typed BESIDE Transformer and not in it: the DOM library this repository compiles
    // against declares only `start`, `transform` and `flush`, while the runtime under it (node 24,
    // engines in package.json) calls `cancel` on a transformer whose readable side is dropped. Without
    // it a stream the caller walked away from would end with no line at all.
    const status = res.status;
    const endOfBody: Transformer<Uint8Array, Uint8Array> & { cancel: () => void } = {
      flush: () => write(status),
      cancel: () => write(status),
    };
    c.res = new Response(
      res.body.pipeThrough(new TransformStream(endOfBody)),
      { status: res.status, statusText: res.statusText, headers: res.headers },
    );
  };
}
