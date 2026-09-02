import type { OperatorSession } from "./session.ts";

// The tri-state gate. The three outcomes are DISTINCT — collapsing unauthenticated + forbidden
// into one redirect branch is *how* a redirect
// loop comes to exist. Here a valid-but-forbidden session can never be answered with a redirect
// to login; the http middleware maps each outcome (G2), and the invariant is testable.
export type GateResult =
  | { kind: "ok"; operator: OperatorSession }
  | { kind: "unauthenticated" }
  | { kind: "forbidden"; identity: { username: string; email?: string } };

export function requireOperator(session: OperatorSession | undefined, adminsGroup: string): GateResult {
  if (!session) return { kind: "unauthenticated" };
  if (!session.groups.includes(adminsGroup)) {
    return { kind: "forbidden", identity: { username: session.sub, ...(session.email ? { email: session.email } : {}) } };
  }
  return { kind: "ok", operator: session };
}
