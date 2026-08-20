import { z } from "zod";
import { and, eq } from "drizzle-orm";
import type { RunDefinition, Step, Plan } from "../../executor/types.ts";
import type { Db } from "../../db/client.ts";
import { clusters, tenants } from "../../db/schema/inventory.ts";
import { AppError, errNotFound, errValidation } from "../../kernel/errors.ts";
import { STAGE, type Stage } from "../../../shared/enums.ts";
import type { TenantPurgeInput } from "../../../shared/api-types.ts";
import { guid as guidSchema } from "../../../shared/tenant.ts";
import { assertDeployState, type TenantLifecyclePorts } from "./lifecycle.ts";
import { assertTenantNotLive, type TenantLiveRefusal } from "./tenant-live-guard.ts";
import { memberNamespace } from "./tenant-fanout.ts";
import { CLAIM_RELOCATING_ANNOTATION } from "../../adapters/kube/port.ts";
import { tenantLocks, tenantSelector } from "./tenant-lifecycle.run.ts";
import { resolveTeardownTarget } from "./tenant-replace.ts";
import { tenantTeardownSteps, TenantTeardownTargetSchema, type TenantTeardownOpts, type TenantTeardownTarget } from "./tenant-teardown.ts";
import { clusterShortName } from "../inventory/cluster-marking.ts";
import { removeUnitDns, tenantWildcardHost } from "./unit-dns.ts";

