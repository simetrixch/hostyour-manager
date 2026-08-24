import { describe, expect, it } from "vitest";
import { adminsIn } from "../../adapters/tenant-health/tenant-health-http.ts";
import { ADMIN_GRACE_MS, candidatesFrom, verdictFor } from "./check-tenants.run.ts";

/**
 * What the check decides, and what it refuses to decide.
 *
 * The three refusals below are the whole reason this is credible rather than noisy, and each one is
 * a way a check gets muted — after which it reports nothing at all, including the one thing it exists
 * for.
 */
describe("check-tenants — turning a reading into a verdict", () => {
  const now = new Date("2026-08-07T12:00:00Z");
  const old = new Date(now.getTime() - ADMIN_GRACE_MS - 1);
  const fresh = new Date(now.getTime() - 60_000);

  it("an administrator present is ok", () => {
    expect(verdictFor({ reached: true, admins: 1, createdAt: old, now })).toBe("ok");
    expect(verdictFor({ reached: true, admins: 7, createdAt: old, now })).toBe("ok");
  });

  it("REFUSAL 1: unreachable is never a finding about administrators", () => {
    // A tenant mid-restart, mid-deploy or behind a DNS change did not answer. That says nothing
    // about whether anybody can administer it, and reporting it as if it did is how the whole check
    // gets ignored.
    expect(verdictFor({ reached: false, createdAt: old, now })).toBe("unreachable");
  });

  it("REFUSAL 2: zero administrators inside the grace period is not a finding", () => {
    // A tenant onboarded minutes ago has none yet — that is its normal state while the first-admin
    // invitation is out. Without this, the FIRST check of every new tenant is a false alarm.
    expect(verdictFor({ reached: true, admins: 0, createdAt: fresh, now })).toBe("ok");
  });

  it("zero administrators past the grace period IS the finding", () => {
    expect(verdictFor({ reached: true, admins: 0, createdAt: old, now })).toBe("none");
  });

  it("the boundary belongs to the grace period, not to the finding", () => {
    const exactly = new Date(now.getTime() - ADMIN_GRACE_MS);
    expect(verdictFor({ reached: true, admins: 0, createdAt: exactly, now })).toBe("none");
    const justInside = new Date(now.getTime() - ADMIN_GRACE_MS + 1);
    expect(verdictFor({ reached: true, admins: 0, createdAt: justInside, now })).toBe("ok");
  });
});

describe("check-tenants — who gets asked", () => {
  const base = {
    guid: "zsjs023ctne0",
    subdomain: "acme",
    stage: "prod" as const,
    domain: "m1.example.com",
    identityProvider: "auth",
    clusterId: "clu_1",
  };

  it("REFUSAL 3: a suspended tenant is skipped rather than reported unreachable", () => {
    // It renders no ingress and runs no pods, so asking it produces a transport error EVERY time —
    // an "unreachable" that says nothing and would bury the findings that matter.
    const { ask, skipped } = candidatesFrom([
      { ...base, id: "tnt_1", suspended: true, status: "active" },
      { ...base, id: "tnt_2", suspended: false, status: "active" },
    ]);

    expect(ask.map((t) => t.id)).toEqual(["tnt_2"]);
    expect(skipped).toBe(1);
  });

  it("a tenant whose provisioning never finished is skipped — it may have no auth member at all", () => {
    const { ask, skipped } = candidatesFrom([
      { ...base, id: "tnt_1", suspended: false, status: "provisioning" },
      { ...base, id: "tnt_2", suspended: false, status: "offboarded" },
      { ...base, id: "tnt_3", suspended: false, status: "active" },
    ]);

    expect(ask.map((t) => t.id)).toEqual(["tnt_3"]);
    expect(skipped).toBe(2);
  });

  it("counts what it skipped, so the number asked is never silently smaller than the estimate", () => {
    const { ask, skipped } = candidatesFrom([
      { ...base, id: "tnt_1", suspended: true, status: "active" },
      { ...base, id: "tnt_2", suspended: false, status: "purged" },
    ]);

    expect(ask).toHaveLength(0);
    expect(skipped).toBe(2);
  });
});

describe("check-tenants — reading the answer", () => {
  it("takes the count under either spelling the endpoint uses", () => {
    expect(adminsIn({ admins: 2 })).toBe(2);
    expect(adminsIn({ adminCount: 3 })).toBe(3);
  });

  it("a body it cannot read is NOT a zero", () => {
    // A zero would mean "nobody can administer this tenant", which is a finding. A body this cannot
    // parse is not evidence of that, and turning one into the other is how a check invents an
    // incident out of a deployment that changed a field name.
    expect(adminsIn({})).toBeNull();
    expect(adminsIn({ admins: "two" })).toBeNull();
    expect(adminsIn({ admins: -1 })).toBeNull();
    expect(adminsIn({ admins: 1.5 })).toBeNull();
    expect(adminsIn(null)).toBeNull();
    expect(adminsIn("2")).toBeNull();
  });
});
