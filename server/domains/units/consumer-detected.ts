// consumer-detected.ts — the discovery half of surfacing untracked consumers, the CONSUMER TWIN of the tenant
// orphan scan (tenant-orphans.ts scanOrphanTenants).
//
// THE PROBLEM. A DETECTED consumer is one that exists in GitOps (a registration at
// registrations/<name>/<stage>.yaml on the books branch, from which the consumers ApplicationSet generates the
// live Application) with NO unsettled apps row. onboard writes
// the inventory row LAST (record-inventory, onboard-steps.ts), so an onboard that failed at
// watch-sync/smoke/activate — or a pointer committed by hand — leaves a consumer that may be serving
// perfectly while the Manager cannot see it: the Consumers list is a projection of the apps rows,
// and offboard resolves its target BY that row (loadAppCluster), so the consumer is not merely
// unremovable, it is INVISIBLE. swissbookai is the founding case: healthy in the cluster, absent from
// the product. Unlike a tenant orphan — whose remedy is purge (removal) — the remedy here is ADOPT
// (adopt-consumer.run.ts): reconstruct the row FROM the pointer, with a live cluster attest.
//
// THE HONESTY LAW this module obeys (and the UI renders): the bulk scan reads ONLY the registrations —
// no live probe per consumer — so everything it returns is "what the registration says", never "what
// runs". The live truth is a separate per-row probe (GET /api/consumers/live). A registration the scan
// could not read is carried out in `skipped`, never dropped: an empty `detected` beside a silent skip
// would read as "every registered consumer has a matching inventory row" — an unfalsifiable all-clear
// for a consumer nobody can even see.
//
// THE BLIND SPOT THAT LAW LEAVES, and the second scan below. Reading only the registrations means the
// diff starts from them, so a consumer with NO registration is not merely absent from the answer — it
// cannot be expressed in it. That is a real state: a registration removed while the cluster workloads
// were never pruned leaves a consumer with no registration AND no inventory row, and the founding case
// was exactly that — pods serving, zero detected, and the Reconciliation view saying every registration
// has a matching row, which was true and useless. scanClusterOrphanConsumers is the complementary read,
// and it starts from the OTHER end: it asks each active cluster which namespaces carry the platform's
// own consumer label, and reports every one that neither a registration nor a row accounts for.
//
// The two are kept apart rather than merged, in the code and on the wire, because their evidence is of
// different kinds and an operator has to be able to tell them apart. `detected` is what a file CLAIMS,
// so nothing in it may read as running. `clusterOrphans` is what a cluster SHOWS, so every field in it
// is a live read — and the one that decides what an operator does with the row (a leak that is serving,
// or an empty namespace an offboard left behind) is how many workloads actually have a ready replica.
//
// A SETTLED row ("offboarded", APP_SETTLED_STATUS) counts as ABSENT here, exactly as the tenant scan
// treats TENANT_SETTLED_STATUS: the row records a removal that already ran, so a live
// registration beside it is leftover state — or a re-deploy the Manager never learned of — not an
// accounted-for consumer.
//
// Boundary: domain layer — inventory reads, the consumer Registrations's registration scan, and (for the
// cluster half) the per-cluster ClusterReader the resolver hands out. No concrete adapter is imported
// here; the reader arrives through the port, exactly as the run steps take it.
import { and, eq, notInArray } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { apps, clusters } from "../../db/schema/inventory.ts";
import { APP_SETTLED_STATUS, type Stage } from "../../../shared/enums.ts";
// The wire shapes this module ANSWERS IN, declared once in shared/api-types.ts and consumed unchanged
// by the browser (web/src/api.ts + the Detected panel) — the same one-declaration rule the tenant
// orphan scan follows, for the reason documented at length in that file's header.
import type {
  ClusterOrphanConsumerView, DetectedConsumerView, DetectedScan, SkippedConsumerPointerView, UnscannedClusterView,
} from "../../../shared/api-types.ts";
import type { Registrations } from "./registrations.ts";
import type { ClusterKubeResolver, WorkloadStatus } from "../../adapters/kube/port.ts";
import { consumerNamespaceSelector } from "./admission-policy.ts";

