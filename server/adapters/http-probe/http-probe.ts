// The concrete public-reach probe: a plain GET against the unit's public address. An adapter, so IO
// lives here — the verify-quiesced step drives it through the PublicProbe port. The reachability
// verdict itself is pure (verdictOf) so the boundary cases are unit-testable without a server.
import type { PublicProbe, ProbeResult } from "./port.ts";

/** Map an observed status to the port's reachability contract: 404 = nothing routes the host (the
 *  quiesced state), 5xx = the edge is up but no backend serves — both are "closed". Everything else
 *  is a unit that answered, an auth challenge included. */
export function verdictOf(status: number): ProbeResult {
  const reachable = status < 500 && status !== 404;
  return { reachable, detail: `HTTP ${status}` };
}

export class HttpPublicProbe implements PublicProbe {
  constructor(private readonly opts: { timeoutMs?: number } = {}) {}

  async probe(url: string, opts: { signal?: AbortSignal }): Promise<ProbeResult> {
    const timeoutMs = this.opts.timeoutMs ?? 15_000;
    const timer = new AbortController();
    const t = setTimeout(() => timer.abort(new Error(`probe timed out after ${timeoutMs}ms`)), timeoutMs);
    const onOuterAbort = (): void => timer.abort((opts.signal as AbortSignal).reason);
    if (opts.signal) {
      if (opts.signal.aborted) timer.abort(opts.signal.reason);
      else opts.signal.addEventListener("abort", onOuterAbort, { once: true });
    }
    try {
      const res = await fetch(url, { method: "GET", signal: timer.signal, redirect: "manual" });
      // Drain the body so the socket is released; the verdict needs only the status.
      await res.arrayBuffer().catch(() => undefined);
      return verdictOf(res.status);
    } catch (e) {
      // A transport failure IS the unreachability the quiesced state produces — never a throw.
      return { reachable: false, detail: e instanceof Error ? e.message : String(e) };
    } finally {
      clearTimeout(t);
      if (opts.signal) opts.signal.removeEventListener("abort", onOuterAbort);
    }
  }
}
