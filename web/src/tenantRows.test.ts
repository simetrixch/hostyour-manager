import { describe, it, expect } from "vitest";
import { defaultEnvironment, groupTenantEnvironments, splitTenantRows, tenantRowOffer, tenantConfirmTitle, typedConfirmation } from "./tenantRows.ts";
import { TENANT_STATUS, type Stage, type TenantStatus } from "../../shared/enums.ts";

// The tenant screens' one status rule: which surface a tenants row gets, and whether a purge may be
// offered on it there. It is pure, so it is tested here rather than through the two components that
// render it — the same factoring runScreen.test.ts describes for the Run screen's rules.

const row = (id: string, status: TenantStatus): { id: string; status: TenantStatus } => ({ id, status });

describe("tenantRowOffer", () => {
  // THE regression. tenant-offboard un-deploys a tenant and KEEPS its cluster
  // state — the <guid> namespace, its Tenant CR, its Vault path, its object-storage credential and its
  // Mongo databases outlive the row — and the purge route accepts exactly this row state
  // (server tenant-live-guard.ts). An offboarded row that no surface offers a purge on is therefore a
  // tenant the owner wants gone WITH its data that nothing in the product can finish removing, and no
  // other path reaches it: every removal git-rm's the pointer as its first step, so the orphan scan
  // (which reads pointers) can never return it.
  it("offers the purge on an offboarded tenant — the only run kind that reaps what the offboard kept", () => {
    expect(tenantRowOffer("offboarded")).toEqual({ settled: true, listed: true, purgeable: true });
  });

  // The unfinished tenant (create-tenant recorded the row before deploying and its run never finished):
  // it stays on the card list AND is purgeable — purge is one of the two ways out of that state.
  it("offers the purge on an unfinished tenant, and keeps it on the card list", () => {
    expect(tenantRowOffer("provisioning")).toEqual({ settled: false, listed: true, purgeable: true });
  });

  // The other half of the same rule, which must NOT loosen: a tenant the inventory records live is
  // refused by the purge route while its GitOps pointer still stands, and the browser cannot read that
  // pointer — so no purge is offered here at all. Offboard is the run kind these two get, and a purge may
  // follow it.
  it("offers no purge on a live tenant — offboard first, then purge what it leaves behind", () => {
    expect(tenantRowOffer("active")).toEqual({ settled: false, listed: true, purgeable: false });
    expect(tenantRowOffer("suspended")).toEqual({ settled: false, listed: true, purgeable: false });
  });

  // The client side of the "purged" status. A purge deprovisions the tenant, so
  // the row is terminal like an offboarded one — but there is nothing left to reap, and while the two
  // shared the one "offboarded" literal the panel kept the tenant AND kept offering the purge that had
  // just finished. Both halves are asserted, because each was wrong on its own: `listed: false` takes it
  // off the Tenants page, `purgeable: false` stops the product advertising the most destructive run kind it
  // has on a tenant with nothing to remove. The route still ACCEPTS a re-purge (server
  // tenant-live-guard.ts) — that is the migration path for rows purged before this state existed — so
  // this flag is narrower than the route on purpose, and only about what is OFFERED.
  it("shows no purged tenant on the Tenants page, and offers it no purge", () => {
    expect(tenantRowOffer("purged")).toEqual({ settled: true, listed: false, purgeable: false });
  });

  // The Record is typed over TenantStatus so a new status breaks the build; this catches the runtime
  // half of that promise (a widened key type would answer undefined instead).
  it("answers for every tenant status", () => {
    for (const status of TENANT_STATUS) expect(tenantRowOffer(status)).toBeDefined();
  });
});

