import { z } from "zod";
import type { InstantAnswer, MetricsQuery } from "./port.ts";

// The concrete query-API client: one GET at `<base>/api/v1/query?query=<q>`, and the Prometheus
// answer read out of the body. An adapter, so the IO lives here — the verify step depends on the
// port.
//
// THE PATH AND THE PARSING ARE ONE CONTRACT AND THEY STAY IN ONE PLACE. The chart that carries the
// address states a BASE and nothing more (hostyour-cloud clusters/inventories/manager
// values-common.yaml metrics.queryUrl), deliberately: a chart that wrote the path would own half of
// an API whose other half it cannot read, and the two would drift the next time either moved.
//
// THE VERDICT IS PURE (`answerOf`) so every boundary case is testable without a server: a body that
// is not JSON, a JSON body that is not a Prometheus answer, and the API refusing the query in its
// own words are three different things an operator has to be able to tell apart, and none of them
// needs a socket to reproduce.

/** A Prometheus instant-query answer, cut down to what decides this question. `status` is the API's
 *  own verdict on the query; `data.result` is the vector, one entry per series. Everything else in
 *  the envelope — the result type, the labels, the sample values, the warnings — is ignored, because
 *  the caller asks HOW MANY series exist and never what they hold. */
const QueryAnswer = z.object({
  status: z.string(),
  data: z.object({ result: z.array(z.unknown()) }).optional(),
  error: z.string().optional(),
  errorType: z.string().optional(),
});

/** What a body means, with no socket involved. `success` with a vector is the only shape that
 *  answers the question; the API's own refusal is reported in ITS words, because "the query was
 *  wrong" and "nothing was listening" send an operator to two different places and only the API can
 *  tell them apart. */
export function answerOf(status: number, body: string): InstantAnswer {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { kind: "unanswered", detail: `HTTP ${status} carrying ${body.length} bytes that are not JSON` };
  }
  const answer = QueryAnswer.safeParse(parsed);
  if (!answer.success) return { kind: "unanswered", detail: `HTTP ${status} carrying JSON that is not a query answer` };
  if (answer.data.status !== "success" || answer.data.data === undefined) {
    const said = [answer.data.errorType, answer.data.error].filter((s) => s !== undefined).join(": ");
    return { kind: "unanswered", detail: `HTTP ${status}, the query API answered ${answer.data.status}${said === "" ? "" : ` — ${said}`}` };
  }
  return { kind: "answered", series: answer.data.data.result.length };
}

/** What one query is given, before the caller's own abort is counted. Generous enough for a
 *  Prometheus under a cold-bootstrap scrape load and short enough that a soft check cannot hold a
 *  run open: the check it serves reports a note either way. */
const QUERY_TIMEOUT_MS = 15_000;

export class HttpMetricsQuery implements MetricsQuery {
  /** `base` is the address of the query API and carries no path of its own — the path below is this
   *  module's half of the contract. A trailing slash is taken off so the two halves cannot compose a
   *  double one, which some gateways answer with a redirect and others with a 404. */
  constructor(private readonly base: string) {}

  async instant(query: string, opts: { signal?: AbortSignal }): Promise<InstantAnswer> {
    const url = `${this.base.replace(/\/+$/, "")}/api/v1/query?query=${encodeURIComponent(query)}`;
    const timer = new AbortController();
    const t = setTimeout(() => timer.abort(new Error(`the query API did not answer within ${QUERY_TIMEOUT_MS}ms`)), QUERY_TIMEOUT_MS);
    const onOuterAbort = (): void => timer.abort((opts.signal as AbortSignal).reason);
    if (opts.signal) {
      if (opts.signal.aborted) timer.abort(opts.signal.reason);
      else opts.signal.addEventListener("abort", onOuterAbort, { once: true });
    }
    try {
      const res = await fetch(url, { method: "GET", signal: timer.signal, redirect: "manual" });
      return answerOf(res.status, await res.text());
    } catch (e) {
      // A transport failure is an ANSWER here and never a throw: the caller is a soft check, and a
      // Service that was renamed out from under this address has to reach the run log as a note
      // rather than as an exception that fails a healthy management plane.
      return { kind: "unanswered", detail: e instanceof Error ? e.message : String(e) };
    } finally {
      clearTimeout(t);
      if (opts.signal) opts.signal.removeEventListener("abort", onOuterAbort);
    }
  }
}
