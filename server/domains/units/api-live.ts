// Live reconciliation routes for consumers and tenants: reads the cluster and ArgoCD facts
// for standing units and compares them with GitOps pins.
// Route payload types live in shared/api-types-live.ts.
import type { Hono } from "hono";
import { and, eq, inArray, isNull, notInArray } from "drizzle-orm";
import type { AppEnv } from "../../http/app-env.ts";
import { apps, clusters, servers, tenants, tenantApps } from "../../db/schema/inventory.ts";
import { errNotFound } from "../../kernel/errors.ts";
import { MASTER_ROLES, TENANT_SETTLED_STATUS, type ArgoSync, type ArgoHealth } from "../../../shared/enums.ts";
import type { LiveArgoView, ConsumerLiveView, ConsumerLiveProbeView, TenantLiveView } from "../../../shared/api-types-live.ts";
import { singleSourceRevision, targetedRevisionFor, type ArgoAppStatus } from "../../adapters/kube/port.ts";
import { tenantArgocdUrl } from "../../../shared/tenant.ts";
// The live reconciliation comparison — the per-kind EXPECTED records and the consumer live probe in
// live-recon.ts, and driftOf, the one deployment question every card asks, in the unit plugin.
import { probeConsumerLive, readConsumerStanding, smokeTenant, errText } from "./live-recon.ts";
import { invalid } from "./api-invalid.ts";
import { driftOf } from "#unit/server/live-drift.ts";
import { AdoptConsumerParams } from "./adopt-consumer.run.ts";
import { memberApplication, tenantApplicationSet, tenantNamespaces } from "./tenant-fanout.ts";
import { tenantSelector } from "./tenant-lifecycle.run.ts";
import { TENANT_COLUMNS } from "./tenant-columns.ts";
import type { ConsumerOnboardApiDeps, TenantApiDeps } from "./api.ts";

// The set read is a ONE-shot snapshot of the fan-out (until:()=>true returns after a single list), so
// this timeout is only a formality — a modest ceiling in case a slow list ever needs one poll.
const TENANT_LIVE_SET_READ_TIMEOUT_MS = 10_000;

/** Roll a tenant fan-out's per-Application statuses into ONE argo fact (a tenant is N Applications, a
 *  consumer is one): Synced ONLY when EVERY member is Synced (any OutOfSync ⇒ OutOfSync, else Unknown);
 *  health is the WORST-of the members, so a single Degraded/Missing member surfaces over the Healthy
 *  rest — the same "one bad member fails the set" rule the deploy/prune watches already apply. */
const HEALTH_SEVERITY: Record<ArgoHealth, number> = { Healthy: 0, Progressing: 1, Unknown: 2, Degraded: 3, Missing: 4 };
function rollupFanoutStatus(statuses: readonly ArgoAppStatus[]): { sync: ArgoSync; health: ArgoHealth } {
  const sync: ArgoSync = statuses.every((s) => s.sync === "Synced")
    ? "Synced"
    : statuses.some((s) => s.sync === "OutOfSync")
      ? "OutOfSync"
      : "Unknown";
  const health = statuses.reduce<ArgoHealth>((worst, s) => (HEALTH_SEVERITY[s.health] > HEALTH_SEVERITY[worst] ? s.health : worst), "Healthy");
  return { sync, health };
}

export type ConsumerLiveApiDeps = Pick<ConsumerOnboardApiDeps, "db" | "resolver" | "registrations">;