// tenant-purge / force-offboard by GUID — the tenant analogue of the consumer
// purge.run.ts, and the ONLY run kind that can name an ORPHAN: a tenant that exists in GitOps + ArgoCD
// (registration, fan-out, member AppProjects, member namespaces, Vault crypto entry, Mongo
// databases) with NO inventory row, which EVERY other removal run kind (tenant-offboard / -suspend /
// remove-app) structurally
// cannot address because they resolve their target BY that row (lifecycle.ts loadTenantCluster throws
// NOT_FOUND). create-tenant's record-provisional step stops NEW orphans at the source, but the ones
// already out there — plus a run that died before that first step, and hand-written pointers — still
// need a run kind that needs no row. tenant-purge removes a tenant's WHOLE footprint BY GUID: the guid is
// the sole tenant identity — every member namespace and AppProject is <guid>-<member> and the Vault
// entry is the bare guid (tenant-crypto-mint.ts) — and every member namespace additionally carries the label
// platform/tenant=<guid>, so the whole footprint is nameable from guid+stage+cluster alone. It is a
// SUPERSET of tenant-offboard: every step reaps only what
// is still there, so it also runs to completion on a tenant that is fully deployed — which is what makes
// it the ONE reliable removal path (the property the consumer purge gives consumers). "Runs to
// completion" is NOT "is harmless": on a deployed tenant it deprovisions that tenant. A purge aimed at a
// tenant the inventory still calls live AND whose GitOps pointer still stands is therefore refused by the
// shared live-tenant rule (tenant-live-guard.ts) at BOTH ends: on the route before a Run exists (api.ts),
// and again in attest-target below when that Run is approved — because a plan-time refusal alone does not
// hold (approve re-validates nothing, so a purge planned against a "provisioning" row stays approvable
// after a create-tenant retry settles that row to "active"). Offboard is the removal run kind for a tenant
// that is still serving, and it keeps the tenant's data. What NEITHER end can refuse is a live tenant with
// NO row (an orphan from before record-provisional, or a hand-written pointer), so the plan summary states
// the destructive outcome plainly rather than reassuring: that summary is the only remaining gate.
//
// DESIGN — a distinct RUN_KIND, NOT a force-mode on tenant-offboard, because the two ADDRESS a target
// differently and that difference is the whole point:
//   - tenant-offboard is ROW-driven: params { tenantId }, loadTenantCluster resolves guid/stage/cluster,
//     targetKind "tenant". An orphan has NO row ⇒ no tenantId ⇒ it structurally cannot name the tenant.
//   - tenant-purge is GUID-driven: the operator supplies { guid, stage, clusterId } and the identity is
//     derived from the clusters row + the guid, targetKind "cluster" (like create-tenant's plan, whose
//     tenant row does not exist yet either). No inventory row is required at any point.
// Keeping them separate leaves tenant-offboard's strict, row-anchored contract untouched and gives purge
// its own honest plan summary + UI entry.
//
// It PLANS THROUGH planStream (like create-tenant / add-app), not the synchronous plan() path the
// consumer purge uses, for ONE structural reason: the pointer-side steps are the SHARED teardown
// (tenant-teardown.ts), which is built from a complete TenantTeardownTarget — and that target's
// `watchNames` (the fan-out Applications to wait for the prune of) can only be read off the LIVE
// registration, which the FIRST teardown step git-rm's. steps() is synchronous and has no db/registry
// access, so the target MUST be resolved (resolveTeardownTarget) and FROZEN into params before the run
// starts — exactly as create-tenant freezes its `replaces`. The consumer purge needs no such freeze
// because a consumer's ONE Application name is derivable from name+stage (consumerArgoAppName), while a
// tenant's fan-out set depends on the registration's apps[].
//
// The teardown runs in FAIL-SOFT mode: an orphan is precisely the half-created / crash-looping tenant
// whose fan-out never reaches a clean Missing, and blocking on it would strand exactly the tenant this
// run exists to reap. The cluster-side deletes that FOLLOW are the backstop, and they are what makes
// purge destructive where tenant-offboard is not. Fail-soft governs whether the run PROCEEDS, never what
// it RECORDS: the teardown's settle guard re-reads the fan-out after those deletes and fails the run —
// leaving the row exactly as it was, and the run retryable — rather than let the record step settle a
// tenant over workloads it can still see (tenant-teardown.ts, settlePruneGuardStep):
//
// THE DEPROVISION — two steps, one per thing that outlives the pointer, and each destroyed by whoever
// created it. delete-namespaces reaps every member namespace, which takes its ServiceClaims with it and
// therefore its member DATABASES: the service-provisioner's own finalizer drops a claim's databases
// together with its user, however the claim dies. delete-tenant-crypto destroys the tenant's Vault
// entry <stage>/tenants/<guid> through the SAME seeder create-tenant wrote it with — a metadata delete,
// all versions, so a tenant minted later with this guid can never inherit the purged one's signing key.
// It used to be ONE delete: a cluster-scoped Tenant CR carried a finalizer that a reconciler released
// only once all of that was gone, so deleting the CR WAS the cascade. That reconciler is parked and no
// controller serves the CR, so what remained of the design was a step verifying a cascade nobody ran —
// it refused every time and no tenant could reach "purged". The CR and both of its steps are gone.
// THE OBJECT-STORAGE BUCKET AND ITS DATA ARE DELIBERATELY KEPT — the plan SUMMARY says so plainly, and
// so does the purge dialog the operator confirms in, because someone approving a "purge" must not
// believe the tenant's stored objects went with it. It is deliberately NOT also stated as a
// Plan.warning: that field reaches nobody — the executor's read path projects no `warnings` onto
// RunView (read.ts toRunView) and RunView has no such member (shared/api-types.ts), so a warning string
// is frozen into plan_json and rendered on no screen.
// tenant-offboard and the replace do NEITHER — they un-deploy a tenant and KEEP its cluster state
// (soft state, re-onboardable); tenant-purge is the one destructive run kind.
//
// ISSUED IS NOT DONE, and that distinction is what the settle guard above carries. Deleting a namespace
// is non-blocking: the API server accepts it and returns while the namespace sits there with a
// deletionTimestamp, its ServiceClaims still finalizing and their databases still standing. So the
// record step does not settle on having ISSUED the deletes — the settle guard re-reads the fan-out
// afterwards and fails the run when anything is still visible.
//
// The alternative was to record on issue and soften every sentence about "purged" to say the cascade was
// merely REQUESTED. It was rejected for one reason: nothing would ever come back to check. A row
// recorded "purged" over databases that are still there drops off the Tenants page, offers no further
// removal, and cannot be found by the orphan scan either — the pointer went with this run's first step.
// That is a stranded deprovision with no surface anywhere, created by the very run kind that exists to end
// that state. Failing the guard keeps the row unsettled, the tenant listed and the run retryable exactly
// where it stopped.
//
// RECORD — a completed purge settles its rows to "purged", NOT to "offboarded".
// This is the ONE teardown flavour that does (PURGE_TEARDOWN below carries it as `settledStatus`; the
// pointer-only flavours keep "offboarded"), and the reason is that the two states say OPPOSITE things
// about what is still out there. offboarded = un-deployed with the cluster state deliberately KEPT — the
// namespace, the Vault crypto entry and the Mongo databases all
// stand, which is exactly why a purge is offered on such a row. After a purge NONE of that is left, so
// there is nothing to reap and nothing to offer. Settling both to the one literal made a finished purge
// INVISIBLE: the tenant stayed on the Tenants page's "Offboarded tenants" panel and went on advertising
// the purge it had just completed, so the most destructive run kind in the product appeared to do nothing and
// could be re-triggered forever with no visible effect. Purged rows leave the Tenants list altogether
// (web tenantRows.ts) while the row itself is KEPT as the trace (never deleted) and its detail page
// still tells the whole truth by URL. Two consequences ride along and are stated where they hold: a purged
// row must never be picked up as a create-tenant REPLACE target and must not count as "known" to the
// orphan scan (tenant-replace.ts, tenant-orphans.ts — both ask shared/enums.ts TENANT_SETTLED_STATUS), and
// a RE-purge stays fully ALLOWED by the live-tenant rule (tenant-live-guard.ts) because every step of this
// run reaps only what is still there — it is simply no longer advertised on a row with nothing left.
//
// ORDER — the two deletes are the teardown's `cascade`, so they run BEFORE its record step, not after
// it. The record step flips the tenants + tenant_apps rows to that terminal status, and the flip must be
// the LAST thing the purge does: a run that recorded the tenant settled and THEN failed its namespace
// delete would leave the CR, the namespace, the Vault path, the object-storage credential and the Mongo
// databases standing behind a row that says the tenant is gone — and a settled row is off the Tenants
// list, has no removal on its detail page, and cannot be found by the orphan scan either (the first
// teardown step already git-rm'd its pointer). That is precisely the settled-but-unfinished state
// the removal run kinds exist to end, so it must not be re-created at the tail of the removal run kind — and a
// row settled "purged" is the sharper form of it, since that status states the deprovision as fact. With
// the cascade inside, a failed delete leaves the row exactly as it was: the tenant stays visible and its
// failed run retries from the step that failed.

