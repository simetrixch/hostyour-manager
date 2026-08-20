// The create-tenant ROLLBACK — everything abort-with-cleanup needs from this run:
// what its compensations ARE, and whether they may run at all. Split out of create-tenant.run.ts exactly
// as create-tenant-activate.ts was (and onboard-activate.ts out of onboard.run.ts) so that file stays
// under its line budget and this one concern is a single, testable unit.
//
// The two halves belong together because the second is a statement about the first: the compensations
// are the SHARED teardown, i.e. a full GitOps un-deploy of the tenant this run created, so the question
// "may this run be aborted" is really "is that tenant still deployed and serving". Keeping the refusal
// beside the teardown it describes is what lets the refusal message name the teardown step by step.
import type { Cleanup } from "../../executor/types.ts";
import type { Db } from "../../db/client.ts";
import { assertTenantNotLive, type TenantLiveRefusal } from "./tenant-live-guard.ts";
import { tenantTeardownSteps, type TenantTeardownOpts, type TenantTeardownTarget } from "./tenant-teardown.ts";
// Type-only, so there is no runtime import cycle back into create-tenant.run.ts — the same shape
// create-tenant-activate.ts has.
import type { TenantOnboardPorts, CreateTenantParams } from "./create-tenant.run.ts";

/** The create-tenant ABORT flavour of the shared teardown: the compensating inverse of everything this
 *  run deploys. FAIL-LOUD, exactly like tenant-offboard and for its reason — an abort deletes no Tenant
 *  CR and no namespace, so there is NO cluster-side backstop here. A fan-out that refuses to prune must
 *  FAIL the cleanup visibly rather than delete the isolation AppProject and record the tenant offboarded
 *  while its workloads keep serving the public FQDN; the operator's next move is then tenant-purge, which
 *  is the one destructive run kind. (Contrast PURGE_TEARDOWN, which is fail-soft precisely because its
 *  cluster-side deletes are that backstop.) */
const ABORT_TEARDOWN: TenantTeardownOpts = {
  stepPrefix: "abort",
  prune: "fail-loud",
  wording: { title: "Roll back", removing: "rolling back tenant", settled: "rolled-back tenant" },
  // "offboarded", never "purged": an abort issues no cluster-side delete of its own, so the
  // rolled-back tenant's namespaces and Vault crypto entry all still
  // stand — a purge is still the run kind that reaps them, which is exactly what an "offboarded" row goes
  // on offering. The member DATABASES do NOT survive the rollback: the prune it waits for deletes
  // every member's ServiceClaim, and the service-provisioner drops a claim's databases together with
  // its user on any claim deletion, prune included.
  settledStatus: "offboarded",
};

/** How this run's ABORT names itself in the shared live-tenant refusal (tenant-live-guard.ts). The
 *  teardown above is the exact thing an abort would run, so the sentence the operator reads IS that
 *  teardown, step by step — never a vague "not allowed". */
const ABORT_LIVE_REFUSAL: TenantLiveRefusal = {
  subject: "the abort",
  consequence:
    "aborting this create-tenant run would run its rollback: git-rm the tenant's registration, wait for ArgoCD to prune its whole fan-out," +
    " delete every member's isolation AppProject, its admission policy and the argo-sync grant, and record the tenant offboarded — un-deploying a tenant that is serving.",
  instead:
    "offboard the tenant instead — that is the removal run kind for a tenant that is serving. It keeps the tenant's IDENTITY (its Vault crypto entry, its namespaces) for a re-onboard," +
    " but its member DATABASES are dropped with the prune's ServiceClaim deletions, so run a backup first if the data has to come back." +
    " This run has nothing left to roll back; delete the run once you no longer need its log.",
};

/** The teardown target for THIS run's OWN tenant. Everything the shared steps need is already frozen in
 *  the params: the guid/subdomain/stage/clusterId/cluster identity, plus `expectedApps` — the fan-out
 *  set watch-sync-set waits for, which is exactly the set the compensation must wait for the prune of —
 *  and the members apply-appprojects created one project each for, which is exactly the set it must
 *  delete again. tenantId is null and that is NOT a gap: record-provisional mints the row id at EXECUTE
 *  time, so no frozen params could carry it, and the teardown's record step resolves the row by
 *  (clusterId, guid) — the tenant's unique key — whenever the target carries no id. */
function abortTeardownTarget(p: CreateTenantParams): TenantTeardownTarget {
  return {
    guid: p.guid,
    subdomain: p.subdomain,
    stage: p.stage,
    clusterId: p.clusterId,
    cluster: p.cluster,
    tenantId: null,
    watchNames: p.expectedApps,
    members: p.members.map((m) => m.name),
  };
}

/** This run's compensating actions — the SHARED teardown (tenant-teardown.ts), never a private pair.
 *  A teardown Step and a Cleanup are the same {name, title, run} shape, so the abort path executes
 *  LITERALLY the same code tenant-offboard, the replace and tenant-purge execute. Two defects of the
 *  hand-rolled pair this replaces disappear with it: it deleted the isolation AppProject WITHOUT ever
 *  waiting for the fan-out to prune (so the project went while the Applications still stood), and it
 *  wrapped every call in a bare `catch {}` — a compensation that failed reported success. abortWithCleanup
 *  resolves the persisted cleanup names against this function, so it MUST build the same names the
 *  registration in record-provisional builds: both call exactly this one function. */
export function createTenantCleanups(ports: TenantOnboardPorts, p: CreateTenantParams): Cleanup[] {
  // Empty `cascade`: an abort deletes NO cluster state (see ABORT_TEARDOWN) — the row flip is the last
  // thing it does because there is nothing after it to do.
  return tenantTeardownSteps(ports, abortTeardownTarget(p), ABORT_TEARDOWN, []);
}

/** The abort's PRECONDITION (RunDefinition.assertAbortable): the cleanups above are a
 *  full un-deploy of whatever this run put on the cluster, so a FAILED create-tenant run standing behind
 *  a tenant that is LIVE must not be aborted. Nothing about the run's own status can tell the two apart —
 *  `activate` (the first-admin invite) is deliberately the LAST step, so a run that failed there sits
 *  behind a tenant record-inventory already settled "active" and that is serving. Only the tenants row +
 *  the GitOps pointer can, which is exactly the shared live-tenant rule the destructive tenant-purge is
 *  refused by (tenant-live-guard.ts) — one rule, asked from every end that can reach such a tenant.
 *
 *  Asking it on the DEFINITION is what makes the refusal hold for every caller of the abort. The run
 *  screen hides the button on a live tenant, but its tenant-state read is keyed on the run and the run's
 *  SSE stream closes when the run settles, so a tab parked on the failed run never learns the tenant went
 *  live in another tab. A hidden button is a convenience, not a guard. */
export function assertCreateTenantAbortable(ports: TenantOnboardPorts, p: CreateTenantParams, db: Db): Promise<void> {
  return assertTenantNotLive(db, ports.registry, p, ABORT_LIVE_REFUSAL);
}