export function registerConsumerLiveRoutes(app: Hono<AppEnv>, deps: ConsumerLiveApiDeps): void {
  const { db, resolver, registrations } = deps;

  // The NAME-keyed live probe: the SAME live read as /:appId/live below,
  // WITHOUT an apps row — a DETECTED consumer has none, and its panel still owes the operator the
  // live truth beside the pointer's claim (nothing shown as running unless probed live). Query-keyed
  // on the purge/adopt identity (clusterId + name + stage, validated through AdoptConsumerParams —
  // the same shape). `repoURL` is OPTIONAL and comes from the pointer the detected scan just returned:
  // the generated Application is multi-source, so without a repo to ask for, neither revision could be
  // resolved (probeConsumerLive).
  app.get("/api/consumers/live", async (c) => {
    const q = c.req.query();
    const parsed = AdoptConsumerParams.safeParse({ consumerName: q["name"], stage: q["stage"], clusterId: q["clusterId"] });
    if (!parsed.success) invalid("consumer live probe", parsed.error);
    if (!resolver) return c.json({ cluster: null, argo: null, drift: null, argocdUrl: null, reason: "onboarding-not-configured" } satisfies ConsumerLiveProbeView);
    const repoURL = typeof q["repoURL"] === "string" && q["repoURL"].startsWith("https://") ? q["repoURL"] : null;
    const probe = await probeConsumerLive(db, resolver, {
      clusterId: parsed.data.clusterId,
      name: parsed.data.consumerName,
      stage: parsed.data.stage,
      repoUrl: repoURL,
    });
    return c.json(probe satisfies ConsumerLiveProbeView);
  });

  // Per-consumer reconciliation: the SQL row is a TRACE of what the Manager BELIEVES;
  // this reads the FACTS — a live cluster smoke (namespace + workloads + ExternalSecrets, source 2)
  // and the deployed ArgoCD status (source 3) — and computes the single highest-value comparison:
  // the deployed SHA vs the pinned version (drift). LAZY per row (one call per visible consumer),
  // deliberately NOT eager-augmenting the always-live list: a slow/unreachable slave spins only ITS
  // row, never the whole page. Fail-soft — the two live reads are fanned with allSettled so one
  // failing (a slave down) still yields the other. With no resolver (onboarding unconfigured) it
  // degrades to SQL-only (reason), the same degrade-loud contract as the 501 mutating routes.
  // The live half lives in probeConsumerLive (shared with the name-keyed probe above).
  app.get("/api/consumers/:appId/live", async (c) => {
    const appId = c.req.param("appId");
    const found = db
      .select({
        id: apps.id, name: apps.name, host: apps.host, clusterId: apps.clusterId, domain: clusters.domain,
        stage: apps.stage, repoUrl: apps.repoUrl, status: apps.status,
      })
      .from(apps)
      .innerJoin(clusters, eq(apps.clusterId, clusters.id))
      .where(eq(apps.id, appId))
      .get();
    if (!found) throw errNotFound(`consumer ${appId}`);
    // Source (1): the SQL row — what the Manager BELIEVES (the TRACE). Echoed alongside the live
    // facts so the response is a self-contained FACT-vs-TRACE payload (repoUrl stays server-side only:
    // it is which repo the two revisions are resolved FOR, not something the card shows).
    const { repoUrl, ...row } = found;
    if (!resolver) return c.json({ row, unitHost: null, fqdn: null, quiesced: null, cluster: null, argo: null, drift: null, argocdUrl: null, reason: "onboarding-not-configured" } satisfies ConsumerLiveView);
    const [probe, standing] = await Promise.all([
      probeConsumerLive(db, resolver, { clusterId: row.clusterId, name: row.name, stage: row.stage, repoUrl }),
      readConsumerStanding(registrations, row),
    ]);
    return c.json({ row, ...standing, ...probe } satisfies ConsumerLiveView);
  });
}

export type TenantLiveApiDeps = Pick<TenantApiDeps, "db" | "registrations" | "resolver" | "deployRepoUrl">;

