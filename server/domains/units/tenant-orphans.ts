// tenant-orphans.ts — the two ways to NAME a tenant the product otherwise cannot reach, i.e. the
// discovery half (the removal half is tenant-purge.run.ts).
//
// THE PROBLEM. An ORPHAN is a tenant that exists in GitOps + ArgoCD (pointer, fan-out, isolation
// AppProject, namespace, Tenant CR, Vault path, Mongo databases) with NO tenants row. Every other
// removal run kind (tenant-offboard / -suspend / remove-app) resolves its target BY that row (lifecycle.ts
// loadTenantCluster throws NOT_FOUND), and the Tenants list is a projection of the same rows, so an
// orphan is not merely unremovable: it is INVISIBLE. create-tenant no longer MAKES orphans — its
// record-provisional step writes the row before the first mutation — but three sources remain and this
// scan is the only net for them: tenants created before that fix, a create-tenant that died before
// record-provisional itself, and a pointer written into catalog by hand. tenant-purge is keyed on
// {guid, stage, clusterId} precisely so it needs no row — but the guid is MINTED by the plan, never
// typed by an operator, so a purge is only usable once something hands the operator that guid. That is
// what this module does, from the two sources that can still know it:
//
//   1. scanOrphanTenants — the GitOps POINTER scan diffed against the inventory: every guid with a live
//      registrations/<guid>/<stage>.yaml and no UNSETTLED tenants row. This is the general net,
//      and it is also the only source for a tenant whose creating run has long been deleted.
//   2. resolveRunTenantState — the frozen params of the create-tenant run ITSELF, RESOLVED AGAINST THE
//      INVENTORY (and, where the inventory is silent, against the run's OWN STEP ROWS — how far it got
//      is what separates a run that deployed and recorded nothing from one that never started).
//      Narrower but PRECISE, and it names a tenant the pointer scan structurally cannot see:
//      a failure between apply-appproject and write-pointer, where the <guid> AppProject (and possibly
//      the Tenant CR + namespace) already stand while NO pointer was ever committed. Since
//      record-provisional such a tenant is ALSO listed as unfinished, so this is now the direct hand-off
//      from the failed run rather than the only route to it — the operator is on the run screen, not
//      hunting a list.
//
// A SETTLED row — "offboarded" or "purged" (TENANT_SETTLED_STATUS, shared/enums.ts) — counts as absent
// here, exactly as it does in resolveTeardownTarget (tenant-replace.ts): the row records a removal that
// already ran, so a live pointer beside it is leftover state, not a healthy tenant. "purged" has
// to be in that set for the same reason "offboarded" is, and with more force: a
// tenant whose deprovision completed is as absent as a tenant can be, so a tenant.yaml that outlived it is
// exactly the leftover this scan exists to surface — and reading the row as "known" would hide it.
//
// Boundary: domain layer — inventory reads + the TenantRegistrations + tenant-values' cluster resolution,
// and the executor's own narrow run readers (read.ts) for the run facts, never the runs/steps tables
// directly (the dep-cruiser rule only-executor-touches-runs-schema). No adapters, no IO beyond the db
// reads and the registrations's git reads. The scan CLONES catalog, which is why its route is
// operator-triggered and fail-soft, never a page-load read.
import { z } from "zod";
import { and, eq, notInArray } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { tenants } from "../../db/schema/inventory.ts";
import { STAGE, TENANT_SETTLED_STATUS } from "../../../shared/enums.ts";
// The wire shapes this module ANSWERS IN, declared once in shared/api-types.ts and consumed unchanged by
// the browser (web/src/api.ts + the run/tenant screens). Both functions below return one of them by
// declared type, which is the whole compile-time link: a member added to RunTenantStateView, or a field
// added to a target, lands on both ends of the wire in the same typecheck. Declaring them here AND
// hand-mirroring them in the browser is the alternative — see the section header in
// shared/api-types.ts for what that costs.
import type {
  OrphanScan, OrphanTenantView, PurgeTenantTarget, RunTenantStateView, SkippedTenantPointerView,
} from "../../../shared/api-types.ts";
import { ATTEST_TARGET_STEP } from "../../executor/guards.ts";
import { getRunStepStatus } from "../../executor/read.ts";
import { TenantPurgeRequest } from "./tenant-purge.run.ts";
import type { TenantRegistrations } from "./tenant-registrations.ts";
import { resolveClusterIdByName } from "./tenant-values.ts";

