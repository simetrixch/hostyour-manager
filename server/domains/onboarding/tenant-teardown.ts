// tenant-teardown.ts — the ONE pointer-driven teardown of a deployed tenant, shared by every run that
// has to take a tenant off its cluster without owning the whole tenant-offboard run kind: the create-tenant
// IDEMPOTENT-BY-SUBDOMAIN replace prepends one teardown per existing
// same-subdomain tenant, create-tenant's own ABORT-WITH-CLEANUP registers it as its compensating
// inverse, and the orphan removal reaps a tenant the row-keyed run kinds cannot even
// name. It mirrors offboard-tenant.run.ts's offboardSteps shape — its own steps are named remove ->
// watch-prune -> delete-projects -> record, under the composing run's `stepPrefix` and the guid, where
// offboardSteps has remove-tenant -> watch-removal -> delete-appproject -> record-offboard on a tenant it
// resolves from the row — MINUS attest-target: the COMPOSING run keeps its OWN attest-target (on its
// own target) as step 0, which the executor requires of every mutating run. A composing run's own destructive
// cluster-side steps ride INTO the builder as its `cascade`, between delete-projects and record, so the
// row flip is always the last thing a removal does.
//
// POINTER-DRIVEN, never row-driven — the load-bearing property. Every step works from the frozen
// TenantTeardownTarget (guid/stage/clusterId + the fan-out watch set) and NEVER loadTenantCluster, so
// it also reaches an ORPHAN: a tenant that exists in GitOps + ArgoCD but has NO tenants row. Every
// removal run kind resolves its target BY that row (lifecycle.ts loadTenantCluster throws NOT_FOUND), so an
// orphan is otherwise unreachable through the product.
//
// Boundary: domain layer (onboarding) — the TenantRegistry + the per-cluster kube resolver + the pure
// fan-out algebra + the inventory rows; no adapters, no IO of its own.
import { z } from "zod";
import { eq, and, notInArray } from "drizzle-orm";
import type { Step } from "../../executor/types.ts";
import { tenants, tenantApps } from "../../db/schema/inventory.ts";
import { errValidation } from "../../kernel/errors.ts";
import { localTx } from "../../executor/stepkit.ts";
import { guid as guidSchema } from "../../../shared/tenant.ts";
import { STAGE, atLeastAsSettledAs, type TenantSettledStatus } from "../../../shared/enums.ts";
import type { ArgoAppStatusMap } from "../../adapters/kube/port.ts";
import { memberAppProject, memberNamespace } from "./tenant-fanout.ts";
import { tenantMemberAdmissionPolicyName } from "./admission-policy.ts";
import { renderTenantArgoSync } from "./build-rbac.ts";
import { clearRelocationHold, type TenantLifecyclePorts } from "./lifecycle.ts";
import { allPruned, lingering, tenantSelector } from "./tenant-lifecycle.run.ts";

/** ONE tenant a teardown takes off its cluster. Frozen into the composing run's params at plan time so
 *  steps() rebuilds the SAME steps at execute/resume (create-tenant freezes a list of these as
 *  `replaces`). Carries everything the steps need WITHOUT an inventory row:
 *  guid/stage/clusterId + the fan-out watch set — `tenantId` is nullable precisely because an ORPHAN
 *  has no tenants row to flip. Resolved by tenant-replace.ts:resolveTeardownTarget. */
export const TenantTeardownTargetSchema = z.object({
  guid: guidSchema,
  subdomain: z.string(), // the tenant's public FQDN label (for the run log)
  stage: z.enum(STAGE),
  clusterId: z.string().startsWith("cls_"), // where the fan-out + AppProject live (the resolver key)
  cluster: z.string().min(1), // the ArgoCD-registered slave name (for the run log)
  // The inventory row id the plan resolved, or null when it found none — an ORPHAN, or a row that does
  // not exist YET (create-tenant's own abort teardown: record-provisional mints the id at execute time).
  // The record step re-resolves by (clusterId, guid) when this is null, so null never means "skip blind".
  tenantId: z.string().startsWith("tnt_").nullable(),
  watchNames: z.array(z.string()), // the fan-out Applications to wait for the prune of
  // The tenant's MEMBERS (auth/jobs/report + one per app) as the plan resolved them — the teardown
  // deletes ONE AppProject per member, and a member the plan could not name is a project left standing
  // that a later re-onboard would then be refused against. Resolved beside watchNames from the same two
  // sources (tenant-replace.ts), so the two can never disagree about what this tenant is made of.
  members: z.array(z.string()),
});
export type TenantTeardownTarget = z.infer<typeof TenantTeardownTargetSchema>;