export function registerTenantLiveRoutes(app: Hono<AppEnv>, deps: TenantLiveApiDeps): void {
  const { db, resolver, deployRepoUrl, registrations } = deps;

  // Per-tenant reconciliation — the tenant analogue of GET /api/consumers/:appId/live. The
  // SQL row is a TRACE of what the Manager BELIEVES; this reads the FACTS. A tenant fans out to N
  // ArgoCD Applications, one per member, each in its own namespace <guid>-<member>, so the
  // FACTS are AGGREGATED: a cluster smoke of EVERY member namespace folded into one (source 2), and the fan-out's
  // Applications read in ONE labelSelector'd list and ROLLED UP (source 3) — Synced only if every
  // member is Synced, health worst-of. Drift is the registration's pinned chartsRef vs the deployed
  // revision the AUTH member's Application reports. LAZY per row + fail-soft (the two reads are
  // fanned with allSettled, so a down slave spins only ITS smoke, not the argo read). With no resolver
  // (tenant onboarding unconfigured) it degrades to SQL-only (reason) — the 501 mutating routes' contract.
  app.get("/api/tenants/:id/live", async (c) => {
    const id = c.req.param("id");
    const found = db.select(TENANT_COLUMNS).from(tenants).innerJoin(clusters, eq(tenants.clusterId, clusters.id)).where(eq(tenants.id, id)).get();
    if (!found) throw errNotFound(`tenant ${id}`);
    // Source (1): the tenant row TRACE — echoed beside the live facts so the payload is self-contained.
    // Off the stage registration, which the render follows; fail-soft like the consumer's, so the card still renders.
    const quiesced = registrations ? await registrations.readTenant(found.stage, found.guid).then((reg) => (reg === null ? null : reg.entry.quiesced)).catch(() => null) : null;
    const row = {
      id: found.id, guid: found.guid, subdomain: found.subdomain, clusterId: found.clusterId,
      domain: found.domain, stage: found.stage, status: found.status, suspended: found.suspended, quiesced,
    };
    // BOTH deps or none: the resolver reaches the cluster + ArgoCD, and the deploy repository URL is what
    // the pin is asked FOR (see TenantApiDeps). Without either there is no live answer to give, and a
    // half-answer here would mean pinning against the DB column — the very record-as-truth substitution this live read exists to avoid.
    if (!resolver || !deployRepoUrl) return c.json({ row, cluster: null, argo: null, drift: null, argocdUrl: null, reason: "onboarding-not-configured" } satisfies TenantLiveView);

    const { clusterReader, argoReader, argoNamespace } = await resolver.resolve(found.clusterId);
    // The EXPECTED fan-out Application names from inventory (the faithful DB projection of the
    // registration): the trio always, then one <guid>-<app>-<stage> per
    // NOT-YET-SETTLED app row — via tenantApplicationSet, the single source of truth for names. The
    // filter mirrors tenantWatchSet's exactly (both project the same pointer, and both ask the one named
    // set TENANT_SETTLED_STATUS): a PROVISIONING app row belongs in the expected set, so a half-created
    // tenant's card honestly reports its missing members instead of rolling up a shrunken set and reading
    // Healthy, while an "offboarded" or "purged" row is genuinely gone.
    const appRows = db.select({ name: tenantApps.name }).from(tenantApps).where(and(eq(tenantApps.tenantId, found.id), isNull(tenantApps.deleted), notInArray(tenantApps.status, [...TENANT_SETTLED_STATUS]))).all();
    const members = [...found.members, ...appRows.map((a) => a.name)];
    const expectedApps = tenantApplicationSet(members, found.guid, found.stage);
    const namespaces = tenantNamespaces(members, found.guid, found.stage);
    // The deployed-revision ANCHOR is the AUTH member: every tenant has it, always, so there is
    // one member whose Application is guaranteed to exist to read a revision off. Its Application is the
    // only single-repo one of the set, which is what makes a revision readable at all.
    const authApp = memberApplication(found.guid, found.identityProvider, found.stage);
    // The ArgoCD deep-link to the tenant's fan-out (the label-filtered applications list), from the
    // master's OWN cluster domain. Independent of the argo read below — a down ArgoCD is exactly when
    // the operator wants to click through, so the link must survive a failed read.
    const masterCluster = db
      .select({ domain: clusters.domain })
      .from(clusters)
      .innerJoin(servers, and(eq(servers.id, clusters.serverId), isNull(servers.deleted)))
      .where(inArray(servers.role, [...MASTER_ROLES]))
      .get();
    const argocdUrl = tenantArgocdUrl(masterCluster?.domain ?? null, argoNamespace, found.guid);
    // Fan the two live reads so one failure never sinks the other. The set read is a ONE-shot snapshot
    // (until:()=>true returns after a single list) filtered to platform/tenant=<guid>; every expected
    // member ABSENT from that list reads Missing (the completeness map).
    // The cluster half smokes EVERY member namespace and folds them into ONE answer: the tenant exists
    // only if all of its namespaces do, its ExternalSecrets are ready only if every member's are, and
    // its workloads are the union. A per-member breakdown would be a different screen; what this card
    // answers is "is this tenant whole", and one member missing must make that a No.
    const [smokeRes, argoRes] = await Promise.allSettled([
      smokeTenant(clusterReader, namespaces),
      argoReader.watchApplicationSet(argoNamespace, expectedApps, () => true, {
        timeoutMs: TENANT_LIVE_SET_READ_TIMEOUT_MS,
        signal: c.req.raw.signal,
        labelSelector: tenantSelector(found.guid),
      }),
    ]);

    const cluster = smokeRes.status === "fulfilled"
      ? { ok: true as const, ...smokeRes.value }
      : { ok: false as const, error: errText(smokeRes.reason) };

    let argo: LiveArgoView;
    let deployed: string | null = null;
    // The registration's pin AS ARGOCD SEES IT (what the auth member's deploy repository source targets).
    // Stays null until the argo read succeeds and that member exists; the DB row is only the fallback.
    let targeted: string | null = null;
    let argoSync: ArgoSync | null = null;
    if (argoRes.status === "fulfilled") {
      const byName = argoRes.value;
      const statuses = expectedApps.map((n) => byName.get(n)).filter((s): s is ArgoAppStatus => s !== undefined);
      const rolled = rollupFanoutStatus(statuses);
      // The deployed-revision anchor: the AUTH member's synced revision. Every tenant has that member
      //, so the anchor is always nameable, and it carries the tenant's own chart from
      // the deploy repository — read via singleSourceRevision, which prefers the singular
      // `status.sync.revision` and falls back to the sole entry of `status.sync.revisions[]` for a
      // source expressed inside a one-element `.spec.sources` array. A Missing member has neither ⇒ null.
      const authStatus = byName.get(authApp);
      deployed = authStatus ? singleSourceRevision(authStatus) : null;
      // The PIN, asked per repo — the same question the consumer route asks with apps.repoUrl, put to
      // the tenant's platform-constant repo instead. Asking (rather than taking source 0) is what keeps
      // this correct now that every member Application is multi-source: its chart comes from
      // the deploy repository and its `$values` chain from hostyour-cloud, so source 0 would answer about the
      // wrong repo, exactly the defect the consumer path already fixed.
      targeted = authStatus ? targetedRevisionFor(authStatus, deployRepoUrl) : null;
      // The verdict compares the ANCHOR: the auth member's own sync status, not the rollup — a member
      // that is missing shows in the rolled-up health, and is not a drift of the anchor's revision.
      argoSync = authStatus ? authStatus.sync : null;
      argo = { ok: true, sync: rolled.sync, health: rolled.health, syncRevision: deployed };
    } else {
      argo = { ok: false, error: errText(argoRes.reason) };
    }

    // The high-value comparison: what the auth member TARGETS vs what it RUNS, both read off the CR
    // itself (no git call). There is no third source to fall back on: the registration states no
    // revision and the tenants row records none either, so a comparison is offered exactly where ArgoCD
    // gave both halves. A SUSPENDED tenant keeps every member Application by design, so it goes on
    // being compared exactly like an active one.
    const drift = driftOf({ targeted, deployed, sync: argoSync, argoRead: argoRes.status === "fulfilled" });
    return c.json({ row, cluster, argo, drift, argocdUrl } satisfies TenantLiveView);
  });
}
