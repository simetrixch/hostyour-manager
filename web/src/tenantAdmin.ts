import type { TenantAdminState } from "../../shared/enums.ts";

// What the administrator check's finding LOOKS LIKE on a screen — kept out of the components the
// same way tenantRows.ts holds which list a row goes into and runKinds.ts holds the section
// families. The Tenants list and the tenant detail page both show it, so stating it once is what
// stops one screen from calling a tenant fine that the other calls unreachable.
//
// The check itself is `check-tenants` (server/domains/units/check-tenants.run.ts), started
// every six hours by boot/check-tenants-schedule.ts. It writes three columns and nothing here
// re-derives its verdict: the THRESHOLD that turns a count into a state belongs to the check, and a
// second opinion computed on this side would be a second place that has to agree about what "no
// administrator" means.

/** One tenant, as this module needs it. Structural, so both pages pass their own row type. */
export interface AdminFacts {
  adminState: TenantAdminState | null;
  adminCount: number | null;
  adminCheckedAt: number | null;
}

/** How a state reads on a screen, or null where there is nothing to show.
 *
 * `modifier` is the chip class the design system already has (ui.css) — `chip--warn` is the loudest
 * one there is, since tokens.css reserves red for terminal error lines. Everything that is not the
 * finding gets the plain chip: a page where every row shouts is a page where the one row that
 * matters does not stand out, and a healthy tenant in particular must be quiet rather than green. */
export interface AdminBadge {
  label: string;
  modifier: "chip--warn" | null;
  /** The full sentence, for the chip's title attribute — what was found and when. */
  detail: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** How long ago, in the coarsest unit that is still true. */
function since(at: number, now: number): string {
  const ms = Math.max(0, now - at);
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} min ago`;
  if (ms < DAY_MS) return `${Math.floor(ms / 3_600_000)} h ago`;
  return `${Math.floor(ms / DAY_MS)} d ago`;
}

/** What to show for one tenant.
 *
 * Returns null when no check has run yet. That is deliberately NOT rendered as "fine": a tenant
 * nobody has asked about is not a tenant known to be healthy, and a green chip over an unasked
 * question is the exact lie this check exists to stop telling. It shows as nothing, and the page
 * says elsewhere that the check has not run. */
export function adminBadge(t: AdminFacts, now: number): AdminBadge | null {
  if (t.adminState === null || t.adminCheckedAt === null) return null;
  const when = since(t.adminCheckedAt, now);
  switch (t.adminState) {
    case "none":
      return {
        label: "no administrator",
        modifier: "chip--warn",
        detail: `Checked ${when}: this tenant reported no administrators. Nobody can get into it — invite one from its page.`,
      };
    case "unreachable":
      return {
        label: "not reached",
        modifier: null,
        detail: `Checked ${when}: the tenant's auth did not answer. That says nothing about its administrators — it may be restarting, deploying, or behind a DNS change.`,
      };
    case "ok":
      return {
        label: t.adminCount === null ? "administrator ok" : `${t.adminCount} admin${t.adminCount === 1 ? "" : "s"}`,
        modifier: null,
        detail: `Checked ${when}: somebody can administer this tenant.`,
      };
  }
}

/** The rows a check found nobody can administer.
 *
 * Only `none` — never `unreachable`. A tenant that did not answer is not a tenant without an
 * administrator, and putting it in this list would make the list something an operator learns to
 * scroll past. */
export function withoutAnAdministrator<T extends AdminFacts>(rows: readonly T[]): T[] {
  return rows.filter((r) => r.adminState === "none");
}

/** How many rows carry no check at all, so a page can say so rather than imply everything is fine. */
export function neverChecked<T extends AdminFacts>(rows: readonly T[]): number {
  return rows.filter((r) => r.adminState === null).length;
}
