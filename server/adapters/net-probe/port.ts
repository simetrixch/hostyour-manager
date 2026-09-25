// Whether ONE port of ONE host takes a TCP connection — the door every run of a machine opens first
// (its SSH port). Kept a port so the inventory's reading depends on the abstraction; the real one is
// net-probe.ts, the fake testing/fake.ts.

/** What a connect answered: taken, or why not, in words a person reads on a server's card. */
export type TcpReach = { reachable: true } | { reachable: false; reason: string };

export interface TcpProbe {
  /** One connect, closed again at once. A name that does not resolve, a refusal and silence within
   *  the bound are three answers, each named; none of them throws. */
  reach(input: { host: string; port: number; timeoutMs: number }): Promise<TcpReach>;
}