/** Diff the LIVE GitOps consumer registrations against the inventory, per ACTIVE cluster, and return
 *  every consumer only the registrations know about — plus every one the scan had to skip. Iterates the
 *  registered active clusters rows and selects the registrations whose own `cluster` field names that
 *  cluster (the same selection the appset makes), so — unlike the tenant scan, whose registration names
 *  a slave that may not be registered — every detected consumer arrives with its clusterId resolved.
 *
 *  The inventory side of the diff is keyed on (clusterId, name) and NOT additionally on stage,
 *  mirroring purge's findAppRow: any UNSETTLED row for that name on that cluster already renders the
 *  consumer on the Consumers list (the list joins apps -> clusters without a stage filter), so it is
 *  not "invisible" and must not be offered for adoption. A SETTLED row is deliberately not "known" —
 *  see the header.
 *
 *  Each registration's fields are carried VERBATIM as its CLAIM (DetectedConsumerPointerView) — no
 *  live probe happens here. THROWS when the registration branch cannot be read at all — the route turns
 *  that into a visible, fail-soft "the scan itself failed" (never an empty list).
 *
 *  Returns the REGISTRATION half of DetectedScan and says so in its type: the cluster half is
 *  scanClusterOrphanConsumers below, and the route composes the two. A single function returning all
 *  four lists would let one half's failure be told in the other half's words. */
export async function scanDetectedConsumers(deps: { db: Db; registrations: Registrations }): Promise<Pick<DetectedScan, "detected" | "skipped">> {
  const { db, registrations } = deps;
  const detected: DetectedConsumerView[] = [];
  const skipped: SkippedConsumerPointerView[] = [];
  const active = db.select().from(clusters).where(eq(clusters.status, "active")).all();
  for (const cluster of active) {
    const known = new Set(
      db
        .select({ name: apps.name })
        .from(apps)
        .where(and(eq(apps.clusterId, cluster.id), notInArray(apps.status, [...APP_SETTLED_STATUS])))
        .all()
        .map((r) => r.name),
    );
    const scan = await registrations.listConsumerRegistrations(cluster.domain, cluster.stage);
    skipped.push(...scan.skipped); // reported, never dropped — see DetectedScan
    for (const found of scan.registrations) {
      if (known.has(found.name)) continue;
      const e = found.entry;
      detected.push({
        name: found.name,
        stage: cluster.stage,
        clusterId: cluster.id,
        domain: cluster.domain,
        // ONLY the registration side — what it SAYS, copied verbatim. Optional fields are OMITTED when
        // absent (never an explicit undefined — exactOptionalPropertyTypes). chartPath/cluster are
        // mandatory in a STAGE registration, which is the only kind this scan reads.
        pointer: {
          repoURL: e.repoURL,
          chartPath: e.chartPath ?? "",
          cluster: e.cluster ?? "",
          suspended: e.suspended,
          quiesced: e.quiesced,
          ...(e.repoCredentialId !== undefined ? { repoCredentialId: e.repoCredentialId } : {}),
          ...(e.onboardedAt !== undefined ? { onboardedAt: e.onboardedAt } : {}),
          ...(e.owner !== undefined ? { owner: e.owner } : {}),
        },
      });
    }
  }
  return { detected, skipped };
}

