// The concrete Activation client: a plain fetch to the consumer's public
// ingress. An adapter, so IO lives here — the domain step drives it through the Activator port.
//
// The token rides ONLY as the declared header; it is never placed in the URL, the body, or any log.
// The response body is captured raw (bounded) so the onboard step can fail loud with the real status
// + message on a non-2xx (e.g. example-auth's 409 admin_exists / 404 disabled-endpoint).
import type { Activator, ActivationRequest, ActivationResponse } from "./port.ts";

/** Bound the captured body so a hostile/huge response can never blow the run log or memory. */
const BODY_CAP = 4096;

export class HttpActivator implements Activator {
  constructor(private readonly opts: { timeoutMs?: number } = {}) {}

  async invoke(input: ActivationRequest): Promise<ActivationResponse> {
    // Compose a timeout with the caller's cancel signal so a hung consumer ingress cannot stall the
    // run past its budget, while a run cancel still aborts the fetch promptly.
    const timeoutMs = this.opts.timeoutMs ?? 30_000;
    const timer = new AbortController();
    const t = setTimeout(() => timer.abort(new Error(`activation call timed out after ${timeoutMs}ms`)), timeoutMs);
    const onOuterAbort = (): void => timer.abort((input.signal as AbortSignal).reason);
    if (input.signal) {
      if (input.signal.aborted) timer.abort(input.signal.reason);
      else input.signal.addEventListener("abort", onOuterAbort, { once: true });
    }
    try {
      const res = await fetch(input.url, {
        method: input.method,
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          [input.tokenHeader]: input.token,
        },
        body: JSON.stringify(input.body),
        signal: timer.signal,
        redirect: "manual", // never follow a redirect off the declared host (the token is a header)
      });
      const raw = await res.text();
      const bodyText = raw.length > BODY_CAP ? `${raw.slice(0, BODY_CAP)}…[truncated]` : raw;
      let json: unknown = null;
      const ct = res.headers.get("content-type") ?? "";
      if (ct.includes("application/json")) {
        try {
          json = JSON.parse(raw);
        } catch {
          json = null; // a malformed JSON body still surfaces as bodyText in the failure path
        }
      }
      return { status: res.status, ok: res.ok, json, bodyText };
    } finally {
      clearTimeout(t);
      if (input.signal) input.signal.removeEventListener("abort", onOuterAbort);
    }
  }
}
