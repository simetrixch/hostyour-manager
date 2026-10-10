import { AsyncLocalStorage } from "node:async_hooks";

// WHO is acting, carried across the async gap between the HTTP layer and the writers that audit.
//
// Every row records who wrote it (`owner`, `modified_by`, `deleted_by`; db/schema/stamps.ts), but
// the writers are constructed once at boot, long before any request exists, and threading the
// operator through every method signature would put the HTTP layer's concern into every domain
// call. AsyncLocalStorage closes that gap: the chokepoint middleware runs each authenticated request
// inside runAsActor(operator id), the Executor runs a run inside runAsActor(its owner), and any write
// in that async call chain, however deep, reads the id back with runActor(). Outside both, autonomous
// work is attributed to the system, never to the last human who happened to click.
const store = new AsyncLocalStorage<string>();

/** Run `fn` (and every async continuation it starts) attributed to `actorId`. */
export function runAsActor<T>(actorId: string, fn: () => T): T {
  return store.run(actorId, fn);
}

/** The seeded operators row autonomous work is attributed to — a boot resume, a background job, any
 *  write that belongs to no request. It exists in the schema baseline, so the FK on runs.owner
 *  resolves without a login having happened. */
export const SYSTEM_ACTOR = "op_system";

/** WHO a write is attributed to: the actor bound by runAsActor, and SYSTEM_ACTOR outside any.
 *  The stamp columns are the only caller that matters; a second resolver could differ, and the
 *  difference is silent: rows would name the system where a human acted, with nothing failing. */
export function runActor(): string {
  return store.getStore() ?? SYSTEM_ACTOR;
}