/** The operator's request — the SAME three fields the consumer purge takes, keyed on the guid instead
 *  of the consumer name. No inventory row is named anywhere: an orphan has none.
 *
 *  `satisfies z.ZodType<TenantPurgeInput>` pins this schema to the ONE declaration of the wire body the
 *  browser posts (shared/api-types.ts TenantPurgeInput). The two are not redundant and neither replaces
 *  the other: the shared type carries the SHAPE both ends compile against, this schema carries the
 *  VALIDATION a wire type cannot express (the guid alphabet, the cls_ id prefix). The check is what makes
 *  them one contract instead of two — a field renamed or dropped on either side fails at this line. */
export const TenantPurgeRequest = z.object({
  guid: guidSchema, // the sole tenant identity: namespace == AppProject == pointer dir == <guid>
  stage: z.enum(STAGE),
  clusterId: z.string().startsWith("cls_"),
}) satisfies z.ZodType<TenantPurgeInput>;
export type TenantPurgeRequest = z.infer<typeof TenantPurgeRequest>;

/** The FROZEN params: the request PLUS the teardown target the plan resolved (resolveTeardownTarget,
 *  tenant-replace.ts). `target` carries what only a plan-time read can know — the tenant's subdomain, its
 *  ArgoCD-registered slave name, its inventory row id (null for an ORPHAN) and the fan-out watchNames
 *  read off the LIVE pointer BEFORE the teardown removes it — so steps() rebuilds the SAME steps at
 *  execute and at resume. Required, never optional: a purge that could run without a frozen target would
 *  silently wait on an EMPTY fan-out and report it pruned. */
export const TenantPurgeParams = TenantPurgeRequest.extend({ target: TenantTeardownTargetSchema });
export type TenantPurgeParams = z.infer<typeof TenantPurgeParams>;

/** The tenant-purge teardown flavour: FAIL-SOFT, because the cluster-side deletes below reap the tenant
 *  even when its fan-out never prunes cleanly — contrast REPLACE_TEARDOWN, which MUST fail loud
 *  rather than let a fresh guid deploy onto a public FQDN the old fan-out is still serving.
 *
 *  It is also the ONE flavour that settles its rows to "purged" rather than "offboarded"
 * — see the RECORD paragraph in the header for what that state buys. */
export const PURGE_TEARDOWN: TenantTeardownOpts = {
  stepPrefix: "purge",
  prune: "fail-soft",
  wording: { title: "Purge", removing: "purging tenant", settled: "purged tenant" },
  settledStatus: "purged",
};

/** How a tenant-purge NAMES ITSELF in the shared live-tenant refusal (tenant-live-guard.ts). Built HERE,
 *  from the run kind that owns the consequence, and handed to BOTH ends of that rule — the route's plan-time
 *  refusal (api.ts) and the attest-target belt below — so an operator reads the identical sentence
 *  whichever end refuses, and neither end can describe the destruction differently from the other. */