/** Diff the LIVE GitOps pointers against the inventory, per stage, and return every tenant only the
 *  pointers know about — plus every pointer the scan had to skip. Scans ALL stages: the caller is an
 *  operator explicitly asking "what is out there?", and a stage-filtered scan would hide precisely the
 *  orphan nobody is looking for. Broken / drifted pointers do not wedge the scan (they are skipped
 *  inside the registrations scan, scanTenantDir) and they do not vanish either — they come back in `skipped`,
 *  each with the guid its DIRECTORY is named by and the reason it could not be read. THROWS when
 *  catalog cannot be read at all — the route turns that into a visible, fail-soft "the scan itself
 *  failed", which must never be flattened into an empty result (that would read as "no orphans", the
 *  exact opposite of the truth). */
export async function scanOrphanTenants(deps: { db: Db; registrations: TenantRegistrations }): Promise<OrphanScan> {
  const { db, registrations } = deps;
  const found: OrphanTenantView[] = [];
  const skipped: SkippedTenantPointerView[] = [];
  for (const stage of STAGE) {
    // The inventory side of the diff: every tenant this manager BELIEVES is deployed at this stage.
    // A settled row (offboarded or purged) is deliberately not "known" — see the header.
    const known = new Set(
      db
        .select({ guid: tenants.guid })
        .from(tenants)
        .where(and(eq(tenants.stage, stage), notInArray(tenants.status, [...TENANT_SETTLED_STATUS])))
        .all()
        .map((r) => r.guid),
    );
    const scan = await registrations.listTenantPointers(stage);
    skipped.push(...scan.skipped); // reported, never dropped — see OrphanScan
    for (const pointer of scan.pointers) {
      if (known.has(pointer.guid)) continue;
      const resolved = resolveClusterIdByName(db, pointer.cluster, stage);
      found.push({
        guid: pointer.guid,
        subdomain: pointer.subdomain,
        stage,
        cluster: pointer.cluster,
        clusterId: resolved?.clusterId ?? null,
      });
    }
  }
  return { orphans: found, skipped };
}

/** The purge target carried by a create-tenant run's FROZEN params — literally TenantPurgeRequest
 *  ({guid, stage, clusterId}) plus the subdomain, because the create-tenant params are a SUPERSET of
 *  what a purge needs. Extending the purge request rather than re-declaring the three fields makes
 *  that a structural fact: the two can never drift apart.
 *
 *  Parsing is the GUARD, not a formality. A create-tenant run that failed while still `planning` was
 *  only ever persisted with the operator's RAW request (streaming-plan.ts writes rawParams first and
 *  overwrites them when the plan settles `planned`), which carries no guid — and that is exactly
 *  right: no guid was frozen, so nothing was ever deployed and there is nothing to purge. A failed
 *  parse therefore means "this run created nothing", never "this run is broken".
 *
 *  `satisfies z.ZodType<PurgeTenantTarget>` is the drift guard on the OTHER side of this schema: what it
 *  parses goes onto the wire as the `target` of a RunTenantStateView, so its output must remain exactly
 *  the shape shared/api-types.ts declares. The schema is the stricter of the two (the guid alphabet, the
 *  cls_ prefix — validation a wire type cannot express); the check only pins that the SHAPE is the one
 *  the browser is compiled against, so a field renamed or dropped here fails at this line rather than at
 *  runtime in a screen that reads it. */
export const CreateTenantPurgeTarget = TenantPurgeRequest.extend({ subdomain: z.string().min(1) }) satisfies z.ZodType<PurgeTenantTarget>;
export type CreateTenantPurgeTarget = z.infer<typeof CreateTenantPurgeTarget>;

