// tenant-replace.ts — WHICH existing tenants a teardown must target, resolved from the two sources
// that can know about a deployed tenant: the DB inventory and the LIVE GitOps pointers. Two functions,
// one resolution path:
//   - resolveTeardownTarget(stage, guid) turns ONE guid into a TenantTeardownTarget — from its
//     inventory row when it has one, else purely from its live tenant.yaml. It is the only place a
//     target is built, so orphan handling cannot drift between callers.
//   - resolveReplaceTargets(stage, subdomain) is the create-tenant IDEMPOTENT-BY-SUBDOMAIN lookup
//: when a create-tenant requests a subdomain that already exists, the plan
//     must REPLACE the old tenant rather than stand up a parallel duplicate sharing the one public
//     FQDN. It finds the guids carrying that subdomain in BOTH sources — so it also reaps ORPHANS
//     deployed-but-never-recorded — and resolves each through the function above.
// The resulting list is frozen into CreateTenantParams.replaces, which create-tenant prepends
// tenant-teardown.ts steps for.
//
// Boundary: domain layer (onboarding) — inventory reads + the TenantRegistry + the pure fan-out
// algebra + tenant-values; no adapters, no IO beyond the db reads and the registry's git reads.
import { and, eq, notInArray } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import type { Step } from "../../executor/types.ts";
import { tenants } from "../../db/schema/inventory.ts";
import { errNotFound, errValidation } from "../../kernel/errors.ts";
import { TENANT_SETTLED_STATUS, type Stage } from "../../../shared/enums.ts";
import { tenantApplicationSet } from "./tenant-fanout.ts";
import { TenantRegistry } from "./tenant-registry.ts";
import { tenantWatchMembers, tenantWatchSet } from "./tenant-lifecycle.run.ts";
import { TenantTeardownTargetSchema, type TenantTeardownTarget } from "./tenant-teardown.ts";
import { resolveClusterIdByName, resolveClusterNameById } from "./tenant-values.ts";

/** CreateTenantParams.replaces is a list of teardown targets — re-exported under the replace name the params
 *  schema already uses, so the frozen params shape is untouched while the schema itself lives next to
 *  the steps that consume it (tenant-teardown.ts). */
export { TenantTeardownTargetSchema as ReplaceTargetSchema } from "./tenant-teardown.ts";
export type { TenantTeardownTarget as ReplaceTarget } from "./tenant-teardown.ts";

/** Resolve ONE guid into the teardown target the tenant-teardown steps drive from — the SINGLE
 *  resolution path, so there is no second, subtly different way to name a tenant for removal.
 *
 *  The inventory row is authoritative when the tenant is still live: it carries the tenantId the record
 *  step flips and the clusterId the kube resolver keys on. With NO such row the target is built PURELY
 *  from the live registration — the ORPHAN case: a registration + fan-out with no
 *  tenants row (a tenant from before record-provisional, or a hand-written file). Its clusterId is
 *  then derived from the registration's `cluster` slave name (resolveClusterIdByName, the inverse of
 *  resolveClusterNameById) and its watch set from the registration's apps (tenantApplicationSet, the
 *  single source of fan-out names). A SETTLED row — "offboarded" OR "purged" (TENANT_SETTLED_STATUS,
 *  shared/enums.ts) — is deliberately NOT authoritative: it records a removal that already ran, so
 *  a guid whose only row is settled resolves exactly like an orphan, from its live pointer if one somehow
 *  still stands and otherwise not at all. Reading the set rather than testing `!== "offboarded"` is what
 *  keeps a PURGED row out: that tenant is deprovisioned, and treating its row as authoritative would hand
 *  a teardown the tenantId of a tenant there is nothing left to tear down.
 *
 *  The registration is read through the registry's TOLERANT scan (scanTenant), never the strict
 *  readTenant: a tenant whose registration has drifted is exactly the tenant a purge is aimed at, and
 *  throwing here would make its purge fail identically forever — and would also block re-creating that
 *  subdomain, since resolveReplaceTargets resolves EVERY same-subdomain guid through this one function.
 *  The removal path therefore tolerates precisely what the scan tolerates.
 *
 *  null when NEITHER source knows the guid (or its slave is not registered as a cluster) — there is
 *  nothing safe to tear down, so the caller skips it rather than guessing a target. It THROWS only for
 *  a broken inventory: a tenants row whose clusterId names no cluster row, which leaves the target's
 *  `cluster` (the ArgoCD-registered slave name) unresolvable — see the comment at that line. */
