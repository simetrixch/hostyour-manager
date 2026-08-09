import { describe, expect, it } from "vitest";
import { adminBadge, neverChecked, withoutAnAdministrator } from "./tenantAdmin.ts";

const now = new Date("2026-08-07T12:00:00Z").getTime();
const minutesAgo = (n: number) => now - n * 60_000;

describe("what the administrator check shows on a screen", () => {
  it("a tenant nobody can get into is the loud one", () => {
    const badge = adminBadge(
      { adminState: "none", adminCount: 0, adminCheckedAt: minutesAgo(30) },
      now,
    );

    expect(badge?.modifier).toBe("chip--warn");
    expect(badge?.label).toBe("no administrator");
    // The chip has to say what to DO about it, or an operator reads a red word and nothing else.
    expect(badge?.detail).toContain("invite one from its page");
  });

  it("a tenant that did not answer is muted, and says the question is still open", () => {
    const badge = adminBadge(
      { adminState: "unreachable", adminCount: null, adminCheckedAt: minutesAgo(5) },
      now,
    );

    expect(badge?.modifier).toBeNull();
    // Not a finding about administrators, and the detail says so in as many words — otherwise an
    // operator reads "not reached" as "broken" and the check gets ignored.
    expect(badge?.detail).toContain("says nothing about its administrators");
  });

  it("a healthy tenant is quiet, not green", () => {
    // A page where every row shouts is a page where the one row that matters does not stand out —
    // and chip--ok is green, which would state a health this check cannot promise between runs.
    const badge = adminBadge({ adminState: "ok", adminCount: 2, adminCheckedAt: minutesAgo(10) }, now);

    expect(badge?.modifier).toBeNull();
    expect(badge?.label).toBe("2 admins");
  });

  it("one administrator reads as one, not as 1 admins", () => {
    const badge = adminBadge({ adminState: "ok", adminCount: 1, adminCheckedAt: minutesAgo(10) }, now);
    expect(badge?.label).toBe("1 admin");
  });

  it("A TENANT NOBODY HAS ASKED ABOUT SHOWS NOTHING — never a green chip", () => {
    // The one thing this must not do. A tenant that has never been checked is not a tenant known to
    // be healthy, and a reassuring chip over an unasked question is exactly the lie the check exists
    // to stop telling.
    expect(adminBadge({ adminState: null, adminCount: null, adminCheckedAt: null }, now)).toBeNull();
    // Half-written state counts as unasked too.
    expect(adminBadge({ adminState: "ok", adminCount: 1, adminCheckedAt: null }, now)).toBeNull();
  });

  it("says how long ago in the coarsest unit that is still true", () => {
    expect(adminBadge({ adminState: "ok", adminCount: 1, adminCheckedAt: now - 30_000 }, now)?.detail)
      .toContain("just now");
    expect(adminBadge({ adminState: "ok", adminCount: 1, adminCheckedAt: minutesAgo(90) }, now)?.detail)
      .toContain("1 h ago");
    expect(adminBadge({ adminState: "ok", adminCount: 1, adminCheckedAt: now - 3 * 86_400_000 }, now)?.detail)
      .toContain("3 d ago");
  });
});

describe("which tenants the page pulls out", () => {
  const rows = [
    { id: "a", adminState: "none" as const, adminCount: 0, adminCheckedAt: now },
    { id: "b", adminState: "unreachable" as const, adminCount: null, adminCheckedAt: now },
    { id: "c", adminState: "ok" as const, adminCount: 1, adminCheckedAt: now },
    { id: "d", adminState: null, adminCount: null, adminCheckedAt: null },
  ];

  it("only the ones with no administrator — an unreachable tenant is NOT one of them", () => {
    // Putting unreachable rows in this list makes it a list an operator learns to scroll past,
    // after which the one row that matters is in a list nobody reads.
    expect(withoutAnAdministrator(rows).map((r) => r.id)).toEqual(["a"]);
  });

  it("counts the ones no check has reached yet, so a page can say so", () => {
    expect(neverChecked(rows)).toBe(1);
  });
});
