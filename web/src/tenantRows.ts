import type { TenantStatus } from "../../shared/enums.ts";

// What the product OFFERS on one tenants row, and which of the Tenants page's lists that row goes into —
// kept OUT of the components the same way runScreen.ts holds the Run screen's honesty rules and
// runKinds.ts holds the section run families. The Tenants list and the tenant detail page both decide
// it, so stating it once is what stops one screen from dropping a tenant the other still has a run kind for.
//
// THE THREE QUESTIONS, one per flag, each asked by a different screen:
//
// `settled` — is this row TERMINAL, i.e. is nothing of this tenant deployed? True for the two ends of the
//   tenant lifecycle, "offboarded" and "purged" (TENANT_SETTLED_STATUS, shared/enums.ts). The tenant
//   detail page asks it to swap the live action surface (add-app, remove-app, suspend, resume, offboard)
//   for the terminal bar that states what happened.
//
// `listed` — does the Tenants page show this row AT ALL? False for exactly one status, "purged"
//   (owner decision): a fully purged tenant DISAPPEARS from the Tenants list. Its
//   row is kept as the trace and its detail page still tells the whole truth by URL, but the page
//   lists tenants that still run and tenants that still have cluster state worth reaping, and a
//   deprovisioned tenant is neither. Before the purge recorded a state of its own it settled to
//   "offboarded" like every other removal, so it stayed on the "Offboarded tenants" panel and went on
//   offering the purge it had just completed — the most destructive run kind in the product appearing to do
//   nothing at all.
//
// `purgeable` — may a tenant-purge be OFFERED on it? This is the CLIENT side of the server's live-tenant
//   rule (server tenant-live-guard.ts, assertTenantNotLive), and it is deliberately NARROWER than that
//   rule at both ends:
//   - "offboarded" IS purgeable, and that is the whole point: tenant-offboard
//     un-deploys a tenant and deliberately KEEPS its cluster state — its member namespaces, its Tenant CR,
//     its Vault path, its object-storage credential and its Mongo databases all outlive that row
//     — so purge is the ONLY run kind that reaps them, and the purge route accepts exactly this row state.
//     It is also the state a pointer-driven discovery path can never find: EVERY removal git-rm's the
//     registration as its FIRST step and settles the row as its LAST, so the Tenants-page orphan scan
//     (which reads pointers) cannot return such a tenant however much of it still stands. A settled row
//     with no surface is therefore a tenant nothing in the product can finish removing — the dead end
//     this rule exists to keep shut.
//   - "provisioning" is purgeable: the create-tenant run that never finished, which is precisely the
//     state both removal run kinds are the remedy for.
//   - "active"/"suspended" are offered NO purge, narrower than the route's rule in one direction:
//     assertTenantNotLive refuses a live row only while its GitOps pointer still stands, and a browser
//     cannot read that pointer — so the UI offers the purge only where the route can never refuse it.
//     Offboard is the run kind offered there, and a purge may follow it: offboard first, then purge whatever
//     the offboard leaves behind, which is the one order the routes support (the refusal the purge route
//     answers a live tenant with says exactly that sentence, tenant-purge.run.ts purgeLiveRefusal).
//   - "purged" is offered NO purge, narrower than the route's rule in the OTHER direction and on purpose
//: the route still ACCEPTS a re-purge — every step of that run reaps only what
//     is still there, so it is idempotent and harmless, and it is the migration path for tenants purged
//     before this state existed — but a row with nothing left must not ADVERTISE the action. Offering the
//     product's most destructive run kind on a tenant that has already been deprovisioned is noise that can
//     only ever run to completion having deleted nothing.
// An ORPHAN has no row and therefore no status at all: the orphan scan and the failed-create-tenant
// callout get their answer from the server instead (RunTenantStateView, shared/api-types.ts, resolved by
// tenant-orphans.ts resolveRunTenantState), never from here.
//
// Held as a Record over TenantStatus rather than as `status !== "offboarded"` tests: a status added to
// TENANT_STATUS (shared/enums.ts) then breaks THIS build instead of falling silently on the permissive
// side of any of the three flags — the same protection runKinds.ts gets from typing its families against
// RunKind. That is not a hypothetical: "purged" is the status that was added, and every `!== "offboarded"`
// test in the product would have read it as a tenant that still stands.

/** What ONE tenants row is offered, from its status alone. */
export interface TenantRowOffer {
  /** TERMINAL — the row is at one of the two ends of the lifecycle ("offboarded" or "purged") and is
   *  kept for history. Nothing of it is deployed, so it leaves the Reconciliation card list and
   *  every run kind that edits a live tenant (add-app, remove-app, suspend, resume, offboard) is gone from it.
   *  It does not follow that it leaves the product: see `listed` and `purgeable`. */
  settled: boolean;
  /** Whether the Tenants page shows this row at all — false only for a purged tenant, which is off that
   *  page entirely while staying reachable at its own URL. */
  listed: boolean;
  /** Whether a tenant-purge may be offered on it — the gate EVERY purge trigger in the tenant screens
   *  asks, so no screen can offer a purge another screen withholds. */
  purgeable: boolean;
}

const TENANT_ROW_OFFER: Record<TenantStatus, TenantRowOffer> = {
  provisioning: { settled: false, listed: true, purgeable: true },
  active: { settled: false, listed: true, purgeable: false },
  suspended: { settled: false, listed: true, purgeable: false },
  offboarded: { settled: true, listed: true, purgeable: true },
  purged: { settled: true, listed: false, purgeable: false },
};

export function tenantRowOffer(status: TenantStatus): TenantRowOffer {
  return TENANT_ROW_OFFER[status];
}

/** The Tenants page's three lists. `onboarded` is every tenant the controller still carries — active,
 *  suspended, and the unfinished "provisioning" rows create-tenant records before it deploys — and it is
 *  what the Reconciliation cards render. `settled` is the offboarded rows, which get their own compact
 *  list so they stay reachable for the one run kind they still have without crowding the tenants that run.
 *  `unlisted` is the purged rows, which the page renders NOWHERE: they are named
 *  here rather than dropped inside the split so the routing stays a total function — see below. */
export interface TenantRowLists<T> {
  onboarded: T[];
  settled: T[];
  unlisted: T[];
}

/** Split the tenant inventory into those three lists. A PARTITION, never a filter: every row lands in
 *  exactly one of them. That invariant is worth keeping even though the page renders only two, because it
 *  is what makes "the Tenants page does not show purged tenants" a decision this function STATES (the row
 *  is routed to `unlisted`, by the shared rule above) rather than a row quietly falling out of a filter —
 *  which is how a tenant ends up with no surface anywhere. */
export function splitTenantRows<T extends { status: TenantStatus }>(rows: readonly T[]): TenantRowLists<T> {
  const lists: TenantRowLists<T> = { onboarded: [], settled: [], unlisted: [] };
  for (const row of rows) {
    const offer = tenantRowOffer(row.status);
    if (!offer.listed) lists.unlisted.push(row);
    else if (offer.settled) lists.settled.push(row);
    else lists.onboarded.push(row);
  }
  return lists;
}