/** Delete ONE tenant's argo-sync grant from the ArgoCD namespace its Applications live in — shared by
 *  the two removal shapes, this builder's delete-projects and tenant-offboard's delete-appprojects, so
 *  a tenant can never be taken down by one of them and keep a Role naming its Applications. Reports
 *  whether anything was there. An unwired writer means the Controller provisioned no grant in the
 *  first place, so there is nothing to take back. */
export async function deleteTenantArgoSync(ports: Pick<TenantLifecyclePorts, "buildRbac">, guid: string, argoNamespace: string): Promise<boolean> {
  if (!ports.buildRbac) return false;
  const { deleted } = await ports.buildRbac.deleteBuildRbac([renderTenantArgoSync({ guid, applications: [], argoNamespace, units: [] })]);
  return deleted > 0;
}

/** What the prune wait does when the fan-out has NOT gone Missing within the watch budget — the same
 *  distinction purge.run.ts documents for consumers, applied to the tenant fan-out:
 *   - "fail-loud": THROW. The pointer is removed but the workloads linger, and a composing run must
 *     not proceed past that — the create-tenant replace would otherwise deploy the fresh guid onto the
 *     one public FQDN the old fan-out is still serving. This is tenant-offboard's contract too.
 *   - "fail-soft": OBSERVE and continue. An orphan is precisely the half-created / crash-looping
 *     tenant that never reaches a clean Missing, so blocking on it would strand exactly the tenant the
 *     teardown exists to reap; the cluster-side deletes that follow are the backstop. A watch READ
 *     failure (ArgoCD unreachable) is observed the same way instead of being fatal.
 *     The tolerance ends at the INVENTORY ROW: after the cascade has had its go, the settle guard
 *     (settlePruneGuardStep) re-reads the fan-out and fails the run rather than let the record step
 *     settle a row over workloads it can still see. Soft about proceeding, never about the record. */
export type TenantPrunePolicy = "fail-loud" | "fail-soft";

/** How the steps NAME this teardown to the operator. Two runs tear the SAME tenant down for very
 *  different reasons and the run log has to say which, so the flavour is passed in, never guessed. */
export interface TenantTeardownWording {
  /** Step-title prefix, rendered as `<title> <guid>: …` (e.g. "Replace"). */
  title: string;
  /** Subject of the ONE message written WHILE the pointer is removed (present tense). */
  removing: string;
  /** Subject every LATER message names the tenant with (past tense — its pointer is already gone). */
  settled: string;
}

/** The per-flavour knobs a composing run supplies. Nothing here is optional: a teardown that silently
 *  defaulted its prune policy would decide, invisibly, whether a stuck fan-out stops the run — and one
 *  that defaulted its settled status would decide, just as invisibly, WHICH terminal state the operator
 *  is told the tenant reached. */
