import type { RunKind } from "../../shared/enums.ts";
import type { PurgeTenantTarget, RunTenantStateView, RunView } from "../../shared/api-types.ts";

// The honesty rules of the Run screen, kept OUT of the components (the same factoring runKinds.ts
// follows for the section run families): what that screen may DESCRIBE, and what it may DO. They exist
// because RunDetail renders one run's words beside another run's buttons the moment either question is
// answered loosely — the words come from the loaded run object, the buttons act on the id in the address
// bar, and the destructive ones act on a TENANT the run merely created.

/** The run this screen may describe AND act on: the loaded run, but ONLY while it IS the run the address
 *  bar names. RunDetail can navigate straight from one run to another — a failed create-tenant plans a
 *  tenant-purge and opens ITS run screen — and because both ids match the same route pattern the
 *  component stays MOUNTED across that hop. Between the id change and the new GET landing, the loaded
 *  object is still the PREVIOUS run while every control already targets the new id: the header, the step
 *  list and the action bar would describe run A while Abort/Retry/Delete act on run B, and the
 *  failed-create-tenant gate would still read create-tenant/failed off run A and ask the server for the
 *  tenant state of a tenant-purge run (which it correctly refuses, painting a red error on the run that
 *  was just planned).
 *
 *  DERIVED from the id rather than cleared when the id changes, because clearing only covers the orderly
 *  hop: the in-flight GET of the OLD run can resolve AFTER the new id is on screen and paint the stale run
 *  straight back. Identity cannot be raced — a run that is not this run is simply not shown, and the
 *  screen keeps its ordinary "Loading run…" state until the right one arrives. */
export function runOnScreen(loaded: RunView | null, runId: string): RunView | null {
  return loaded !== null && loaded.id === runId ? loaded : null;
}

/** WHICH tenant, if any, a resolved run-tenant state still has STANDING — the one tenant a removal on
 *  this screen would take down, and therefore both the tenant a purge may be aimed at and the tenant an
 *  abort's confirmation must name. The two are one question, so they are answered in one place: the
 *  callout's "Purge tenant…" button and abortOffer below both read it here, and neither can offer a
 *  removal of a tenant the other says is not there.
 *
 *  It is the run-screen twin of tenantRows.ts's `purgeable`, which answers the same question for a tenant
 *  reached through its INVENTORY ROW, and it is written as an exhaustive switch over every member of
 *  RunTenantStateView for the reason that file states for its Record: a state added to that union — which
 *  is declared ONCE, in shared/api-types.ts, and returned by the server's resolveRunTenantState — must
 *  break THIS build rather than fall silently on the permissive side. It is the reason the union may live
 *  in one place at all: the browser cannot quietly know fewer states than the server sends.
 *  Only two states name a tenant — "orphan" (deployed, never recorded, reachable from nowhere else)
 *  and "unfinished" (a "provisioning" row its run never settled). The other five name none, each for its
 *  own reason: "none" and "not-deployed" never deployed anything, "live" is serving and must not be
 *  removed from here at all, "offboarded" has already had one removal run on it (the purge that reaps what
 *  that removal deliberately kept is aimed from the tenant page, not from the run that created the
 *  tenant), and "purged" is deprovisioned — there is nothing left to remove, so nothing is offered
 *. */
export function runTenantPurgeTarget(tenant: RunTenantStateView): PurgeTenantTarget | null {
  switch (tenant.state) {
    case "orphan":
    case "unfinished":
      return tenant.target;
    case "none":
    case "not-deployed":
    case "live":
    case "offboarded":
    case "purged":
      return null;
  }
}

/** Whether the failed-run action bar may offer "Abort (cleanup)" at all, and — when it may — WHICH tenant
 *  that abort takes down, so the confirmation can name it. */
export type AbortOffer =
  | { offered: true; tenant: PurgeTenantTarget | null }
  | { offered: false; why: string };