describe("splitTenantRows", () => {
  // A PARTITION, not a filter: the offboarded tenant must come back on the settled list, because a row
  // the page drops has no surface anywhere in the product — and it is the one row that still needs a
  // run kind (see the offer test above).
  it("keeps an offboarded tenant on the settled list instead of dropping it", () => {
    const settledRow = row("tnt_gone", "offboarded");
    const lists = splitTenantRows([row("tnt_live", "active"), settledRow, row("tnt_half", "provisioning")]);
    expect(lists.settled).toEqual([settledRow]);
    expect(lists.onboarded.map((t) => t.id)).toEqual(["tnt_live", "tnt_half"]);
  });

  // The other half of the client rule: the purged tenant leaves the page. It must
  // land on NEITHER of the two rendered lists — not the cards (nothing runs) and above all not `settled`,
  // whose panel is titled "Offboarded tenants" and offers the purge, which is exactly where a finished
  // purge would otherwise sit looking like nothing had happened.
  it("routes a purged tenant off the page — neither the cards nor the offboarded panel", () => {
    const purgedRow = row("tnt_purged", "purged");
    const lists = splitTenantRows([row("tnt_live", "active"), row("tnt_gone", "offboarded"), purgedRow]);
    expect(lists.unlisted).toEqual([purgedRow]);
    expect(lists.onboarded.map((t) => t.id)).toEqual(["tnt_live"]);
    expect(lists.settled.map((t) => t.id)).toEqual(["tnt_gone"]);
  });

  // Nothing is lost between the three lists, whatever the inventory holds — the invariant that makes
  // "which list" a routing decision rather than a visibility decision. `unlisted` exists precisely so
  // that hiding the purged tenant stays a decision this function STATES rather than a row falling out of
  // a predicate, which is how a tenant ends up with no surface anywhere.
  it("routes every row into exactly one list", () => {
    const rows = TENANT_STATUS.map((status, i) => row(`tnt_${i}`, status));
    const lists = splitTenantRows(rows);
    expect([...lists.onboarded, ...lists.settled, ...lists.unlisted].map((t) => t.id).sort()).toEqual(rows.map((t) => t.id).sort());
  });

  it("answers empty lists for an empty inventory", () => {
    expect(splitTenantRows([])).toEqual({ onboarded: [], settled: [], unlisted: [] });
  });
});

describe("groupTenantEnvironments", () => {
  const row = (id: string, stage: Stage, status: TenantStatus) => ({ id, guid: "ak64h58875qw", stage, status });
  it("shows simetrix once, with its PROD and TEST rows as its environments", () => {
    const groups = groupTenantEnvironments([row("tnt_p", "prod", "active"), row("tnt_t", "test", "active"), { ...row("tnt_o", "prod", "active"), guid: "other0000000" }]);
    expect(groups.map((g) => g.key)).toEqual(["ak64h58875qw", "other0000000"]);
    expect(groups[0]!.byStage).toEqual({ prod: row("tnt_p", "prod", "active"), test: row("tnt_t", "test", "active") });
  });
  it("reads a purged environment as absent, while the row stands beside a later one of that stage", () => {
    const [group] = groupTenantEnvironments([row("tnt_p", "prod", "active"), row("tnt_t", "test", "purged")]);
    expect(group!.byStage.test).toBeUndefined();
    const [readded] = groupTenantEnvironments([row("tnt_t2", "test", "provisioning"), row("tnt_t", "test", "purged")]);
    expect(readded!.byStage.test?.id).toBe("tnt_t2");
  });
  it("opens on PROD, then TEST, then DEV, and never on a settled row", () => {
    const [group] = groupTenantEnvironments([row("tnt_d", "dev", "active"), row("tnt_t", "test", "active"), row("tnt_p", "prod", "offboarded")]);
    expect(defaultEnvironment(group!)?.id).toBe("tnt_t");
    const [settled] = groupTenantEnvironments([row("tnt_p", "prod", "offboarded")]);
    expect(defaultEnvironment(settled!)).toBeUndefined();
  });
});

describe("typedConfirmation", () => {
  it("asks for the guid and the environment on PROD, and for the guid elsewhere", () => {
    expect(typedConfirmation({ guid: "ak64h58875qw", stage: "prod" })).toBe("ak64h58875qw prod");
    expect(typedConfirmation({ guid: "ak64h58875qw", stage: "test" })).toBe("ak64h58875qw");
  });
});

describe("tenantConfirmTitle", () => {
  const t = { subdomain: "simetrix", stage: "test" as const, domain: "apps1.digitacloud.app" };
  it("names the environment and its machine in every changing or destructive confirmation", () => {
    expect(tenantConfirmTitle.removeApp(t, "erp")).toBe('Remove app "erp" from "simetrix" · test on apps1.digitacloud.app?');
    expect(tenantConfirmTitle.backup(t)).toBe('Back up tenant "simetrix" · test on apps1.digitacloud.app?');
    expect(tenantConfirmTitle.restore(t)).toBe('Restore tenant "simetrix" · test, now on apps1.digitacloud.app, from its backup?');
    expect(tenantConfirmTitle.offboard(t)).toBe('Offboard tenant "simetrix" · test on apps1.digitacloud.app?');
  });
});
