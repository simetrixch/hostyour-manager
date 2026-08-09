import { describe, it, expect } from "vitest";
import { abortOffer, runOnScreen, runTenantPurgeTarget } from "./runScreen.ts";
import type { PurgeTenantTarget, RunTenantStateView, RunView } from "../../shared/api-types.ts";

// The Run screen's honesty rules. All of them are about the same failure mode — the screen saying one
// thing while acting on another — and all are pure, so they are tested here rather than through the
// component.

const run = (id: string, kind: RunView["kind"], status: RunView["status"]): RunView => ({
  id,
  kind,
  targetKind: "cluster",
  targetId: "cls_1",
  status,
  summary: `${kind} ${id}`,
  steps: [],
  requiredSecrets: [],
  requiredInputs: [],
  createdAt: 0,
  startedAt: null,
  endedAt: null,
  deletedAt: null,
});

const target: PurgeTenantTarget = { guid: "zsfk0m57xp87", subdomain: "simetrix", stage: "prod", clusterId: "cls_1" };
const row = { tenantId: "tnt_1", suspended: false };

describe("runOnScreen", () => {
  // The run-to-run hop: a failed create-tenant plans a tenant-purge and navigates to ITS run id, which
  // matches the SAME route pattern — so RunDetail stays mounted and re-runs its effects while the run
  // object is still the previous run's. Everything on the screen (header, steps, action bar) would then
  // describe the create-tenant while Abort/Retry/Delete act on the tenant-purge.
  it("refuses a loaded run that is not the run the address bar names", () => {
    expect(runOnScreen(run("run_A", "create-tenant", "failed"), "run_B")).toBeNull();
  });

  // The same guard, for the race a reset-on-id-change does NOT close: the GET of the OLD run was already
  // in flight when the id changed and resolves afterwards, writing run A back into state under id B.
  it("keeps refusing it when the previous run's in-flight GET resolves after the hop", () => {
    const stale = run("run_A", "create-tenant", "failed");
    expect(runOnScreen(stale, "run_B")).toBeNull();
    expect(runOnScreen(null, "run_B")).toBeNull(); // and nothing is shown until the right run lands
  });

  it("shows the loaded run once it IS the run on screen", () => {
    const r = run("run_B", "tenant-purge", "planned");
    expect(runOnScreen(r, "run_B")).toBe(r);
  });
});

describe("runTenantPurgeTarget", () => {
  // The rule has to answer for EVERY member of RunTenantStateView, because the callout renders one branch
  // per member and the server can send any of them. The member that was once missing from the browser
  // entirely is "not-deployed": a create-tenant whose attest-target refused — a deploy-state mismatch, an
  // unreachable slave — froze a guid and then deployed NOTHING, so it carries a target and no `row`. Back
  // when the browser kept its own copy of this union it simply never learned that member, the answer fell
  // through to the last arm of the callout's chain (the offboarded arm), and that arm reads
  // `tenant.row.status`: the whole Run screen threw on the single most ordinary create-tenant failure.
  // The union is now declared once (shared/api-types.ts) and returned by the server's own
  // resolveRunTenantState, so a new member cannot arrive unannounced — and this table keeps the RULE
  // honest about the members that exist: an unanswered one fails the switch's exhaustiveness.
  const cases: [RunTenantStateView, PurgeTenantTarget | null][] = [
    [{ state: "none", reason: "it created nothing to purge" }, null],
    [{ state: "not-deployed", target }, null],
    [{ state: "orphan", target }, target],
    [{ state: "unfinished", target, row: { ...row, status: "provisioning" } }, target],
    [{ state: "live", target, row: { ...row, status: "active" } }, null],
    [{ state: "offboarded", target, row: { ...row, status: "offboarded" } }, null],
    // the second settled state. A purge already deprovisioned this tenant — Tenant
    // CR, Vault path, object-storage credential and Mongo databases all gone — so there is nothing left
    // to remove and no target is named. It needs its own row in this table because it is shaped exactly
    // like "offboarded" (same `target`, same `row`): the switch's exhaustiveness is what forced an answer
    // for it, and this is what pins the answer as `null` rather than a purge offer on a purged tenant.
    [{ state: "purged", target, row: { ...row, status: "purged" } }, null],
  ];

  it.each(cases)("names the standing tenant for %o", (tenant, expected) => {
    expect(runTenantPurgeTarget(tenant)).toEqual(expected);
  });

  // A state that names no tenant must say so with `null`, never with `undefined` — the difference is a
  // switch arm that answered and one that fell off the end, and only the first is a decision.
  it("answers every state — a missing arm is undefined, which is not an answer", () => {
    for (const [tenant] of cases) expect(runTenantPurgeTarget(tenant)).not.toBeUndefined();
  });
});