export async function resolveTeardownTarget(
  deps: { db: Db; registry: TenantRegistry },
  stage: Stage,
  guid: string,
): Promise<TenantTeardownTarget | null> {
  const { db, registry } = deps;
  const row = db
    .select({ tenantId: tenants.id, subdomain: tenants.subdomain, clusterId: tenants.clusterId })
    .from(tenants)
    .where(and(eq(tenants.guid, guid), eq(tenants.stage, stage), notInArray(tenants.status, [...TENANT_SETTLED_STATUS])))
    .get();
  const scan = await registry.scanTenant(stage, guid);
  const pointer = scan.status === "read" ? scan.entry : null;
  let identity: { subdomain: string; clusterId: string; tenantId: string | null } | null = null;
  if (row) {
    identity = { subdomain: row.subdomain, clusterId: row.clusterId, tenantId: row.tenantId };
  } else if (pointer) {
    const resolved = resolveClusterIdByName(db, pointer.cluster, stage);
    if (resolved) identity = { subdomain: pointer.subdomain, clusterId: resolved.clusterId, tenantId: null };
  }
  if (!identity) return null;
  // watchNames: the fan-out to wait for the prune of — the UNION of what EITHER source knows, because
  // neither alone is complete and a set that is too SMALL reads as "pruned" while workloads still serve
  // the tenant's public FQDN:
  //   - the LIVE pointer is what the appsets generate from, so it is the direct source (replace + orphan);
  //   - an ABSENT pointer does NOT mean the fan-out is gone. A FAILED tenant-offboard leaves exactly
  //     that state: remove-tenant committed the pointer removal, watch-removal then threw, so tenant.yaml
  //     is gone while the row is still "active" (record-offboard never ran) and every Application still
  //     runs. Deriving [] there would make allPruned([]) vacuously true — the fail-loud policy satisfied
  //     by a set that was never proven empty. The inventory is the source that survives the git-rm, which
  //     is why offboard-tenant.run.ts's own watch-removal computes its set with tenantWatchSet too;
  //   - the two can also disagree mid-flight (an add-app that wrote the pointer before its row, a
  //     remove-app that dropped it after), and only the union covers both directions.
  const fromPointer = pointer ? tenantApplicationSet(pointer.members, guid, stage) : [];
  const fromInventory = row ? tenantWatchSet(db, { tenantId: row.tenantId, guid, stage }) : [];
  // The MEMBERS, unioned from the same two sources and for the same reason: the teardown deletes one
  // AppProject per member, so a member neither source names is a project nobody deletes. The standing
  // members are in both (each source records the set the tenant was created with); the apps are what
  // can differ mid-flight.
  const memberNames = new Set<string>([
    ...(pointer ? pointer.members : []),
    ...(row ? tenantWatchMembers(db, row.tenantId) : []),
  ]);
  // `cluster` is the ArgoCD-REGISTERED SLAVE NAME (the pointer's own `cluster` field, the appset
  // destination + AppProject pin) — it is what the run log and the tenant-purge plan NAME the tenant's
  // host by, on the very screen where a purge that drops Mongo databases is approved. With no pointer to
  // read it from — the failed-offboard state: the pointer is git-rm'd while the row is still live — it is
  // resolved from the row's cluster instead (resolveClusterNameById, the same derivation every other
  // producer of this field uses). Substituting the cls_-prefixed clusterId there would print an id where
  // the schema promises a slave name, so a cluster row that cannot be resolved at all is a broken
  // inventory and fails loud, exactly as loadTenantCluster does for the same missing row.
  const cluster = pointer?.cluster ?? resolveClusterNameById(db, identity.clusterId);
  if (!cluster) throw errNotFound(`cluster ${identity.clusterId} for tenant ${guid}`);
  return TenantTeardownTargetSchema.parse({
    guid,
    subdomain: identity.subdomain,
    stage,
    clusterId: identity.clusterId,
    cluster,
    tenantId: identity.tenantId,
    watchNames: [...new Set([...fromPointer, ...fromInventory])],
    members: [...memberNames],
  });
}

/** Find every existing tenant with (stage, subdomain) across BOTH sources — the DB inventory AND the
 *  GitOps pointers — deduped by guid, and resolve each through resolveTeardownTarget. Checking both is
 *  the whole point: the pointer scan catches ORPHANS (a live tenant.yaml with no tenants row),
 *  which the DB source alone misses. Since a PROVISIONING row is not settled, the
 *  DB source also surfaces a tenant whose create-tenant never finished, so a re-create on the same
 *  subdomain tears the half-created one down instead of standing a second one up beside it.
 *
 *  A PURGED row must never come back as a replace target and does not: it is
 *  settled, so the DB source below skips it exactly as it skips an offboarded one, and resolveTeardownTarget
 *  would refuse to build a target off it anyway. Prepending a teardown for a tenant that has already been
 *  deprovisioned would make every re-create of that subdomain drag a dead guid through a pointer git-rm, a
 *  fan-out prune watch and an AppProject delete that have nothing to act on — and, under the fail-loud
 *  replace policy, an empty watch set is refused outright, so the create-tenant would not merely waste
 *  steps, it would FAIL. (A guid whose pointer somehow still stands is a different tenant to this function:
 *  the pointer source below picks it up on its own merits, which is right — a standing pointer is deployed
 *  state, and it must come down before a fresh guid takes over the FQDN.) */
