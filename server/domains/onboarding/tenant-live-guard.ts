// tenant-live-guard.ts — the ONE rule that answers "is this tenant still DEPLOYED and SERVING?", and
// therefore whether a verb that would take it off its cluster may proceed at all. It is stated here
// exactly once and asked from every end that can reach such a tenant, so the two ends can never drift
// into two slightly different answers about the same tenant.
//
// WHO ASKS IT, and where:
//   tenant-purge   at PLAN time on POST /api/tenants/purge (api.ts), so an operator is refused before
//                  anything approvable exists — and again at EXECUTE time in the run's own attest-target
//                  step (tenant-purge.run.ts), beside the belt that re-checks the frozen clusterId.
//   create-tenant  at ABORT time, through the definition's assertAbortable hook (asked in
//                  create-tenant-abort.ts assertCreateTenantAbortable, which create-tenant.run.ts wires
//                  onto the def), before the executor schedules a single rollback step: that rollback IS
//                  the shared teardown, so aborting a run whose tenant went live un-deploys a serving
//                  tenant.
//
// WHY THE EXECUTE-TIME ASK IS NOT A DUPLICATE OF THE PLAN-TIME ONE. A refusal made while a plan is being
// CREATED says nothing about the moment that plan is APPROVED. A tenant-purge planned while its tenants
// row was legitimately "provisioning" stays `planned` for as long as the operator leaves it there, and
// Executor.approve re-validates nothing — no plan guards, no re-read of the row, no plan-hash re-check —
// so a create-tenant retry that settles that very row to "active" in the meantime leaves an approvable
// purge aimed at a tenant that is now serving, behind a frozen plan summary still describing it as it was.
// The abort path has the same shape from the other side: the run screen hides the abort on a live tenant,
// but a hidden button is a convenience, not a guard — and its tenant-state read is keyed on the run, whose
// SSE stream closes when the run settles, so a parked tab never learns the tenant went live.
//
// WHICH ROWS THE RULE REFUSES, and why the GitOps pointer is the second half of the question:
//   - NO row at all — the ORPHAN. Allowed: naming a tenant the inventory does not know is the entire
//     reason tenant-purge exists, and a create-tenant that never wrote a row has nothing live to protect.
//   - "provisioning" — the create-tenant run that never finished. Allowed: this is precisely the state
//     both verbs are the remedy for (the purge from the Tenants list, the abort from the run screen).
//   - "offboarded" — settled un-deployed. Allowed, and deliberately so: tenant-offboard un-deploys
//     a tenant but leaves its IDENTITY standing, so the Tenant CR and the Vault path outlive that row and
//     purge is the only verb that reaps them. The Mongo databases do NOT outlive it: the prune deletes
//     every member's ServiceClaim and the service-provisioner drops a claim's databases with it, so an
//     offboard already costs the data — a purge then finds nothing left to drop.
//   - "purged" — settled DEPROVISIONED: a purge already ran to completion, so
//     there is nothing left out there. Allowed too, and that is a deliberate decision rather than an
//     oversight: every step of tenant-purge reaps only what is still there, so a RE-purge is idempotent
//     and harmless, and it is the retry path for a purge whose own record step already ran. What changes
//     with the state is only that the product stops ADVERTISING the action — the Tenants page drops such a
//     row and its detail page offers no removal (web tenantRows.ts) — never that the route refuses it.
//     Refusing here would also break the migration path for tenants purged BEFORE that state existed,
//     which is exactly "re-run the purge once".
//   - "active"/"suspended" WITH a tenant.yaml still standing — REFUSED. The pointer is what the appsets
//     generate the whole fan-out from, so a live row plus a standing pointer is a tenant that is deployed
//     and serving, and tenant-offboard is the removal verb for it (the tenant can be re-onboarded
//     afterwards under the same identity — but back it up first, because the prune's claim cascade drops
//     the member databases). A purge may follow that offboard to reap what it leaves.
//   - "active"/"suspended" with NO pointer — allowed. That is the FAILED-OFFBOARD state: the teardown's
//     remove step committed the pointer removal and a later step failed, so the row still says live while
//     the tenant is already un-deployed and only leftovers stand. Refusing there would leave that tenant
//     with no removal verb at all — tenant-offboard cannot settle it while its fan-out refuses to prune,
//     and the orphan scan cannot see it because the pointer is gone — which is the very no-surface
//     dead end the removal verbs exist to end.
// ABSENT is the only pointer state that counts as un-deployed, exactly as in the teardown's own remove
// step: "unreadable" means a tenant.yaml DOES stand, and a body nobody can parse is no proof of removal.
// Reading it costs one catalog fetch, and ONLY for a live row — the orphan path stays a pure DB
// read. Without a registry the fact is unobtainable, so a live row is refused rather than assumed gone.
//
// Boundary: domain layer (onboarding) — one inventory read + the TenantRegistry's own git read, no
// adapters and no IO of its own.
import { and, eq } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { tenants } from "../../db/schema/inventory.ts";
import { errNotConfigured, errValidation } from "../../kernel/errors.ts";
import type { Stage, TenantStatus } from "../../../shared/enums.ts";
import type { TenantRegistry } from "./tenant-registry.ts";