export interface TenantTeardownOpts {
  /** The step-name prefix identifying WHY this teardown runs (e.g. "replace"). The builder ALWAYS
   *  appends the guid — `<stepPrefix>-<guid>-remove` — so a run composing several teardowns (one per
   *  replaced tenant, plus its own onboard steps) can never collide on a step name, which the executor
   *  keys step impls by. The guid is not the caller's to omit, hence the builder adds it. */
  stepPrefix: string;
  prune: TenantPrunePolicy;
  wording: TenantTeardownWording;
  /** WHICH terminal status the record step settles the tenants + tenant_apps rows to — the flavour's
   *  answer to "what is still out there?", and a per-flavour knob rather than a constant because the
   *  three composing runs leave genuinely different tenants behind:
   *   - the pointer-only flavours (REPLACE_TEARDOWN, create-tenant's ABORT_TEARDOWN) settle "offboarded":
   *     they issue no cluster-side delete of their own, so the member namespaces, the Tenant CR, the
   *     Vault path and the object-storage credential all stand and a purge is still the run kind for it.
   *     The member DATABASES do not stand: the prune deletes every member's ServiceClaim and the
   *     service-provisioner drops a claim's databases with its user, so the removal costs the data
   *     whichever flavour runs it — each composing run's operator text says so;
   *   - tenant-purge's PURGE_TEARDOWN settles "purged": it reaped every member namespace and destroyed
   *     the tenant's Vault entry itself, so nothing is left to reap.
   *  Settling both to "offboarded" leaves the two indistinguishable
   *  in the inventory, a purged tenant keeps its place on the Tenants page's "Offboarded tenants" panel,
   *  and the most destructive run kind in the product appears to do nothing.
   *
   *  Typed TenantSettledStatus, not TenantStatus: a teardown settles a row, so the only answers that mean
   *  anything here are the TERMINAL ones — and the record step compares this value against what the row
   *  already carries (atLeastAsSettledAs, shared/enums.ts), which only the ordered terminal states have an
   *  answer for. */
  settledStatus: TenantSettledStatus;
}

/** The create-tenant REPLACE flavour: the existing same-subdomain tenant is torn
 *  down BEFORE the fresh guid deploys onto the shared public FQDN — so a fan-out that will not prune
 *  MUST stop the run (fail-loud) rather than let two tenants serve the one FQDN. Pointer-only: the
 *  replaced tenant's identity (namespaces, Tenant CR, Vault path) survives and its row settles
 *  "offboarded" — its member databases do NOT (the prune's ServiceClaim deletions drop them), which
 *  the create-tenant plan summary warns about before the operator approves. */
export const REPLACE_TEARDOWN: TenantTeardownOpts = {
  stepPrefix: "replace",
  prune: "fail-loud",
  wording: { title: "Replace", removing: "replacing existing tenant", settled: "replaced tenant" },
  settledStatus: "offboarded",
};

/** The FAIL-SOFT teardown's SETTLE GUARD — its own step, placed after the composing run's `cascade` and
 *  immediately before the record step, so it is the last thing that happens before the inventory row is
 *  flipped to its terminal status (opts.settledStatus).
 *
 *  WHY it exists. Fail-soft means the prune watch OBSERVES a fan-out that never reached Missing and
 *  CONTINUES, which is right: a purge must be able to reap a tenant whose ArgoCD is wedged, and its
 *  cluster-side deletes are the backstop. What must NOT follow from that tolerance is a run ending
 *  SUCCEEDED with the row settled while those Applications are still standing — a settled row is off the
 *  Tenants page's card list, offers no live action on its detail page and cannot be found by the orphan
 *  scan either (the first teardown step git-rm'd its pointer), which is exactly the settled-but-unfinished
 *  state the removal family exists to end, re-created at the tail of the removal run kind. A row settled
 *  "purged" is the sharper form of the same lie, since that status states the tenant was DEPROVISIONED
 *  and drops it off the Tenants page altogether. The OBSERVATION stays soft; the
 *  SETTLING does not. Failing here also keeps the target reachable for another attempt in the only way the
 *  executor offers one: a failed run is retryable from its failed step, a succeeded run is not.
 *
 *  WHY it re-reads instead of remembering the watch above. This look happens AFTER the cascade — for
 *  tenant-purge the Tenant CR delete and the namespace backstop reap — so it asks a genuinely NEW
 *  question: the deletes meant to force the fan-out down have now been issued, and the watch budget gives
 *  them their chance. It is also what makes a retry converge, since it re-asks the cluster instead of
 *  failing forever off a stale checkpoint. A fan-out that will never prune can still be settled
 *  deliberately: the executor's skip-step takes a mandatory reason and records it in the audit log, which
 *  is the honest way to say "I know, and I am settling it anyway".
 *
 *  An EMPTY watch set is nothing to prove and proves nothing — fail-soft carries it by design (a
 *  create-tenant that died before write-pointer names no fan-out at all) and the cluster-side deletes reap
 *  that tenant by guid — so no read is made. A watch READ failure, tolerated by the observation above, is
 *  fatal here for the same reason a lingering fan-out is: an unreadable ArgoCD cannot prove anything gone. */