/** Did this run ever get PAST its fail-closed precondition — i.e. did it reach a step that mutates
 *  anything? guards.assertGuardsArmed pins step 0 of every mutating def to attest-target,
 *  and create-tenant's own steps put record-provisional immediately after it, so "attest-target
 *  completed" IS "this run started deploying".
 *
 *  Only "pending" (never reached) and "failed" (it refused) are read as NOT past it. Every other answer —
 *  "ok", the "skipped" an abort's abandonUnfinished leaves on a step that never completed, and the
 *  `undefined` of a run with no such step row — falls on the side of "it may have mutated", deliberately:
 *  overstating what a run left behind costs the operator a purge that reaps nothing, while understating
 *  it hides a deployed tenant that no other run kind in the product can name. */
function startedDeploying(db: Db, runId: string): boolean {
  const status = getRunStepStatus(db, runId, ATTEST_TARGET_STEP);
  return status !== "pending" && status !== "failed";
}

/** Resolve ONE create-tenant run into a RunTenantStateView — the single decision the run screen's callout
 *  renders (copy AND action) from, so the two can never disagree. Two reads, no IO: the tenants row the
 *  run's frozen params name, and (only when there is none) how far the run itself got.
 *
 *  The seven states, WHY the answer comes from the ROW rather than from the run's kind + status, and WHY a
 *  missing row alone cannot mean "orphan" are all documented at the union itself (shared/api-types.ts
 *  RunTenantStateView) — it is one declaration, shared with the browser that renders it, so the reasoning
 *  lives with it instead of being restated on either side. Two facts belong HERE, at the resolution:
 *
 *  (1) The row is looked up by (guid, stage), the SAME key resolveTeardownTarget (tenant-replace.ts) uses:
 *      the guid is the sole tenant identity and the stage is its pointer path. Unlike that function a
 *      SETTLED row is NOT folded into "absent" — it is a fact the operator must be told ("this tenant was
 *      already removed"), not a reason to re-offer a destructive purge. A leftover footprint beside a
 *      settled row is what the pointer scan above exists to surface. The two settled states are answered
 *      SEPARATELY, as "offboarded" and "purged", because the screen says opposite
 *      things about them: after an offboard the tenant's cluster state was deliberately KEPT and the purge
 *      that reaps it is still ahead; after a purge it is deprovisioned and there is nothing left to
 *      remove. Folding "purged" into the offboarded arm would print the wrong sentence, and letting it
 *      fall THROUGH both would be far worse — the remaining arm is "live", i.e. the screen would call a
 *      deprovisioned tenant a serving one.
 *
 *  (2) The run's own STEP rows are the other half of the no-row case (startedDeploying, read.ts
 *      getRunStepStatus): they decide both what the screen SAYS ("failed after it had started deploying"
 *      would be false of a refused precondition) and what the abort offer beside it PROMISES (a teardown
 *      that removes a pointer and prunes a fan-out, on a run that registered no cleanups at all —
 *      record-provisional is where they are armed). */
export function resolveRunTenantState(db: Db, runId: string, runParams: unknown): RunTenantStateView {
  const parsed = CreateTenantPurgeTarget.safeParse(runParams);
  if (!parsed.success) {
    return { state: "none", reason: "this create-tenant run failed before its plan froze a tenant guid — it created nothing to purge" };
  }
  const target = parsed.data;
  const row = db
    .select({ tenantId: tenants.id, status: tenants.status, suspended: tenants.suspended })
    .from(tenants)
    .where(and(eq(tenants.guid, target.guid), eq(tenants.stage, target.stage)))
    .get();
  // No row is TWO different tenants — see the header: one that never left the starting gate, one that
  // deployed and was never recorded. The row is the stronger evidence wherever it exists (record-
  // provisional cannot have written it without the precondition holding first), so the run's steps are
  // only consulted here.
  if (!row) return startedDeploying(db, runId) ? { state: "orphan", target } : { state: "not-deployed", target };
  if (row.status === "provisioning") return { state: "unfinished", target, row };
  if (row.status === "offboarded") return { state: "offboarded", target, row };
  if (row.status === "purged") return { state: "purged", target, row };
  return { state: "live", target, row };
}