describe("abortOffer", () => {
  // THE case: create-tenant deployed the tenant, watch-sync-set and smoke passed, record-inventory
  // settled the row to "active" and the tenant is SERVING — only `activate` (the first-admin invite, the
  // deliberately-last step) threw, e.g. an HTTP 503 from a freshly started tenant example-auth. The run is
  // failed, and an abort would git-rm the live pointer and let ArgoCD prune the whole fan-out.
  it("refuses the abort when the run's tenant is LIVE", () => {
    const live: RunTenantStateView = { state: "live", target, row: { ...row, status: "active" } };
    const offer = abortOffer("create-tenant", live, null);
    expect(offer.offered).toBe(false);
    expect(offer.offered === false && offer.why).toContain(target.guid);
  });

  // Fail-closed: no answer yet is not "the tenant is not live".
  it("refuses the abort while the tenant state is still being resolved", () => {
    expect(abortOffer("create-tenant", null, null).offered).toBe(false);
  });

  it("refuses the abort when the tenant state could not be read at all", () => {
    const offer = abortOffer("create-tenant", null, "run rn_1 not found");
    expect(offer.offered).toBe(false);
    expect(offer.offered === false && offer.why).toContain("run rn_1 not found");
  });

  // The two states where the compensation is genuinely the remedy — and the confirmation must be able to
  // name the tenant it takes down.
  it("offers the abort for an orphan and for an unfinished tenant, naming the tenant it un-deploys", () => {
    const orphan: RunTenantStateView = { state: "orphan", target };
    const unfinished: RunTenantStateView = { state: "unfinished", target, row: { ...row, status: "provisioning" } };
    expect(abortOffer("create-tenant", orphan, null)).toEqual({ offered: true, tenant: target });
    expect(abortOffer("create-tenant", unfinished, null)).toEqual({ offered: true, tenant: target });
  });

  // Refused before it deployed, or no guid was ever frozen: nothing was created, so the abort is pure run
  // bookkeeping and is offered — but it names no tenant, because claiming one would be the same false
  // statement in the other direction. The confirmation takes that name from runTenantPurgeTarget, so a
  // state missing from THAT switch would have the dialog promise to un-deploy `undefined`.
  it("offers the abort with no tenant named for the two states that never deployed anything", () => {
    const notDeployed: RunTenantStateView = { state: "not-deployed", target };
    const none: RunTenantStateView = { state: "none", reason: "it created nothing to purge" };
    expect(abortOffer("create-tenant", notDeployed, null)).toEqual({ offered: true, tenant: null });
    expect(abortOffer("create-tenant", none, null)).toEqual({ offered: true, tenant: null });
  });

  // THE defect an operator hit end to end on this screen: a
  // create-tenant fails, the operator purges the tenant it left behind, then returns to the failed run —
  // where "Abort (cleanup)" was still ENABLED, directly above the callout's own sentence that no removal
  // is offered on that tenant anywhere, because there is nothing left to reap. Two adjacent elements
  // asserting opposites. Confirming ran the create-tenant's rollback (settledStatus "offboarded",
  // tenantId null): every step no-opped, and its record step re-resolved the row by (clusterId, guid) and
  // DOWNGRADED a purged tenant to "offboarded" with the create-tenant's run id — putting a deprovisioned
  // tenant back on the "Offboarded tenants" panel, advertising the purge that had already run, with a
  // detail page telling the operator its namespace, Tenant CR, Vault path and Mongo databases still
  // stood. The server refuses that write now (shared/enums.ts atLeastAsSettledAs) and is the guard; this
  // is the surface that stops offering it.
  //
  // These two expectations previously asserted `{ offered: true, tenant: null }` — a test pinning the
  // defect, not a contract: "the confirmation names no tenant" was read as licence to still offer the
  // abort, when the very reason no tenant can be named is that a removal already took it down. Both
  // settled states are refused, and the refusal says which removal ran, since what survived it differs.
  it("REFUSES the abort on a tenant a removal has already settled", () => {
    const offboarded: RunTenantStateView = { state: "offboarded", target, row: { ...row, status: "offboarded" } };
    const purged: RunTenantStateView = { state: "purged", target, row: { ...row, status: "purged" } };

    const afterPurge = abortOffer("create-tenant", purged, null);
    expect(afterPurge.offered).toBe(false);
    expect(afterPurge.offered === false && afterPurge.why).toContain(target.guid);
    expect(afterPurge.offered === false && afterPurge.why).toContain("already been purged");

    const afterOffboard = abortOffer("create-tenant", offboarded, null);
    expect(afterOffboard.offered).toBe(false);
    expect(afterOffboard.offered === false && afterOffboard.why).toContain("already been offboarded");
    // ...and it points at the verb that DOES still have work on such a tenant, on the page that offers it
    // (tenantRows.ts calls an offboarded row purgeable) — a refusal that named no way forward would just
    // read as a broken button.
    expect(afterOffboard.offered === false && afterOffboard.why).toMatch(/purge/i);
  });

  // The two functions answer the same question — "is there a tenant standing here?" — and a screen that
  // let them disagree is exactly how the defect above rendered: runTenantPurgeTarget already returned
  // null for both settled states while the action bar went on offering a removal for them.
  it("never offers an abort for a state runTenantPurgeTarget says has no tenant standing, except the two that never deployed", () => {
    const settled: RunTenantStateView[] = [
      { state: "offboarded", target, row: { ...row, status: "offboarded" } },
      { state: "purged", target, row: { ...row, status: "purged" } },
      { state: "live", target, row: { ...row, status: "active" } },
    ];
    for (const tenant of settled) {
      expect(runTenantPurgeTarget(tenant)).toBeNull();
      expect(abortOffer("create-tenant", tenant, null).offered).toBe(false);
    }
  });

  // Only create-tenant mints a tenant of its own; the tenant-state route refuses every other kind (400),
  // so no state is ever fetched for them and the gate must not stall on the absence of one.
  it("offers the abort unconditionally for every other run kind", () => {
    for (const kind of ["onboard", "tenant-offboard", "tenant-purge", "add-app", "deploy-slave", "adopt"] as const) {
      expect(abortOffer(kind, null, null)).toEqual({ offered: true, tenant: null });
    }
  });
});