export function purgeLiveRefusal(t: TenantPurgeRequest): TenantLiveRefusal {
  return {
    subject: "the purge",
    consequence:
      `tenant-purge destroys its Vault crypto entry ${t.stage}/tenants/${t.guid} — its JWT signing keypair, its TOTP key,` +
      " its bootstrap token and its engine key, every version — and reaps its member namespaces, which drops its Mongo databases with their ServiceClaims. None of it is recoverable.",
    instead:
      "offboard the tenant first (that removal keeps the tenant's identity, so it can be re-onboarded — but back it up first: pruning the fan-out deletes every member's ServiceClaim and the service-provisioner drops that claim's databases with it), then purge whatever the offboard leaves behind.",
  };
}

/** Whether the inventory knows this tenant at all. `assertTenantNotLive` answers from the SAME row and
 *  returns silently when it is absent — which is right for it, because a missing row is not a state.
 *  attest-target asks the question separately so it can send an uninventoried target to the cluster
 *  instead, where "orphan" and "still serving" ARE distinguishable. */
function hasInventoryRow(db: Db, p: { guid: string; stage: Stage }): boolean {
  return db.select({ guid: tenants.guid }).from(tenants).where(and(eq(tenants.guid, p.guid), eq(tenants.stage, p.stage))).get() !== undefined;
}

/** The target cluster's own coordinates, derived from the clusters row + the guid ALONE — no tenants row
 *  required (that is the entire point). The cluster row is the authority for the domain and for the
 *  cluster's short name (clusterShortName); the REQUESTED stage is cross-checked against the
 *  cluster's own stage (a cluster is exactly one stage) so a mistyped stage fails closed instead of
 *  pointing the teardown at the wrong pointer path. */
interface TenantPurgeCluster {
  guid: string;
  domain: string;
  stage: Stage;
  clusterId: string;
  cluster: string; // the cluster short name — what the pointer's `cluster` field names
}

function loadPurgeCluster(db: Db, p: TenantPurgeRequest): TenantPurgeCluster {
  const row = db
    .select({ id: clusters.id, domain: clusters.domain, stage: clusters.stage })
    .from(clusters)
    .where(eq(clusters.id, p.clusterId))
    .get();
  if (!row) throw errNotFound(`cluster ${p.clusterId}`);
  if (row.stage !== p.stage) {
    throw errValidation(`stage mismatch: cluster ${p.clusterId} is ${row.stage}, tenant-purge targets ${p.stage}`);
  }
  // Cluster STATUS is deliberately not checked: leftovers on a cluster that is no longer active are
  // exactly what this run kind is for.
  return { guid: p.guid, domain: row.domain, stage: row.stage, clusterId: row.id, cluster: clusterShortName(row.domain) };
}

/** The teardown target for a guid NEITHER source knows — no tenants row AND no live registration (a
 *  create-tenant that died BEFORE write-registration, or an earlier purge that removed the registration
 *  and then failed). resolveTeardownTarget returns null there, but the CLUSTER footprint can still
 *  stand: every member namespace and AppProject is named <guid>-<member> and the Vault entry is named by
 *  the guid ALONE, so the purge still reaps them. Nothing to git-rm (the remove step skips an absent
 *  registration) and no fan-out to wait for (watchNames []).
 *
 *  `members` is EMPTY, because nothing here knows them. It used to be a hardcoded trio, which was only
 *  ever true of one product's tenants — a purge of a tenant of any other would have named three
 *  members it does not have and missed every one it does. Emptiness is the honest answer and it costs
 *  nothing that matters: the namespace reap asks the CLUSTER by label, which finds every member
 *  namespace including the ones no source names.
 *  The subdomain is likewise unknowable — only the registration or the row carries it — so it is left
 *  empty; remove-dns reads the emptiness as "no record was ever provisioned" (the registration write
 *  follows provision-dns, so a guid neither source knew never got one) and removes nothing. */
function unresolvedTeardownTarget(c: TenantPurgeCluster): TenantTeardownTarget {
  return TenantTeardownTargetSchema.parse({
    guid: c.guid,
    subdomain: "",
    stage: c.stage,
    clusterId: c.clusterId,
    cluster: c.cluster,
    tenantId: null,
    watchNames: [],
    members: [],
  });
}

/** The DESTRUCTIVE half of the purge — the two cluster-side deletes that make it a superset of
 *  tenant-offboard, plus the ONE read that makes the second of them a completed fact rather than a
 *  request. Handed to the shared teardown as its `cascade` (tenant-teardown.ts), which places them
 *  between delete-project and the record step, so the row is only ever settled once ALL THREE have
 *  succeeded (see the ORDER and DEPROVISION paragraphs in the header). Named as their own builder so the
 *  composition reads as what it is: pointer teardown, then deprovision, then record. */
