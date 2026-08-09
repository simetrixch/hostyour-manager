import type { ReactNode } from "react";
import type { TenantStatus } from "../../../shared/enums.ts";

// How a tenant's lifecycle state is SHOWN. The pill and the sentence that explains the one state a
// single word cannot carry live in the SAME file on purpose: the Tenants list and the tenant detail page
// both render both, so keeping them together is what stops the two screens from labelling — or
// describing — the same tenant differently.

/** The ONE tenant status pill, for a tenants row and for a row of its apps[] matrix alike. Every other
 *  status renders as its own enum literal, including the two terminal ones — "offboarded" (un-deployed,
 *  cluster state kept) and "purged" (deprovisioned) — which is the point of their
 *  being separate states at all: the word IS how an operator tells the two removals apart. Two states
 *  deliberately do NOT render as the raw enum literal:
 *   - "provisioning" renders as "unfinished" on its own `.badge--unfinished` token, NEVER the shared
 *     `.badge--provisioning` pill the server/cluster rows carry: that one is accent-tinted with a PULSING
 *     dot, i.e. "in flight", and a create-tenant run that died would pulse forever as if it were still
 *     making progress. This tenant is stopped, and the badge has to say so.
 *   - a tenant carrying the suspend flag reads "suspended" while its row still says "active":
 *     tenant-suspend flips the pointer first and settles the row only in its record step, so during that
 *     window the flag is the honest answer.
 *  `suspended` is optional because a tenant_apps row has no suspend flag of its own — the tenant-wide
 *  pause is a property of the tenant, and its app rows only ever carry the plain status. */
export function TenantStatusBadge({ status, suspended = false }: { status: TenantStatus; suspended?: boolean }): ReactNode {
  const token = status === "provisioning" ? "unfinished" : suspended && status === "active" ? "suspended" : status;
  return <span className={`badge badge--${token}`}>{token}</span>;
}

/** The prose twin of the "unfinished" badge. It exists because the badge is one
 *  word while the state needs three facts: the row is there ONLY because create-tenant records its
 *  intent BEFORE it deploys, the tenant is therefore not known to be serving anything, and the way out
 *  is to finish the run or remove what it left behind. The DEFINITION is fixed here so the three screens
 *  that show it (the Tenants list, the tenant detail page, a failed create-tenant's run screen) can never
 *  describe the same state differently.
 *
 *  `next` is the one part that MUST differ: each screen shows different evidence of how far the run got
 *  (live checks, a link to the run, the run's own step list), and a fixed sentence pointing at evidence a
 *  screen does not have would be exactly the kind of false claim this notice exists to prevent. It is
 *  required, not optional, so a new caller has to say where ITS operator looks. `children` carries that
 *  screen's actions (the run link, the purge trigger). */
export function UnfinishedTenantNotice({ next, children }: { next: ReactNode; children?: ReactNode }): ReactNode {
  return (
    <div className="actionbar">
      <span className="actionbar__text">
        <strong>This tenant is unfinished.</strong> Its create-tenant run recorded the tenant before deploying anything and then
        never finished, so the tenant may be half-deployed or not deployed at all &mdash; do not treat it as live. {next}
      </span>
      {children}
    </div>
  );
}
