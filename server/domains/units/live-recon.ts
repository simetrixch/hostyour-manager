// The LIVE RECONCILIATION comparison — the one place the product answers "does what the cluster RUNS
// match what the GitOps pointer PINS?". Factored out of api.ts (which stays the thin route layer)
// because THREE surfaces now answer through it: the consumer row card (GET /api/consumers/:appId/live),
// the tenant card (GET /api/tenants/:id/live, which calls driftOf below), and the name-keyed detected
// probe (GET /api/consumers/live). One implementation is the whole guarantee
// that no two cards can ever describe the same live situation differently.
import { eq, inArray } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { clusters, servers } from "../../db/schema/inventory.ts";
import { MASTER_ROLES, type Stage, type DriftVerdict, type ArgoSync } from "../../../shared/enums.ts";
import type { LiveArgoView, LiveDriftView, ConsumerLiveProbeView } from "../../../shared/api-types.ts";
import { syncedRevisionFor, targetedRevisionFor, type ClusterKubeResolver, type ClusterReader, type SmokeResult } from "../../adapters/kube/port.ts";
import { consumerArgoAppName, consumerArgocdUrl, consumerNamespace } from "../../../shared/consumer.ts";
import type { ClusterValueFile } from "../../../shared/cluster-values.ts";
import { unitApexFromChain } from "./admission-policy.ts";
import { consumerUnitHost } from "#unit/server/unit-dns.ts";

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

/** The revision block of a live card: `pinned` is what the unit's chart source TARGETS as ArgoCD sees it
 *  — the delivery branch for a consumer, the books branch for a tenant, a SHA only where a pin says one
 *  — `deployed` is the commit ArgoCD synced from that source, and `verdict` is ArgoCD's own comparison
 *  of the two (deploymentVerdict). There is no second source and no fallback: the registration states
 *  no revision, and the revision the delivery branch stands on is the release cycle's to write. A unit
 *  whose Application cannot be read has nothing targeted, and that is what the card then says rather
 *  than promoting a Manager-side guess to a pin. `argoRead` says whether ArgoCD answered AT ALL. */
export function driftOf(input: { targeted: string | null; deployed: string | null; sync: ArgoSync | null; argoRead: boolean }): LiveDriftView {
  const { targeted, deployed, sync, argoRead } = input;
  return {
    pinned: targeted,
    deployed,
    verdict: deploymentVerdict({ pinned: targeted, deployed, sync, argoRead }),
  };
}

/** The ONE deployment question: does what the cluster RUNS match what the Application TARGETS?
 *  (DRIFT_VERDICT, shared/enums.ts.) The answer is ARGOCD'S OWN COMPARISON, `status.sync.status`, and
 *  never a string comparison of the two revisions: what a consumer Application targets is the delivery
 *  BRANCH `deploy/<stage>` (a literal, by design — the registration pins no revision, the release
 *  cycle moves the branch), and what it runs is a commit, so `deployed === pinned` was false on every
 *  converged consumer and painted every card "drift" (hostyour-manager#141). ArgoCD resolved the branch
 *  when it compared; Synced means the cluster carries that head, OutOfSync means it does not.
 *
 *  "unknown" comes first because an unread ArgoCD leaves both revisions unknown rather than absent, so
 *  it must not fall through to a claim about them; "not-deployed" is the neutral answer where there is
 *  no Application at all — nothing targeted, nothing running, nothing compared (a suspended consumer,
 *  or a resume that died before its Application existed) — and never "converged", which is a
 *  statement about a comparison that must have taken place. One side missing is drift: a source that
 *  targets nothing of the unit's own repository any more (a foreign source written over the pin) or a
 *  target nothing has been synced from yet. A sync status ArgoCD itself calls Unknown (the repository
 *  unreachable, the comparison not made) is reported as exactly that. */
function deploymentVerdict(input: { pinned: string | null; deployed: string | null; sync: ArgoSync | null; argoRead: boolean }): DriftVerdict {
  const { pinned, deployed, sync, argoRead } = input;
  if (!argoRead) return "unknown";
  if (pinned === null && deployed === null) return "not-deployed";
  if (pinned === null || deployed === null) return "drift";
  if (sync === "Synced") return "converged";
  if (sync === "OutOfSync") return "drift";
  return "unknown";
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
 *  Fail-SOFT, unlike the offboard orphan scan which makes the same read and must fail closed: this
 *  answers a card, so an unreadable chain yields null and the card shows no address at all. A composed
 *  guess would be a link to a name nothing serves. */
export async function readUnitHost(
  registrations: { readClusterValueFiles(domain: string, stage: Stage): Promise<readonly ClusterValueFile[]> } | undefined,
  host: string,
  domain: string,
  stage: Stage,
): Promise<string | null> {
  if (!registrations) return null;
  try {
    return consumerUnitHost(host, stage, unitApexFromChain(await registrations.readClusterValueFiles(domain, stage)));
  } catch {
    return null;
  }
}