/** The two row states that mean the tenant is DEPLOYED and expected to serve. Named as a POSITIVE set
 *  rather than written as `!== "provisioning" && !== "offboarded"`, because the negative form classifies
 *  any status added to TENANT_STATUS later as live and would therefore refuse verbs on it sight unseen —
 *  which is how a re-purge of an already-purged tenant would have been refused the moment "purged"
 *  existed. The set is the other trade, and it is the one taken knowingly: a new status is ALLOWED until
 *  this list says otherwise, so every addition to TENANT_STATUS owes this rule a decision, recorded in the
 *  header's bullets above ("purged" is the most recent). "suspended" belongs here:
 *  suspend prunes the fan-out but KEEPS the Tenant CR, the namespace, the Vault path and the Mongo
 *  databases, and the tenant is one tenant-resume away from serving again — nothing about it is leftover
 *  state. */
export const TENANT_LIVE_STATUS: readonly TenantStatus[] = ["active", "suspended"];

/** How ONE caller names ITSELF inside the refusal. The RULE is shared; the WORDS are the verb's own,
 *  because "what would have happened to this tenant" is exactly what the operator needs to read and the
 *  two verbs do very different things to it. Each verb builds this once and hands the same value to both
 *  of its ends, so the plan-time and the execute-time refusal are word-for-word the same sentence. */
export interface TenantLiveRefusal {
  /** How the two sentences below NAME the action ("the purge", "the abort") — the subject of the clause
   *  that says the controller could not establish the tenant is already un-deployed. */
  subject: string;
  /** What the action WOULD do to a tenant that turns out to be live, as one sentence ending in a full
   *  stop. Follows "tenant <subdomain> (<guid>) is <status> in the inventory — ". */
  consequence: string;
  /** What the operator should do INSTEAD — the way out, as a lowercase clause. Follows "Its tenant.yaml
   *  still stands, so the fan-out is still deployed: ". */
  instead: string;
}

/** Refuse `t` when it is a tenant that is still deployed and serving — the rule above, asked once per
 *  caller-end. Silent (returns) on every row state that is NOT live, and on a live row whose GitOps
 *  pointer is gone. Throws VALIDATION on a live tenant, NOT_CONFIGURED when no registry is wired and the
 *  pointer is therefore unreadable — never a silent pass, since "cannot read" is not "is not there". */
export async function assertTenantNotLive(
  db: Db,
  registry: TenantRegistry | undefined,
  t: { guid: string; stage: Stage },
  refusal: TenantLiveRefusal,
): Promise<void> {
  // Keyed on (guid, stage) — the guid is the sole tenant identity and the stage its pointer path, the
  // same key resolveRunTenantState and resolveTeardownTarget resolve a tenant by.
  const row = db
    .select({ subdomain: tenants.subdomain, status: tenants.status })
    .from(tenants)
    .where(and(eq(tenants.guid, t.guid), eq(tenants.stage, t.stage)))
    .get();
  if (!row || !TENANT_LIVE_STATUS.includes(row.status)) return;
  const named = `tenant ${row.subdomain} (${t.guid}) is ${row.status} in the inventory — ${refusal.consequence}`;
  if (!registry) {
    throw errNotConfigured(`${named} Its GitOps pointer cannot be read on this controller, so ${refusal.subject} cannot establish that the tenant is already un-deployed`);
  }
  if ((await registry.scanTenant(t.stage, t.guid)).status !== "absent") {
    throw errValidation(`${named} Its tenant.yaml still stands, so the fan-out is still deployed: ${refusal.instead}`);
  }
}
