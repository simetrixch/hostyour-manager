import { describe, it, expect } from "vitest";
import { abortOffer, approvePayload, readyToApprove, runOnScreen, runTenantPurgeTarget, secretsToSupply } from "./runScreen.ts";
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
    expect(runOnScreen(run("run_A", "tenant-create", "failed"), "run_B")).toBeNull();
  });

  // The same guard, for the race a reset-on-id-change does NOT close: the GET of the OLD run was already
  // in flight when the id changed and resolves afterwards, writing run A back into state under id B.
  it("keeps refusing it when the previous run's in-flight GET resolves after the hop", () => {
    const stale = run("run_A", "tenant-create", "failed");
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
  // per member and the server can send any of them. The member easiest to miss in the browser
  // is "not-deployed": a create-tenant whose attest-target refused — a deploy-state mismatch, an
  // unreachable slave — froze a guid and then deployed NOTHING, so it carries a target and no `row`. A
  // browser keeping its own copy of this union never learns that member, the answer falls
  // through to the last arm of the callout's chain (the offboarded arm), and that arm reads
  // `tenant.row.status`: the whole Run screen throws on the single most ordinary create-tenant failure.
  // The union is declared once (shared/api-types.ts) and returned by the server's own
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
    const offer = abortOffer("tenant-create", live, null);
    expect(offer.offered).toBe(false);
    expect(offer.offered === false && offer.why).toContain(target.guid);
  });

  // Fail-closed: no answer yet is not "the tenant is not live".
  it("refuses the abort while the tenant state is still being resolved", () => {
    expect(abortOffer("tenant-create", null, null).offered).toBe(false);
  });

  it("refuses the abort when the tenant state could not be read at all", () => {
    const offer = abortOffer("tenant-create", null, "run rn_1 not found");
    expect(offer.offered).toBe(false);
    expect(offer.offered === false && offer.why).toContain("run rn_1 not found");
  });

  // The two states where the compensation is genuinely the remedy — and the confirmation must be able to
  // name the tenant it takes down.
  it("offers the abort for an orphan and for an unfinished tenant, naming the tenant it un-deploys", () => {
    const orphan: RunTenantStateView = { state: "orphan", target };
    const unfinished: RunTenantStateView = { state: "unfinished", target, row: { ...row, status: "provisioning" } };
    expect(abortOffer("tenant-create", orphan, null)).toEqual({ offered: true, tenant: target });
    expect(abortOffer("tenant-create", unfinished, null)).toEqual({ offered: true, tenant: target });
  });

  // Refused before it deployed, or no guid was ever frozen: nothing was created, so the abort is pure run
  // bookkeeping and is offered — but it names no tenant, because claiming one would be the same false
  // statement in the other direction. The confirmation takes that name from runTenantPurgeTarget, so a
  // state missing from THAT switch would have the dialog promise to un-deploy `undefined`.
  it("offers the abort with no tenant named for the two states that never deployed anything", () => {
    const notDeployed: RunTenantStateView = { state: "not-deployed", target };
    const none: RunTenantStateView = { state: "none", reason: "it created nothing to purge" };
    expect(abortOffer("tenant-create", notDeployed, null)).toEqual({ offered: true, tenant: null });
    expect(abortOffer("tenant-create", none, null)).toEqual({ offered: true, tenant: null });
  });

  // THE defect an operator meets end to end on this screen: a
  // create-tenant fails, the operator purges the tenant it left behind, then returns to the failed run —
  // where "Abort (cleanup)" is still ENABLED, directly above the callout's own sentence that no removal
  // is offered on that tenant anywhere, because there is nothing left to reap. Two adjacent elements
  // asserting opposites. Confirming runs the create-tenant's rollback (settledStatus "offboarded",
  // tenantId null): every step no-ops, and its record step re-resolves the row by (clusterId, guid) and
  // DOWNGRADES a purged tenant to "offboarded" with the create-tenant's run id — putting a deprovisioned
  // tenant back on the "Offboarded tenants" panel, advertising the purge that already ran, with a
  // detail page telling the operator its namespace, Tenant CR, Vault path and Mongo databases still
  // stand. The server refuses that write (shared/enums.ts atLeastAsSettledAs) and is the guard; this
  // is the surface that stops offering it.
  //
  // Asserting `{ offered: true, tenant: null }` here would pin the
  // defect and not a contract: "the confirmation names no tenant" read as licence to still offer the
  // abort, when the very reason no tenant can be named is that a removal already took it down. Both
  // settled states are refused, and the refusal says which removal ran, since what survived it differs.
  it("REFUSES the abort on a tenant a removal has already settled", () => {
    const offboarded: RunTenantStateView = { state: "offboarded", target, row: { ...row, status: "offboarded" } };
    const purged: RunTenantStateView = { state: "purged", target, row: { ...row, status: "purged" } };

    const afterPurge = abortOffer("tenant-create", purged, null);
    expect(afterPurge.offered).toBe(false);
    expect(afterPurge.offered === false && afterPurge.why).toContain(target.guid);
    expect(afterPurge.offered === false && afterPurge.why).toContain("already been purged");

    const afterOffboard = abortOffer("tenant-create", offboarded, null);
    expect(afterOffboard.offered).toBe(false);
    expect(afterOffboard.offered === false && afterOffboard.why).toContain("already been offboarded");
    // ...and it points at the run kind that DOES still have work on such a tenant, on the page that offers it
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
      expect(abortOffer("tenant-create", tenant, null).offered).toBe(false);
    }
  });

  // Only create-tenant mints a tenant of its own; the tenant-state route refuses every other kind (400),
  // so no state is ever fetched for them and the gate must not stall on the absence of one.
  it("offers the abort unconditionally for every other run kind", () => {
    for (const kind of ["consumer-onboard", "tenant-offboard", "tenant-purge", "tenant-add-app", "cluster-deploy-slave", "cluster-redeploy"] as const) {
      expect(abortOffer(kind, null, null)).toEqual({ offered: true, tenant: null });
    }
  });
});

