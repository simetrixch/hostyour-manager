import { AsyncLocalStorage } from "node:async_hooks";

// WHO is acting, carried across the async gap between the HTTP layer and the writers that audit.
//
// The audit table and runs.started_by record an `actor` (an operators.id), but the Executor and the
// CredentialStore are constructed once at boot, long before any request exists — they cannot take
// the operator as a constructor argument, and threading it through every method signature would put
// the HTTP layer's concern into every domain call. AsyncLocalStorage closes that gap: the
// chokepoint middleware runs each authenticated request inside runAsActor(operator id), and any
// write that happens in that request's async call chain — however deep — reads the id back with
// currentActor(). Outside a request (boot, resume, background jobs) there is no store and
// currentActor() returns undefined; each caller states its own fallback ("op_system" for a run row,
// "system" for a credential audit), so autonomous work stays attributed to the system, never to the
// last human who happened to click.
const store = new AsyncLocalStorage<string>();

/** Run `fn` (and every async continuation it starts) attributed to `actorId`. */
export function runAsActor<T>(actorId: string, fn: () => T): T {
  return store.run(actorId, fn);
}

/** The operator id of the request this call chain belongs to, or undefined outside any request. */
export function currentActor(): string | undefined {
  return store.getStore();
}

/** The seeded operators row autonomous work is attributed to — a boot resume, a background job, any
 *  write that belongs to no request. It exists in the schema baseline, so the FK on runs.started_by
 *  and on the audit rows resolves without a login having happened. */
export const SYSTEM_ACTOR = "op_system";

/** WHO a RUN or a server-route write is attributed to: the signed-in operator of the current
 *  request, and SYSTEM_ACTOR outside any request. The composition root wires the Executor and the
 *  server routes with exactly this function rather than an inline fallback of its own — an actor
 *  resolver written twice is a resolver that can differ, and the difference is silent: every audit
 *  row and every runs.started_by would name the system where a human acted, with nothing failing.
 *  (The CredentialStore keeps its own "system" fallback: a credential audit's autonomous actor is
 *  not an operators row, so the two are different values on purpose.) */
export function runActor(): string {
  return store.getStore() ?? SYSTEM_ACTOR;
}