function tenantDeprovisionSteps(ports: TenantLifecyclePorts, p: TenantPurgeParams): Step[] {
  return [
    {
      name: "delete-namespaces",
      title: "Delete every tenant member namespace (backstop reap)",
      run: async (ctx) => {
        // The backstop that makes purge complete even when the fan-out never pruned: deleting a member
        // namespace garbage-collects EVERY namespaced resource in it — its workloads, its
        // ExternalSecrets and the Secrets they materialized, its leftover cert-manager TLS Secrets. It
        // does NOT reach the Vault entry — that is the step below. Runs on the RESOLVED
        // target client (a slave's own reader over its bearer, never master-only). Idempotent +
        // non-blocking: an already-absent namespace resolves deleted:false; a present one is issued the
        // delete without waiting on finalizers (it may sit Terminating).
        //
        // The namespaces come from the CLUSTER, by label, UNIONED with the ones the frozen target's
        // members name. Asking the cluster is what makes the reap complete: a member the inventory and
        // the registration have both forgotten — a remove-app that settled the row while its namespace
        // stood, an orphan whose apps nobody recorded — carries the label and no other source names it.
        // The frozen members are unioned in for the opposite case: a namespace that never got labelled
        // because the tenant died before ArgoCD ever created it is not in the list either, and asking
        // for its deletion costs one idempotent 404.
        const c = loadPurgeCluster(ctx.db, p);
        const { clusterReader } = await ports.resolver.resolve(c.clusterId);
        const labelled = await clusterReader.listNamespaces(tenantSelector(c.guid));
        const namespaces = [...new Set([...labelled, ...p.target.members.map((m) => memberNamespace(c.guid, m))])];
        const issued: string[] = [];
        for (const ns of namespaces) {
          if ((await clusterReader.deleteNamespace(ns)).deleted) issued.push(ns);
        }
        // deleteNamespace returns when the API ACCEPTS the delete, not when the namespace is gone —
        // a finalizer on any namespaced resource in it leaves it Terminating with everything still
        // inside. Reading each one back is what separates "asked" from "gone", so the run states the
        // one it can prove. Three surfaces used to report the namespace as gone on the strength of
        // the accepted delete alone.
        const stuck: string[] = [];
        for (const ns of namespaces) {
          if ((await clusterReader.namespacePhase(ns)) === "terminating") stuck.push(ns);
        }
        ctx.checkpoint({ namespaces, deleted: issued, terminating: stuck });
        ctx.log(
          "meta",
          issued.length
            ? `${issued.length} of ${namespaces.length} tenant namespace(s) deleted on ${c.cluster} (${issued.join(", ")}) — their workloads and materialized secrets go with them`
            : `none of the ${namespaces.length} tenant namespace(s) were still on ${c.cluster} — nothing to delete`,
        );
        if (stuck.length) {
          ctx.log(
            "meta",
            `${stuck.length} namespace(s) accepted the delete but are still TERMINATING on ${c.cluster} (${stuck.join(", ")}) — a finalizer on something inside is holding them, and everything in them is still there. The purge itself is complete; these shells are not, and no later step re-reads them.`,
          );
        }
      },
    },
    {
      name: "delete-tenant-crypto",
      title: "Destroy the tenant's crypto entry in Vault",
      run: async (ctx) => {
        // The inverse of create-tenant's seed-tenant-crypto, and the step that replaced this run's
        // refusal. It used to be a reconciler's finalizer that removed <stage>/tenants/<guid> when the
        // Tenant CR was deleted; that CR is gone, so the entry is destroyed HERE by the
        // same identity that wrote it — a metadata delete, all versions.
        //
        // ALL VERSIONS, not the soft data delete: cas=0 is allowed only where no version information
        // remains, so a soft delete would leave the next tenant minted with this guid unable to be
        // seeded AND silently inheriting the purged tenant's signing key.
        //
        // AFTER the namespaces are gone, so nothing is left running that would read the entry and find
        // it missing — a member pod outliving its keys logs an auth failure that reads like a
        // corruption rather than a purge.
        //
        // Skipped, and SAID, when no seeder is wired: the seeder is what wrote the entry, so a purge
        // running without one has nothing it could take back. That is the one case where a leftover is
        // possible and it is named rather than passed over.
        const c = loadPurgeCluster(ctx.db, p);
        if (!ports.seeder) {
          ctx.log(
            "meta",
            `no Vault seeder is wired, so the crypto entry ${c.stage}/tenants/${c.guid} is NOT destroyed — if this tenant was ever seeded, its JWT signing key, TOTP key, bootstrap token and engine key stand in Vault after this purge and must be removed by hand`,
          );
          return;
        }
        await ports.seeder.deleteTenantCrypto({ stage: c.stage, guid: c.guid });
        ctx.checkpoint({ tenantCrypto: c.guid, deleted: true });
        ctx.log("meta", `crypto entry ${c.stage}/tenants/${c.guid} destroyed (all versions) — the tenant's identity is gone, and a future tenant of this guid gets a fresh one`);
      },
    },
    {
      name: "remove-dns",
      title: "Remove the tenant's public DNS record",
      run: async (ctx) => {
        // The inverse of create-tenant's provision-dns (no address is left pointing nowhere
        // — without exception; purge runs after failed offboards, exactly where the leftover would
        // appear, so the step is fail-CLOSED). The record name needs the subdomain, which only the
        // pointer or the inventory row carries — for a guid NEITHER source knew, the frozen target's
        // subdomain is empty and there is no record to name: such a tenant never reached
        // provision-dns (the pointer write follows it), so nothing stands and the step says so.
        if (p.target.subdomain === "") {
          ctx.log("meta", `tenant ${p.guid} has no known subdomain (neither an inventory row nor a pointer named one) — no DNS record was ever provisioned for it, nothing to remove`);
          return;
        }
        const c = loadPurgeCluster(ctx.db, p);
        const unitApex = await ports.resolveUnitApex(c.domain, c.stage);
        await removeUnitDns(ctx, { dns: ports.dns, unit: p.guid, recordName: tenantWildcardHost(p.target.subdomain, unitApex) });
      },
    },
  ];
}