describe("secretsToSupply / readyToApprove", () => {
  // WHAT WENT WRONG ONCE, and what these hold shut. deploy-slave moved onto ansiwise programs, which run
  // as root on the machine and so declare an elevation password; the ceremony on this screen still said
  // "One click — nothing to fill in" and approved with an empty payload. Every attempt came back from the
  // executor as `missing required secret: ansiwise-elevation`, and no field existed anywhere to satisfy
  // it. The screen may therefore not know which secrets a kind needs — it reads the plan.
  const slave = (requiredSecrets: string[]): RunView => ({
    ...run("run_1", "cluster-deploy-slave", "planned"),
    requiredSecrets,
  });

  it("asks for exactly what the plan requires, never a list kept beside it", () => {
    expect(secretsToSupply(slave(["ansiwise-elevation"]))).toEqual(["ansiwise-elevation"]);
    // A plan that grows a second requirement grows a second field, with nothing here to edit.
    expect(secretsToSupply(slave(["ansiwise-elevation", "build-plane-pat"]))).toEqual([
      "ansiwise-elevation",
      "build-plane-pat",
    ]);
  });

  it("holds the approve back until every required field carries something", () => {
    const r = slave(["ansiwise-elevation"]);
    expect(readyToApprove(r, {})).toBe(false);
    // A BLANK IS NOT A VALUE: the server drops empty strings, so this approve would return the same
    // refusal the field exists to prevent.
    expect(readyToApprove(r, { "ansiwise-elevation": "   " })).toBe(false);
    expect(readyToApprove(r, { "ansiwise-elevation": "hunter2" })).toBe(true);
  });

  it("still lets a plan that requires nothing through on one click", () => {
    expect(secretsToSupply(slave([]))).toEqual([]);
    expect(readyToApprove(slave([]), {})).toBe(true);
  });

  it("asks for nothing on a run that can no longer be approved", () => {
    // The fields belong to the approve, not to the run: a run already going, and a deleted one, are
    // read on this same screen and neither is waiting for a password.
    expect(secretsToSupply({ ...slave(["ansiwise-elevation"]), status: "running" })).toEqual([]);
    expect(secretsToSupply({ ...slave(["ansiwise-elevation"]), deletedAt: 1 })).toEqual([]);
  });
});

describe("approvePayload", () => {
  // WHAT MUST NOT GO MISSING. A ceremony that asks for the secrets a plan requires and for none of
  // its INPUTS lets a run be approved without them, and the act that needs one then refuses far
  // enough in that a machine or a namespace has already been changed. The payload is composed here
  // rather than in the form, because a form is the one thing this repository cannot test.
  const onboard = (): RunView => ({
    ...run("run_1", "consumer-onboard", "planned"),
    requiredSecrets: ["repo-pat"],
    // What a unit's own manifest prompts for (shared/consumer.ts ConsumerActivationPromptSchema),
    // which the onboard plan lists one for one.
    requiredInputs: [
      { field: "email", label: "First administrator email" },
      { field: "display_name", label: "The name that administrator is shown under" },
    ],
  });

  it("carries the secrets under their names and every input under activation-input:", () => {
    expect(approvePayload(onboard(), { "repo-pat": "pw" }, { email: "info@simetrix.ch" })).toEqual({
      "repo-pat": "pw",
      "activation-input:email": "info@simetrix.ch",
      // A BLANK IS SENT AS A BLANK: the server drops it (domains/runs/api.ts) and the refusal an
      // untyped answer earns is the one the field exists to produce, rather than a browser deciding
      // to withhold it.
      "activation-input:display_name": "",
    });
  });

  it("carries an input the plan declares even when nothing was typed into it", () => {
    const keys = Object.keys(approvePayload(onboard(), { "repo-pat": "pw" }, {}));
    expect(keys).toContain("activation-input:email");
    expect(keys).toContain("activation-input:display_name");
  });

  it("carries nothing of its own for a plan that declares neither", () => {
    // Every cluster run kind, once its answers came off the cluster map: the plan asks for the
    // machine password and lists no input at all.
    const bare = { ...run("run_1", "cluster-deploy-slave", "planned") };
    expect(approvePayload(bare, {}, {})).toEqual({});
  });
});