function settlePruneGuardStep(ports: TenantLifecyclePorts, t: TenantTeardownTarget, opts: TenantTeardownOpts): Step {
  const { title, settled } = opts.wording;
  return {
    name: `${opts.stepPrefix}-${t.guid}-verify-prune`,
    title: `${title} ${t.guid}: verify its fan-out is gone before settling the row`,
    run: async (ctx) => {
      if (t.watchNames.length === 0) {
        ctx.log("meta", `${settled} ${t.guid} named no fan-out Application — nothing to verify; its cluster footprint was reaped by guid`);
        return;
      }
      // The one sentence both refusals below end on: WHY the run fails here instead of recording the
      // tenant removed, and what the operator's next move is.
      const unsettled =
        `everything this teardown could reap was reaped, but the inventory row is deliberately NOT settled — a row claiming ${opts.settledStatus} ` +
        `while those Applications keep running would drop the tenant out of the Tenants list and out of the orphan scan. ` +
        `Retry this step once the master ArgoCD reports the fan-out gone.`;
      const pruned = allPruned(t.watchNames);
      let status: ArgoAppStatusMap;
      try {
        const { argoReader, argoNamespace } = await ports.resolver.resolve(t.clusterId);
        status = await argoReader.watchApplicationSet(argoNamespace, t.watchNames, pruned, { timeoutMs: ports.argoWatchTimeoutMs, signal: ctx.signal, labelSelector: tenantSelector(t.guid) });
      } catch (err) {
        throw errValidation(`could not confirm the fan-out of ${settled} ${t.guid} is gone (${err instanceof Error ? err.message : String(err)}) — ${unsettled}`);
      }
      if (!pruned(status)) {
        throw errValidation(`${settled} ${t.guid} fan-out is STILL not pruned after the cluster-side deletes — ${lingering(status)}; ${unsettled}`);
      }
      ctx.checkpoint({ pruned: true }); // the fact the row flip below rests on
      ctx.log("meta", `${settled} ${t.guid} fan-out confirmed gone (${t.watchNames.length} Application(s)) — the row may be settled`);
    },
  };
}

/** The teardown steps for ONE tenant, in the order the symmetry-inverse of create-tenant demands:
 *  git-rm the registration, wait for ArgoCD to prune the whole fan-out, delete every member's isolation
 *  AppProject, run the composing run's `cascade`, then record the removal in the inventory —
 *  settling the rows to the flavour's own terminal status (opts.settledStatus: "offboarded" for the
 *  pointer-only flavours, "purged" for tenant-purge), the row itself kept either way (never
 *  deleted). A FAIL-SOFT flavour gets one more step between the cascade and the record: the settle guard
 *  (settlePruneGuardStep), which is where its tolerated "not pruned" observation is finally made to
 *  answer for itself.
 *
 *  `cascade` is where a composing run puts its OWN destructive cluster-side work: tenant-purge's Tenant
 *  CR delete (the operator's deprovision cascade — Vault path, object-storage credential, Mongo
 *  databases) and its namespace backstop reap. The two pointer-only flavours (REPLACE_TEARDOWN,
 *  create-tenant's ABORT_TEARDOWN) pass [] and that is not a stub: they issue no cluster-side delete of
 *  their own, so the tenant's identity (namespaces, Tenant CR, Vault path) stands for a re-onboard.
 *  The prune every flavour waits for is itself destructive one level down — it deletes each member's
 *  ServiceClaim and the service-provisioner drops the claim's databases with its user — so no flavour
 *  keeps the member data, and each composing run's operator text states that.
 *
 *  It is a PARAMETER — threaded THROUGH this builder — rather than something the caller appends after
 *  the returned list, and that is the load-bearing detail: the record step MUST be the LAST step of the
 *  whole removal. It flips the tenants + tenant_apps rows to the flavour's terminal status, and a row that
 *  claims a removal happened while the Tenant CR, the namespace, the Vault path and the Mongo databases
 *  are still standing is exactly the settled-but-unfinished lie the removal run kinds exist to end: a
 *  settled row drops off the Tenants page's card list, its detail page offers no live action, and the
 *  pointer the FIRST step already git-rm'd keeps the orphan scan blind — so a delete that failed after the
 *  flip leaves a live tenant nothing in the product can name again. Owning the placement here makes that
 *  ordering structural instead of a convention every composing run has to remember, and it mirrors
 *  create-tenant's own rule in the opposite direction: record-provisional records INTENT before the first
 *  mutation, record-inventory records SUCCESS only after the work is done. */