/** The execute-time half of idempotent-by-subdomain: the create-tenant step "ensure-subdomain-free",
 *  between attest-target and record-provisional, read-only. The replace set above is resolved at PLAN
 *  time and frozen into params, but the run's locks are only taken at approve — so two create-tenant
 *  plans for ONE subdomain can both freeze replaces=[] and be approved in turn, and the second would
 *  stand its fan-out beside the first on the one public FQDN `*.<subdomain>.<unitApex>`
 *  (provision-dns re-points the shared wildcard underneath the winner). This step re-resolves the
 *  same-subdomain tenants at EXECUTE time — the run holds the catalog branch lock, so the
 *  answer cannot move underneath it — and refuses any guid the approved plan did not name as a
 *  replace target. The run's OWN guid is excluded: on a resume its row and registration already
 *  carry the subdomain. Construction dereferences no param (the armed check builds steps({})). */
export function ensureSubdomainFreeStep(
  registry: TenantRegistry,
  consumerNames: () => Promise<string[]>,
  p: { guid: string; subdomain: string; stage: Stage; replaces?: { guid: string }[] },
): Step {
  return {
    name: "ensure-subdomain-free",
    title: "Ensure no tenant and no consumer holds the subdomain",
    run: async (ctx) => {
      const current = await resolveReplaceTargets({ db: ctx.db, registry }, p.stage, p.subdomain);
      const approved = new Set((p.replaces ?? []).map((r) => r.guid));
      const foreign = current.filter((t) => t.guid !== p.guid && !approved.has(t.guid));
      if (foreign.length > 0) {
        throw errValidation(
          `subdomain "${p.subdomain}" is no longer free — tenant ${foreign.map((t) => t.guid).join(", ")} took it since this plan was approved (a concurrent create-tenant). Two tenants must not serve one public FQDN; discard this run and plan the create-tenant again.`,
        );
      }
      // The MIRROR of gate G23's tenant-subdomain clause: a consumer name and a tenant subdomain are
      // one label under one apex, and this tenant's IdP would scope every session cookie to a host
      // that consumer already serves — see the name-space paragraph in unit-dns.ts. A consumer is
      // never a replace target: the replace set tears down TENANTS, and a live consumer means the
      // subdomain is simply not available.
      const units = await consumerNames();
      if (units.includes(p.subdomain)) {
        throw errValidation(
          `subdomain "${p.subdomain}" is the name of the onboarded consumer "${p.subdomain}", which serves the host <name>.<unitApex> — the exact host this tenant's example-auth would scope its session cookies to, so every one of its users' browsers would send the session to that consumer. Name the tenant differently, or offboard the consumer first.`,
        );
      }
      ctx.log("meta", `subdomain "${p.subdomain}" is held by no consumer and by no tenant this plan does not replace (${approved.size} approved replace target(s))`);
    },
  };
}

export async function resolveReplaceTargets(
  deps: { db: Db; registry: TenantRegistry },
  stage: Stage,
  subdomain: string,
): Promise<TenantTeardownTarget[]> {
  const { db, registry } = deps;
  // DB inventory: still-deployed rows carrying this subdomain (SETTLED rows — offboarded and purged
  // alike — are already removed; the pointer scan below would not re-surface them either, so they never
  // re-enter the replace set).
  const guids = new Set(
    db
      .select({ guid: tenants.guid })
      .from(tenants)
      .where(and(eq(tenants.subdomain, subdomain), eq(tenants.stage, stage), notInArray(tenants.status, [...TENANT_SETTLED_STATUS])))
      .all()
      .map((r) => r.guid),
  );
  // GitOps pointers: union in any guid whose LIVE tenant.yaml carries the subdomain — orphans included.
  for (const g of await registry.subdomainGuids(stage, subdomain)) guids.add(g);

  const targets: TenantTeardownTarget[] = [];
  for (const g of guids) {
    const target = await resolveTeardownTarget(deps, stage, g);
    if (target) targets.push(target); // null ⇒ no live pointer AND no inventory row — nothing to offboard
  }
  return targets;
}