function tenantPurgeSteps(ports: TenantLifecyclePorts, params: TenantPurgeParams): Step[] {
  const p = params;
  // guards.assertGuardsArmed evaluates def.steps({}) — with no frozen target there is simply no
  // teardown to build, and attest-target still comes first, which is exactly what that check asserts.
  // The two deletes ride INSIDE the teardown (its `cascade`) rather than after it, so the record step
  // stays the last step of the run — the header's ORDER paragraph. With no target there is no removal at
  // all, so they fall away with it.
  const teardown = p.target ? tenantTeardownSteps(ports, p.target, PURGE_TEARDOWN, tenantDeprovisionSteps(ports, p)) : [];
  return [
    {
      name: "attest-target",
      title: "Attest the target cluster (deploy-state fresh)",
      run: async (ctx) => {
        // The ONE fail-closed gate (step 0 of this mutating run): the target cluster must still be a
        // provisioned hostyour cluster whose deploy-state agrees with the cluster row this purge derived
        // its identity from. A force-remove that fired at the wrong cluster would delete a foreign
        // namespace / AppProject / crypto entry, so this refuses BEFORE any deletion. Read on the TARGET
        // cluster's own reader (a slave over its bearer). lifecycle's attestTenantTargetStep is
        // unusable here — it is keyed on a tenantId via loadTenantCluster and an orphan has no row — so
        // this is its guid-driven equivalent, built the way purge.run.ts builds its own.
        const c = loadPurgeCluster(ctx.db, p);
        // Belt: the FROZEN target must name the very cluster the operator is purging on — a tenant whose
        // pointer/row places it on one slave must never be reaped against another's deploy-state. The plan
        // already refused a mismatch; re-checking here keeps a hand-crafted params set from slipping past.
        if (p.target.clusterId !== c.clusterId) {
          throw errValidation(
            `tenant ${p.guid} resolves to cluster ${p.target.clusterId}, tenant-purge targets ${c.clusterId} — refusing to purge on the wrong cluster`,
          );
        }
        // Belt: the LIVE-TENANT refusal the route already made at plan time (api.ts), re-asked HERE
        // against the world as it is NOW. It is the belt that actually holds, because the plan-time
        // refusal answers a question about plan time only: this purge may have been planned — legitimately
        // — against a "provisioning" row, then sat `planned` while a create-tenant retry settled that very
        // row to "active" and the tenant started serving, and Executor.approve re-validates nothing. Same
        // rule, same words, both ends (tenant-live-guard.ts + purgeLiveRefusal) — never a second copy of
        // the logic. It runs BEFORE the deploy-state read for the same reason the clusterId belt does:
        // refuse on the params + the inventory before this run touches the target cluster at all.
        await assertTenantNotLive(ctx.db, ports.registry, p, purgeLiveRefusal(p));
        const { clusterReader } = await ports.resolver.resolve(c.clusterId);
        // A relocating tenant is mid-MOVE: its CR delete is meant as a release, its data is being
        // carried through the staging area, and the box folder is its only complete copy until the
        // move finishes. A purge in that window would reap the member namespaces WITHOUT the release
        // semantics this run intends — destructive where the move needs a hand-off — so it is
        // refused outright while the annotation stands.
        // THE ORPHAN BELT. assertTenantNotLive above answers from the INVENTORY, and an orphan has no
        // row there — that is what this run kind is for. But "no row" and "not running" are two different
        // statements, and the pointer cannot tell them apart either: an orphan whose pointer survived
        // and a live tenant the inventory never learned about look identical in git. The CLUSTER can
        // tell them apart, because a tenant that still serves has workloads that are READY, and an
        // orphan — whose Applications were pruned long ago — has none.
        //
        // So an uninventoried target is smoke-read across its member namespaces first, and a single
        // ready replica refuses the run. Without this, the only thing between the operator and an
        // unrecoverable deprovision of a serving tenant was the prose on the approve card.
        if (!hasInventoryRow(ctx.db, p)) {
          const namespaces = await clusterReader.listNamespaces(`platform/tenant=${c.guid}`);
          for (const ns of namespaces) {
            const running = (await clusterReader.smoke(ns)).workloads.filter((w) => w.ready > 0);
            if (running.length > 0) {
              throw errValidation(
                `tenant ${c.guid} has NO inventory row, but ${running.length} workload(s) in namespace ${ns} on ${c.cluster} are RUNNING (${running.map((w) => `${w.name} ${w.ready}/${w.desired}`).join(", ")}) — this is a serving tenant the inventory never learned about, not an orphan. tenant-purge would reap its namespaces and with them its Mongo databases, and destroy its Vault crypto entry, none of it recoverable. Offboard it first, or scale it down deliberately if it really is dead.`,
              );
            }
          }
        }
        // A move in flight holds this tenant, and purging under it drops the very databases the move
        // is carrying. The mark it sets is CLAIM_RELOCATING_ANNOTATION on every member namespace
        // (relocation-world-tenant.ts, repoint) — the one that makes the service-provisioner KEEP a
        // claim's databases when the repoint prunes the ServiceClaims. This used to read the Tenant
        // CR's own relocating annotation instead; nothing reconciles that CR any more and it is gone,
        // so the guard reads the mark that actually acts. One marked namespace is enough: the repoint
        // sets them together, and a partial set is a move that died mid-repoint, which holds the
        // tenant just as hard.
        for (const memberNs of await clusterReader.listNamespaces(tenantSelector(c.guid))) {
          const annotations = await clusterReader.readNamespaceAnnotations(memberNs);
          if (annotations?.[CLAIM_RELOCATING_ANNOTATION] !== undefined) {
            throw errValidation(
              `tenant ${c.guid} is relocating (namespace ${memberNs} on ${c.cluster} carries ${CLAIM_RELOCATING_ANNOTATION}) — a move holds this tenant and that mark is what keeps its databases, refusing to purge; let the move finish or fail first`,
            );
          }
        }
        const state = assertDeployState(await clusterReader.readDeployState(), c.domain, c.stage, "tenant");
        ctx.log("meta", `target ${c.domain} (${c.stage}) attested for the purge of ${c.guid} — deploy-state generation ${state.generation}`);
      },
    },
    // The pointer-side teardown, shared with the replace: remove the tenant.yaml, best-effort wait for
    // ArgoCD to prune the whole fan-out, delete every member's isolation AppProject, run this
    // run's own deprovision cascade (the two deletes above, then the wait that proves the operator
    // actually finished), verify the fan-out really is gone now that they have fired (the fail-soft settle
    // guard — it fails the run instead of settling a row over surviving workloads), then record the tenant
    // PURGED — which SOFT-SKIPS when the target carries no tenantId (the orphan case: there is no row to
    // settle, and that must never become an error).
    ...teardown,
  ];
}

