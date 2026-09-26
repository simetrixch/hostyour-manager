// The LIVE RECONCILIATION comparison — the one place the product answers "does what the cluster RUNS
// match what the GitOps pointer PINS?". Factored out of api.ts (which stays the thin route layer)
// because THREE surfaces now answer through it: the consumer row card (GET /api/consumers/:appId/live),
// the tenant card (GET /api/tenants/:id/live, which calls driftOf, plugins/unit/server/live-drift.ts), and the name-keyed detected
// probe (GET /api/consumers/live). One implementation is the whole guarantee
// that no two cards can ever describe the same live situation differently.
import { eq, inArray } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { clusters, servers } from "../../db/schema/inventory.ts";
import { MASTER_ROLES, type Stage, type ArgoSync } from "../../../shared/enums.ts";
import type { LiveArgoView, ConsumerLiveProbeView } from "../../../shared/api-types.ts";
import { syncedRevisionFor, targetedRevisionFor, type ClusterKubeResolver, type ClusterReader, type SmokeResult } from "../../adapters/kube/port.ts";
import { consumerArgoAppName, consumerArgocdUrl, consumerNamespace } from "../../../shared/consumer.ts";
import type { Registrations } from "#unit/server/registrations.ts";
import { unitApexFromChain } from "#unit/server/unit-apex.ts";
import { consumerUnitHost } from "#unit/server/unit-dns.ts";
import { driftOf } from "#unit/server/live-drift.ts";

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The cluster half of a TENANT's live read: smoke every member namespace and fold the answers into
 *  the ONE SmokeResult the card renders. A tenant holds one namespace per member, and the card's
 *  question is "is this tenant whole" — so the fold is strict on both facts that can be false: the
 *  namespace exists only if EVERY member's does, and the ExternalSecrets are ready only if every
 *  member's are. The workloads are the union across the members, which is what makes "N/M workloads"
 *  count the whole tenant instead of one namespace of it. */
export async function smokeTenant(clusterReader: ClusterReader, namespaces: readonly string[]): Promise<SmokeResult> {
  const results = await Promise.all(namespaces.map((ns) => clusterReader.smoke(ns)));
  return {
    namespaceExists: results.every((r) => r.namespaceExists),
    workloads: results.flatMap((r) => r.workloads),
    externalSecretsReady: results.every((r) => r.externalSecretsReady),
  };
}

/** The LIVE half of ONE consumer reconciliation read — the whole body of GET /api/consumers/:appId/live
 *  after its row lookup, factored out because a SECOND caller needs it WITHOUT a row: the name-keyed
 *  probe GET /api/consumers/live, which the Detected panel renders for a consumer the inventory does
 *  not know. One implementation ⇒ the row-keyed card and the detected row can
 *  never answer the same live situation differently.
 *
 *  `repoUrl` is which repo both revisions are resolved FOR: the generated consumer Application is
 *  MULTI-SOURCE ($values + chart + image-guard), so neither side may be read positionally (see the
 *  comments inline). The row route passes the private apps.repoUrl; the name-keyed probe passes the
 *  pointer's repoURL the caller got from the detected scan, or null (then the singular single-source
 *  fields are the only answer available). */