/** The gate on abort-with-cleanup. Abort is not "stop this run": it appends the run's
 *  registered compensations as visible cleanup steps and RUNS them, so on a create-tenant it performs the
 *  full pointer teardown of the tenant that run created — git-rm the pointer, let ArgoCD prune the whole
 *  fan-out, delete the isolation AppProject, mark the row offboarded.
 *
 *  Which is exactly why it cannot be decided from "the run failed". `activate` (the first-admin invite) is
 *  deliberately create-tenant's LAST step, placed after record-inventory so a failed invite never rolls
 *  back a live deployment, and an HTTP 503 from a freshly started tenant example-auth is a known live
 *  condition. A run that failed only there sits behind a tenant that is SERVING, and one click on a
 *  destructive control offered as a routine next step would un-deploy it. So the answer comes from the
 *  SAME server-resolved tenant state the callout below the action bar renders its words from
 *  (GET /api/tenants/runs/:runId/tenant-state) — one read, one answer, never a second source of truth
 *  that can disagree with the copy printed sixteen lines further down the page.
 *
 *  FAIL-CLOSED on everything short of an answer: while the state is still resolving, and when it could not
 *  be read at all, the tenant may be live and the abort stays refused.
 *
 *  REFUSED on both SETTLED states too, and that is the second half of the same honesty rule
 *. A tenant that is "offboarded" or "purged" has already had a removal run on it:
 *  its pointer is git-rm'd, its fan-out is pruned, its isolation AppProject is deleted and its row is
 *  terminal — so this run's rollback, which is exactly that teardown, has nothing left to take down. What
 *  it would still do is reach its record step and re-stamp a settled row with THIS run's id and THIS
 *  flavour's status. On a purged tenant that is a downgrade to "offboarded": the tenant reappears on the
 *  Tenants page's "Offboarded tenants" panel advertising the purge that already ran, and its detail page
 *  tells the operator its namespace, Tenant CR, Vault path and Mongo databases still stand — every one of
 *  which the purge deleted. The server refuses that write on its own (the settle rule, shared/enums.ts
 *  atLeastAsSettledAs, asked by both record steps) and IS the guard; this is the honest surface in front
 *  of it, and until it said so the action bar offered an ENABLED "Abort (cleanup)" directly above the
 *  callout's own sentence that no removal is offered anywhere on that tenant — two adjacent elements
 *  asserting opposites. It also matches runTenantPurgeTarget, which already answers `null` for both:
 *  neither function may offer a removal the other says is not there.
 *
 *  Still OFFERED, with no tenant named, for the two states that never deployed anything ("none",
 *  "not-deployed"): there is nothing to un-deploy, but neither is there a settled removal to contradict —
 *  the compensations were never even armed (record-provisional is where they are registered), so the abort
 *  is pure run bookkeeping. WHICH tenant the confirmation names is runTenantPurgeTarget's answer, never a
 *  second list of states here. */
export function abortOffer(kind: RunKind, tenant: RunTenantStateView | null, tenantError: string | null): AbortOffer {
  // Only create-tenant mints a tenant of its own — every other kind's compensations undo that run's own
  // work, and the tenant-state route refuses them (400), so there is nothing to gate on.
  if (kind !== "create-tenant") return { offered: true, tenant: null };
  if (tenantError !== null) {
    return {
      offered: false,
      why: `The tenant this run created could not be read (${tenantError}), so it is not known whether it is live — abort stays disabled rather than risk un-deploying a serving tenant.`,
    };
  }
  if (tenant === null) {
    return { offered: false, why: "Still working out what this failed create-tenant left behind — abort stays disabled until that answer is in." };
  }
  if (tenant.state === "live") {
    return {
      offered: false,
      why: `The tenant this run created (${tenant.target.guid}) is live — an abort would remove its pointer and let ArgoCD prune the whole fan-out. Retry the failed step, or open the tenant to resend the admin invite.`,
    };
  }
  if (tenant.state === "purged") {
    return {
      offered: false,
      why:
        `The tenant this run created (${tenant.target.guid}) has already been purged — its GitOps pointer, its fan-out, its isolation AppProject and its Tenant CR are gone, its namespace was issued a delete, and with the CR went its Vault path, its object-storage credential and its Mongo databases.` +
        " This run's rollback is that same teardown, so there is nothing left for it to un-deploy. Delete the run once you no longer need its log.",
    };
  }
  if (tenant.state === "offboarded") {
    return {
      offered: false,
      why:
        `The tenant this run created (${tenant.target.guid}) has already been offboarded — its pointer is removed, its fan-out is pruned and its row is settled, so this run's rollback is exactly the removal that already ran.` +
        " What that offboard deliberately KEPT — the namespace, the Tenant CR, the Vault path, the object-storage credential and the Mongo databases — is reaped by a purge from the tenant's own page, not from here. Delete the run once you no longer need its log.",
    };
  }
  return { offered: true, tenant: runTenantPurgeTarget(tenant) };
}