export function makeTenantPurgeDef(ports: TenantLifecyclePorts): RunDefinition<TenantPurgeParams> {
  return {
    kind: "tenant-purge",
    paramsSchema: TenantPurgeParams,
    mutating: true, // mutating ⇒ steps()[0] MUST be attest-target
    plan: () => {
      // The target must be resolved + frozen before steps() can build the shared teardown (header).
      throw new AppError("INTERNAL", "tenant-purge is planned via planStream (the streaming entrypoint), not plan()");
    },
    planStream: async (rawParams, ctx) => {
      const req = TenantPurgeRequest.parse(rawParams);
      const c = loadPurgeCluster(ctx.db, req);
      // Resolve the ONE teardown target for this guid through the SINGLE resolution path
      // (tenant-replace.ts): the inventory row while the tenant is still live, else purely from its live
      // tenant.yaml (the ORPHAN case), else null — neither source knows it, and the cluster footprint is
      // then reaped by guid alone (unresolvedTeardownTarget).
      const resolved = await resolveTeardownTarget({ db: ctx.db, registry: ports.registry }, req.stage, req.guid);
      if (resolved && resolved.clusterId !== c.clusterId) {
        throw errValidation(
          `tenant ${req.guid} lives on cluster ${resolved.clusterId} ("${resolved.cluster}"), tenant-purge targets ${c.clusterId} — refusing to purge on the wrong cluster`,
        );
      }
      const target = resolved ?? unresolvedTeardownTarget(c);
      ctx.log(
        target.tenantId
          ? `tenant ${req.guid} ("${target.subdomain}") resolved from inventory on ${target.cluster} — ${target.watchNames.length} fan-out Application(s) to prune`
          : resolved
            ? `tenant ${req.guid} ("${target.subdomain}") resolved from its GitOps pointer on ${target.cluster} with NO inventory row (an orphan) — ${target.watchNames.length} fan-out Application(s) to prune`
            : `tenant ${req.guid} has neither an inventory row nor a live pointer — purging its cluster footprint (AppProject, namespaces) and its Vault crypto entry by guid on ${target.cluster}`,
      );
      const params: TenantPurgeParams = { ...req, target };
      const stepDefs = tenantPurgeSteps(ports, params);
      const plan: Plan = {
        kind: "tenant-purge",
        // The tenants row may not exist (orphan), so purge targets the CLUSTER — like create-tenant's
        // plan, whose tenant row does not exist yet either. tenant-offboard targets the tenant; purge
        // cannot assume one.
        targetKind: "cluster",
        targetId: c.clusterId,
        summary:
          `Force-remove tenant ${req.guid} from ${c.domain} (${c.stage}) by GUID` +
          (target.tenantId ? "" : " (no inventory row — an orphaned partial create-tenant)") +
          ": remove its registration, best-effort wait for ArgoCD to prune the whole fan-out, delete every member's isolation AppProject, its admission policy and the argo-sync grant, " +
          `then delete every namespace labelled platform/tenant=${req.guid} as the backstop reap — which takes each member's ServiceClaim with it, and the service-provisioner drops that claim's databases together with its user — ` +
          `then DESTROY the tenant's Vault crypto entry ${c.stage}/tenants/${req.guid} (its signing keypair, TOTP key, bootstrap token and engine key, every version), then remove the tenant's wildcard DNS record` +
          (target.tenantId
            ? ", and only THEN mark the tenant + its app rows PURGED — a distinct state from the \"offboarded\" an offboard leaves, so this tenant reads as deprovisioned rather than merely un-deployed: it drops off the Tenants list and offers no further removal, while its rows are kept as the trace. The rows are settled LAST, so a delete that fails leaves the tenant visible and purgeable"
            : "") +
          ". THE OBJECT-STORAGE BUCKET AND ITS DATA SURVIVE this purge — they are deliberately kept. " +
          // The tail an operator reads LAST, immediately before approving. It used to end "safe to
          // re-run, and safe on a healthy tenant", which meant only "the steps will not error on a
          // healthy tenant" but reads as "if this turns out to be live, nothing bad happens" — the exact
          // opposite of the sentence above it, which says the reap drops the Mongo databases and the
          // crypto delete destroys the tenant's identity, neither recoverable. A purge aimed at a tenant whose inventory row is
          // live AND whose pointer still stands is now refused at both ends (the route, and attest-target
          // when the run is approved), but a LIVE tenant with no row at all — an orphan from before
          // record-provisional, or a hand-written pointer — is still perfectly reachable here, and this
          // plan is its only gate. So state the destructive
          // outcome plainly instead of reassuring, and name idempotence for what it is: a property of
          // re-running THIS purge, not a promise about the target.
          "Re-running the purge is safe — every step reaps only what is still there. The purge itself never asks whether the tenant is still in use: " +
          `if ${req.guid} turns out to be a LIVE, serving tenant, it is torn down and deprovisioned exactly as described above, and its Mongo databases and Vault path are gone for good. ` +
          "A fan-out that cannot be proven pruned fails this run instead of recording the tenant removed.",
        steps: stepDefs.map((s) => ({ name: s.name, title: s.title })),
        targets: [], // no host owned — the Controller acts master-locally
        locks: tenantLocks(ports.registry), // the tenant registrations' branch + the one master ArgoCD, like every tenant run
        // Empty like every other tenant plan, and deliberately so for the destructive one too: nothing
        // renders Plan.warnings (see the CASCADE paragraph in the header) — the deprovision and the
        // surviving bucket are stated in the summary above, which the approve card DOES show.
        warnings: [],
        requiredSecrets: [],
      };
      return { outcome: "planned", params, plan };
    },
    steps: (params) => tenantPurgeSteps(ports, params),
  };
}