/** The CLUSTER half: every consumer namespace standing on an active cluster that neither a
 *  registration nor an unsettled inventory row accounts for.
 *
 *  WHY IT STARTS FROM THE CLUSTER. scanDetectedConsumers above starts from the registrations, so a
 *  consumer that HAS no registration cannot appear in its answer at all — not as a miss, as an
 *  inexpressible state. This one starts from the other end: it asks the cluster which namespaces carry
 *  the platform's own consumer label (consumerNamespaceSelector — the same pair the consumers
 *  ApplicationSet stamps through managedNamespaceMetadata and the unit's admission policy admits), and
 *  subtracts both books. What is left is a consumer the product can neither show nor reach.
 *
 *  WHY THE NAMESPACE AND NOT THE APPLICATION. The consumers ApplicationSet GENERATES the Application
 *  from the registration, so a removed registration takes the Application with it — there is nothing
 *  left to find. The namespace is the opposite by design: the appset stamps
 *  `argocd.argoproj.io/sync-options: Prune=false,Delete=false` on it
 *  (hostyour-cloud/argocd/<stage>/apps/consumers-appset.yaml), so the namespace and everything a
 *  per-PVC Delete=false keeps SURVIVE the pointer. That is exactly why the leftover is a namespace and
 *  exactly why looking for a leftover Application would find nothing in this case.
 *
 *  WHAT IT SUBTRACTS, and why both. The inventory side is the same unsettled-rows set the registration
 *  diff uses, so a consumer the Manager already lists is not reported twice. The registration side
 *  is subtracted too, and that is the load-bearing one: a namespace WITH a registration is exactly what
 *  scanDetectedConsumers already reports, as a detected consumer with a pointer and an adopt button.
 *  Reporting it here as well would put the same consumer on screen twice under two different remedies.
 *
 *  WHAT IT READS LIVE, and why that field. Every namespace is smoked, and the answer carries how many
 *  of its workloads have a ready replica. That is what separates the two states an operator treats
 *  differently: a namespace still SERVING (the leak — someone's customer is being served by something
 *  the platform does not know it runs) from an empty one an offboard left behind (a leftover). A count
 *  of workloads alone cannot tell them apart, because a suspended unit renders 0 of 0 and reads
 *  "available" too.
 *
 *  FAILS PER CLUSTER, NEVER AS A WHOLE. A slave that is down, an expired bearer or a refused namespace
 *  list yields an `unscanned` entry naming that cluster and its reason; the other clusters still
 *  answer. Silence would be the very failure this scan exists to end. A namespace whose SMOKE fails is
 *  still REPORTED — its existence is the finding, and the live counts fall back to zero with the
 *  reason on the cluster's own entry, because a namespace that cannot be smoked is not a namespace that
 *  is not there. */
export async function scanClusterOrphanConsumers(deps: {
  db: Db;
  registrations: Registrations;
  resolver: ClusterKubeResolver;
}): Promise<Pick<DetectedScan, "clusterOrphans" | "unscanned">> {
  const { db, registrations, resolver } = deps;
  const clusterOrphans: ClusterOrphanConsumerView[] = [];
  const unscanned: UnscannedClusterView[] = [];
  const active = db.select().from(clusters).where(eq(clusters.status, "active")).all();

  for (const cluster of active) {
    const stage = cluster.stage as Stage;
    try {
      const known = new Set(
        db
          .select({ name: apps.name })
          .from(apps)
          .where(and(eq(apps.clusterId, cluster.id), notInArray(apps.status, [...APP_SETTLED_STATUS])))
          .all()
          .map((r) => r.name),
      );
      // The registrations this cluster's appset generates from. An UNREADABLE registration tree makes
      // this half refuse for this cluster rather than report everything on it as an orphan: without the
      // registration names there is nothing to subtract, and every healthy consumer would be listed as
      // untracked — the loudest possible false positive.
      const registered = await registrations.listConsumerRegistrations(cluster.domain, stage);
      for (const r of registered.registrations) known.add(r.name);
      // A registration the reader could not PARSE is a name it could not learn, so a namespace of that
      // name would be reported here as an orphan although the file exists. Its directory name is the
      // identity (that much was readable), so subtract it and let `skipped` carry the file itself.
      for (const s of registered.skipped) known.add(s.name);

      const { clusterReader } = await resolver.resolve(cluster.id);
      const namespaces = await clusterReader.listNamespaces(consumerNamespaceSelector());
      for (const ns of namespaces) {
        if (known.has(ns)) continue;
        const smoke = await clusterReader.smoke(ns);
        clusterOrphans.push({
          name: ns,
          stage,
          clusterId: cluster.id,
          domain: cluster.domain,
          running: smoke.workloads.filter((w: WorkloadStatus) => w.ready > 0).length,
          workloads: smoke.workloads.length,
          externalSecretsReady: smoke.externalSecretsReady,
        });
      }
    } catch (e) {
      unscanned.push({
        clusterId: cluster.id,
        domain: cluster.domain,
        stage,
        reason: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return { clusterOrphans, unscanned };
}