export function tenantTeardownSteps(ports: TenantLifecyclePorts, t: TenantTeardownTarget, opts: TenantTeardownOpts, cascade: Step[]): Step[] {
  const pfx = `${opts.stepPrefix}-${t.guid}`;
  const { title, removing, settled } = opts.wording;
  return [
    {
      name: `${pfx}-remove`,
      title: `${title} ${t.guid}: remove its pointer (GitOps un-deploy)`,
      run: async (ctx) => {
        // removeTenant refuses an already-absent tenant.yaml (VALIDATION) — on a resume (the removal
        // already committed) skip instead of throwing, mirroring offboardSteps' remove-tenant. For an
        // ORPHAN that died BEFORE write-pointer the absent pointer is the normal case, not an error.
        // ABSENT is the only state that skips: the tolerant scan also reports "unreadable" (a tenant.yaml
        // DOES stand, its body cannot be trusted), and that pointer must still be git-rm'd — by path,
        // which is all removeTenant ever needs. The strict readTenant would instead THROW on it.
        //
        // The relocation mark goes FIRST, on every member namespace the frozen target names, and before
        // the absent-pointer skip: each member chart renders its own ServiceClaim, the prune this
        // removal sets off hands those claims to the teardown the mark disarms, and a purge reaps a
        // tenant whose pointer is already gone the same way.
        const { clusterReader } = await ports.resolver.resolve(t.clusterId);
        await clearRelocationHold(ctx, clusterReader, t.members.map((m) => memberNamespace(t.guid, m)), t.guid);
        if ((await ports.registry.scanTenant(t.stage, t.guid)).status === "absent") {
          ctx.log("meta", `${settled} ${t.guid} pointer already removed — skipping (resume)`);
          return;
        }
        const { commit } = await ports.registry.removeTenant(t.stage, t.guid, ctx.runId);
        ctx.checkpoint({ commit });
        ctx.log("meta", `${removing} ${t.guid} (subdomain "${t.subdomain}") — pointer removed (${commit}); the master ArgoCD will now prune its fan-out`);
      },
    },
    {
      name: `${pfx}-watch-prune`,
      title: `${title} ${t.guid}: wait for ArgoCD to prune its fan-out`,
      run: async (ctx) => {
        // watchNames is frozen at plan time from the tenant's live pointer UNIONED with its inventory
        // (tenant-replace.ts) — the two sources that can name a deployed fan-out.
        //
        // Under FAIL-LOUD an EMPTY set is refused outright, never treated as a prune: allPruned([]) is
        // vacuously true for any status map, so an empty set would log "fan-out pruned (0
        // Application(s))", delete the member AppProjects while live Applications still reference them,
        // and — for the replace — let the fresh guid deploy onto the public FQDN the old fan-out is
        // still serving, which is the one invariant this policy exists to protect. Every set a fail-loud
        // teardown legitimately carries holds at least the trio (tenantApplicationSet), so an empty
        // one means the resolution proved nothing, not that nothing is deployed. Fail-soft keeps its
        // empty set by design: its cluster-side deletes (Tenant CR + namespace) are the backstop.
        if (opts.prune === "fail-loud" && t.watchNames.length === 0) {
          throw errValidation(
            `${settled} ${t.guid} resolved to an EMPTY fan-out watch set — neither its pointer nor an inventory row named a single Application, so nothing can be proven pruned; refusing to continue (tenant-purge reaps a tenant's cluster footprint by guid instead)`,
          );
        }
        const pruned = allPruned(t.watchNames);
        let status: ArgoAppStatusMap;
        try {
          const { argoReader, argoNamespace } = await ports.resolver.resolve(t.clusterId);
          status = await argoReader.watchApplicationSet(argoNamespace, t.watchNames, pruned, { timeoutMs: ports.argoWatchTimeoutMs, signal: ctx.signal, labelSelector: tenantSelector(t.guid) });
        } catch (err) {
          // A READ failure (ArgoCD unreachable) stays fatal under fail-loud — that run must not
          // continue blind. Under fail-soft it is only observed, because the cluster-side deletes that
          // follow reap the tenant regardless (purge.run.ts's watch-removal makes the same call).
          if (opts.prune === "fail-loud") throw err;
          const why = err instanceof Error ? err.message : String(err);
          ctx.checkpoint({ pruned: false, watchError: why });
          ctx.log("meta", `could not confirm the fan-out prune of ${settled} ${t.guid} (${why}) — continuing`);
          return;
        }
        if (pruned(status)) {
          ctx.log("meta", `${settled} ${t.guid} fan-out pruned (${t.watchNames.length} Application(s))`);
          return;
        }
        const stuck = `${settled} ${t.guid} fan-out was not pruned — ${lingering(status)}; its pointer is removed but workloads linger`;
        if (opts.prune === "fail-loud") throw errValidation(stuck);
        ctx.checkpoint({ pruned: false });
        ctx.log("meta", `${stuck} — continuing`);
      },
    },
    {
      name: `${pfx}-delete-projects`,
      title: `${title} ${t.guid}: delete every member's isolation AppProject, admission policy and the argo-sync grant`,
      run: async (ctx) => {
        // ONE AppProject per member, so a teardown deletes them ALL — a project left standing would
        // outlive the tenant it fenced and would then be found by a re-onboard of the same guid.
        // Beside each project, the member's admission policy on the TARGET cluster (cluster-scoped,
        // so no ArgoCD prune ever reaps it): applied wherever the member project is applied, deleted
        // wherever it is deleted, or a policy named after a gone tenant would keep refusing a later
        // re-onboard's managed namespace under a fresh Application name.
        // Idempotent: an already-absent project or policy resolves deleted:false (a re-run / the orphan case).
        const { projectWriter, clusterReader, argoNamespace } = await ports.resolver.resolve(t.clusterId);
        const names = t.members.map((m) => memberAppProject(t.guid, m));
        let deleted = 0;
        let policiesDeleted = 0;
        for (const member of t.members) {
          if ((await projectWriter.deleteAppProject(argoNamespace, memberAppProject(t.guid, member))).deleted) deleted++;
          if ((await clusterReader.deleteAdmissionPolicy(tenantMemberAdmissionPolicyName(t.guid, member))).deleted) policiesDeleted++;
        }
        // The tenant's argo-sync grant lives in the same namespace and goes the same way: it names
        // Application names, and a Role naming this guid's Applications must not outlive the guid.
        // The delete matches on the object names, so the grant is rendered here with no subject.
        const removed = await deleteTenantArgoSync(ports, t.guid, argoNamespace);
        ctx.checkpoint({ appProjects: names, deleted, admissionPoliciesDeleted: policiesDeleted, argoSyncDeleted: removed });
        ctx.log(
          "meta",
          `${settled} ${t.guid}: ${deleted} of ${names.length} member AppProject(s) and ${policiesDeleted} admission polic${policiesDeleted === 1 ? "y" : "ies"} deleted, the rest were already absent; argo-sync grant ${removed ? "deleted" : "already absent"}`,
        );
      },
    },
    // The composing run's destructive cluster-side work, BEFORE the row is settled — see the header.
    ...cascade,
    // The SETTLE GUARD, fail-soft only (see the header): prove the fan-out is gone before the row may
    // claim the tenant is. Under fail-loud there is nothing to guard — the watch above already THREW on
    // a fan-out that did not prune, so reaching the record step is itself the proof, and a second read
    // would only cost every create-tenant replace an extra ArgoCD list on its happy path.
    ...(opts.prune === "fail-soft" ? [settlePruneGuardStep(ports, t, opts)] : []),
    {
      name: `${pfx}-record`,
      title: `${title} ${t.guid}: record it ${opts.settledStatus}`,
      run: async (ctx) => {
        // ALWAYS LAST — the builder places `cascade` above it so no composing run can settle the row
        // while its own cluster-side deletes are still ahead of it (see the header).
        //
        // WHICH row this teardown settles. `t.tenantId` is what the PLAN froze; null means the plan
        // found none — but a row can appear BETWEEN plan and execute, and create-tenant's own abort
        // teardown is exactly that case: its record-provisional step mints the row id at execute time,
        // so no frozen params could ever carry it. Fall back to the (clusterId, guid) unique key, which
        // IS the tenant's identity, so the frozen id is a fast path and never the only path.
        //
        // ORPHAN TOLERANCE: when NEITHER finds a row the tenant was never
        // inventoried — SOFT-SKIP the flip, don't fail; the cluster + GitOps footprint was already torn
        // down by guid, so there is simply nothing to mark. That soft-skip is the ONE behaviour a
        // terminal-status change must not disturb: a purge exists to reap a tenant with no row at all.
        //
        // The row is read WITH ITS CURRENT STATUS, because the flip below is not unconditional: what a
        // row already records decides both whether it may be written and what this step logs.
        const row =
          (t.tenantId === null ? null : ctx.db.select({ id: tenants.id, status: tenants.status }).from(tenants).where(eq(tenants.id, t.tenantId)).get() ?? null) ??
          ctx.db.select({ id: tenants.id, status: tenants.status }).from(tenants).where(and(eq(tenants.clusterId, t.clusterId), eq(tenants.guid, t.guid))).get() ??
          null;
        if (row === null) {
          ctx.log("meta", `${settled} ${t.guid} had no inventory row — nothing to record (orphan)`);
          return;
        }
        // An inventoried tenant flips its row + every app row of its matrix (a PROVISIONING app row
        // counts: a half-created tenant's matrix is just as deployed as a live one) to this flavour's
        // terminal status — soft state either way, the row is kept for the history and, after an
        // offboard, for a future re-onboard.
        //
        // EXCEPT what is already settled at least this deeply (atLeastAsSettledAs, shared/enums.ts —
        // where the whole rule and both defects it closes are stated). Two things ride on that one filter,
        // and it is spread over BOTH writes because they are two independent facts about two different
        // rows: this teardown may not DOWNGRADE a tenant a purge already deprovisioned (an abort or a
        // replace settling "offboarded" over "purged" re-advertises a removal that already ran), and it
        // may not restamp an equally-settled app row a remove-app took out earlier with a run id that did
        // not remove it — while a purge following the prescribed offboard-then-purge order MUST still
        // deepen those "offboarded" app rows to "purged", because its cascade deleted the Tenant CR and
        // the namespace they were.
        const status = opts.settledStatus;
        const keep = atLeastAsSettledAs(status);
        localTx(ctx, (tx) => {
          tx.update(tenantApps).set({ status, lastRunId: ctx.runId }).where(and(eq(tenantApps.tenantId, row.id), notInArray(tenantApps.status, keep))).run();
          tx.update(tenants).set({ status, lastRunId: ctx.runId, updatedAt: new Date() }).where(and(eq(tenants.id, row.id), notInArray(tenants.status, keep))).run();
        });
        // WHICH sentence the run log gets is decided from the status read above, while the WHERE clause
        // is what actually holds — better-sqlite3 is synchronous and there is no await between the read
        // and the transaction, so the two cannot observe different rows. A teardown that found the row
        // already settled this deeply must SAY so: reporting "recorded as offboarded" over a row that
        // kept its "purged" would be the same false statement one layer down. It speaks about the TENANT
        // row alone, which is what it read — the app rows are judged one by one by the same filter.
        ctx.log(
          "meta",
          keep.includes(row.status)
            ? `${settled} ${t.guid} is already recorded ${row.status}, a removal at least as complete as ${status} — leaving that row and the run id that settled it untouched; this teardown took nothing down it does not already account for`
            : `${settled} ${t.guid} recorded as ${status} (row kept)`,
        );
      },
    },
  ];
}