export async function probeConsumerLive(
  db: Db,
  resolver: ClusterKubeResolver,
  input: { clusterId: string; name: string; stage: Stage; repoUrl: string | null },
): Promise<ConsumerLiveProbeView> {
  const { clusterReader, argoReader, argoNamespace } = await resolver.resolve(input.clusterId);
  // The namespace and the GENERATED Application are both <name>-<stage>.
  const appName = consumerArgoAppName(input.name, input.stage);
  // The ArgoCD UI deep-link, derived from the master's OWN cluster domain (the public masterFqdn,
  // always present — never the optional MASTER_FQDN config). Computed HERE, not the always-live list
  // route, which deliberately never resolves clusters. Independent of the argo read below: a down
  // ArgoCD is exactly when the operator wants to click through, so the link must survive a failed read.
  const masterCluster = db
    .select({ domain: clusters.domain })
    .from(clusters)
    .innerJoin(servers, eq(servers.id, clusters.serverId))
    .where(inArray(servers.role, [...MASTER_ROLES]))
    .get();
  const argocdUrl = consumerArgocdUrl(masterCluster?.domain ?? null, argoNamespace, appName);
  // Fan the two live reads so one failure never sinks the other — a down slave spins its cluster
  // smoke, not the argo read that always hits the master's one kube endpoint.
  const [smokeRes, argoRes] = await Promise.allSettled([
    clusterReader.smoke(consumerNamespace(input.name, input.stage)),
    argoReader.getApplication(argoNamespace, appName),
  ]);

  const cluster = smokeRes.status === "fulfilled"
    ? { ok: true as const, ...smokeRes.value }
    : { ok: false as const, error: errText(smokeRes.reason) };

  // The generated consumer Application is MULTI-SOURCE ($values + chart + image-guard), so NEITHER
  // side of the comparison may be read positionally: the deployed SHA comes from the consumer
  // chart's own repoURL (syncedRevisionFor) and the PIN from that same repo's spec source
  // (targetedRevisionFor). Source 0 is the GitOps repo pinned to the install BRANCH, so reading it
  // would yield "m1.example.com" where a SHA belongs. A missing Application (null) reads as
  // health "Missing" with neither revision — no spec to target, nothing synced.
  let argo: LiveArgoView;
  let deployed: string | null = null;
  let targeted: string | null = null;
  let sync: ArgoSync | null = null;
  if (argoRes.status === "fulfilled") {
    const s = argoRes.value;
    if (s === null) {
      argo = { ok: true, sync: "Unknown", health: "Missing", syncRevision: null };
    } else {
      deployed = input.repoUrl ? syncedRevisionFor(s, input.repoUrl) : s.syncRevision;
      targeted = input.repoUrl ? targetedRevisionFor(s, input.repoUrl) : s.targetRevision;
      sync = s.sync;
      argo = { ok: true, sync: s.sync, health: s.health, syncRevision: deployed, ...(s.message !== undefined ? { message: s.message } : {}) };
    }
  } else {
    argo = { ok: false, error: errText(argoRes.reason) };
  }

  // The high-value comparison: what the POINTER pins vs what the cluster actually RUNS — both halves
  // read off the Application and nowhere else. Comparing against a Manager-side column is exactly
  // what makes this card flag perfectly correct consumers as "Drift": only a Manager RUN advances
  // that column, while the pin moves through
  // GitOps. A consumer whose Application is absent — a finished suspend, a half-finished resume — earns
  // the NEUTRAL "not-deployed" and never "converged": nothing was compared (deploymentVerdict).
  const drift = driftOf({ targeted, deployed, sync, argoRead: argoRes.status === "fulfilled" });
  return { cluster, argo, drift, argocdUrl };
}

/** WHERE the consumer serves: `<label>.<stage apex>`, the one host its ingress renders, its
 *  admission policy admits and its DNS record names. Composed here rather than in the browser because the apex
 *  is not on the SQL row and cannot be derived from it: `clusters.domain` is where the CLUSTER is
 *  reached, while `global.unitApex` — read off that cluster's own values chain — is where its UNITS
 *  serve, and install.sh defaults the apex to the cluster FQDN minus its first label, so the two
 *  differ on every cluster that is not itself the apex.
 *
 *  Beside it `fqdn`: the domain the consumer answers at, at its stage, off its stage registration —
 *  "" where it carries none.
 *
 *  Fail-SOFT, unlike the offboard orphan scan which makes the same read and must fail closed: this
 *  answers a card, so an unreadable chain or registration yields null for its half and the card shows
 *  no address there. A composed guess would be a link to a name nothing serves. */
export async function readConsumerAddresses(
  registrations: Pick<Registrations, "readClusterValueFiles" | "readRegistration"> | undefined,
  row: { name: string; host: string; domain: string; stage: Stage },
): Promise<{ unitHost: string | null; fqdn: string | null }> {
  if (!registrations) return { unitHost: null, fqdn: null };
  const [unitHost, fqdn] = await Promise.all([
    registrations.readClusterValueFiles(row.domain, row.stage).then((chain) => consumerUnitHost(row.host, row.stage, unitApexFromChain(chain))).catch(() => null),
    registrations.readRegistration(row.stage, row.name).then((reg) => (reg === null ? null : reg.entry.fqdn ?? "")).catch(() => null),
  ]);
  return { unitHost, fqdn };
}
