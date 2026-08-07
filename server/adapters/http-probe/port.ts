// The public-reach probe port (access is closed for the duration — "enforced, not
// announced"). verify-quiesced measures a quiesced unit from the OUTSIDE, over its public address,
// and demands unreachability: a chart that ignored the quiesced field would keep serving, and only a
// probe on the public host can see that. Kept a port so the run steps depend on the abstraction; the
// fetch impl is http-probe.ts, the fake is testing/fake.ts.

/** ONE look at a public URL. `reachable` means the unit ANSWERED: any response below 500 except a
 *  404 — a quiesced unit has no Ingress, so the edge answers 404 (nothing routes the host) and a
 *  dead backend answers 502/503, while ANY page the unit serves (200, a redirect, an auth 401)
 *  proves access is still open. A transport failure (refused, DNS, timeout) is unreachable too.
 *  `detail` carries the observed status or error for the run log. */
export interface ProbeResult {
  reachable: boolean;
  detail: string;
}

export interface PublicProbe {
  probe(url: string, opts: { signal?: AbortSignal }): Promise<ProbeResult>;
}
