// The live reconciliation reads, apart from api-types.ts the way api-types-onboard.ts stands apart:
// the envelope of GET /api/consumers/:appId/live and GET /api/tenants/:id/live, shared by both ends.
import type { Stage, TenantStatus, AppStatus, ArgoSync, ArgoHealth, DriftVerdict } from "./enums.ts";

/* ---- The LIVE RECONCILIATION reads: GET /api/consumers/:appId/live and GET /api/tenants/:id/live ----
 *
 * The SQL row is a TRACE of what the Manager BELIEVES; these two routes read the FACTS beside it —
 * a live cluster smoke (source 2) and the ArgoCD status (source 3) — and compare them. Both answer in
 * the SAME four-part envelope (row / cluster / argo / drift + the ArgoCD deep-link), so the three parts
 * that are IDENTICAL between them are declared ONCE below and shared by both, and by both ends.
 *
 * WHY these live here and not in the route module with a hand-written browser twin.
 * The server declared the `argo` union once and used it for both routes; the browser restated it TWICE
 * by hand and narrowed on `.ok`. That is the same arrangement that already shipped a crash: a member
 * added server-side to the run-tenant-state union fell through the browser's ternary chain into an arm
 * that read a field the new state does not carry, and the TypeError unmounted the whole Run screen (the
 * long note at RunTenantState in api-types.ts tells that story). Nothing links a mirror to its original, so `npm run check`
 * stays green while the two drift. Declared here, a member added to LiveArgoView breaks the browser's
 * narrowing at compile time — which is the only kind of guarantee worth having. */

/** One workload of a live cluster smoke (the server's SmokeResult.workloads[] entries). */
export interface WorkloadStatusView {
  kind: string;
  name: string;
  available: boolean;
  /** Replicas asked for / actually up. A workload switched off by a suspend reads 0 of 0, which is
   *  "available" — so the counts are what tells a paused unit from a running one. */
  desired: number;
  ready: number;
  message?: string;
}

/** The cluster FACTS one live read surfaces (source 2 — the namespace smoke), or the read's OWN
 *  failure. `ok:false` is per-SOURCE on purpose: the two live reads are fanned with allSettled, so an
 *  unreachable slave spins only this half and the ArgoCD half still answers. */
export type LiveClusterView =
  | { ok: true; namespaceExists: boolean; workloads: WorkloadStatusView[]; externalSecretsReady: boolean }
  | { ok: false; error: string };

/** The ArgoCD FACTS one live read surfaces (source 3), or the read's own failure — same per-source
 *  honesty as LiveClusterView. For a consumer these are its ONE Application's; for a tenant they are
 *  the whole fan-out ROLLED UP (Synced only if every member is Synced, health worst-of). */
export type LiveArgoView =
  | { ok: true; sync: ArgoSync; health: ArgoHealth; syncRevision: string | null; message?: string }
  | { ok: false; error: string };

/** The two revisions a live read compares, and the verdict over them. The whole point of the panel:
 *  what the pointer PINS and what the cluster RUNS.
 *
 *  `pinned` is read off the Application's own spec (targetedRevisionFor, adapters/kube/port.ts) — the
 *  pointer's pin AS ARGOCD SEES IT, per repo. `deployed` is what Argo last synced.
 *
 *  On a unit whose pointer deliberately generates NO Application — a SUSPENDED or offboarded consumer,
 *  a settled tenant — `pinned` is null, so the pair reads "pinned none · deployed none". There is no
 *  Manager-side record to fall back on and there must not be one: calling that absence drift reported
 *  the success condition of an approved action as a defect. A tenant SUSPEND is
 *  not such a case at all — its base Application survives by design, so it keeps both revisions and goes
 *  on being compared. What a unit with neither revision reads is not "converged" but the fourth verdict,
 *  "not-deployed": see `verdict` below for why the difference is the whole point.
 *
 *  `verdict` — does what RUNS match what is PINNED? FOUR answers (DRIFT_VERDICT, shared/enums.ts), two
 *  of which are neutral non-verdicts rather than a green claim: "unknown" when ArgoCD could not be read
 *  at all (painting "couldn't read ArgoCD" as "has drifted" would turn a FACT panel into a liar), and
 *  "not-deployed" when nothing is pinned AND nothing runs, i.e. when no comparison happened at all.
 *  "converged" is a statement ABOUT a comparison, so it may only be given when one actually took place —
 *  and the state a green claim would rest on is reachable BOTH by a finished suspend and by a lifecycle run
 *  that died half-way (see driftOf), which is exactly why the honest answer there is the one that asserts
 *  nothing. */
export interface LiveDriftView {
  pinned: string | null;
  deployed: string | null;
  verdict: DriftVerdict;
}

/** The LIVE half of one consumer's reconciliation read — cluster/argo/drift + the deep-link, WITHOUT
 *  the inventory row, because one consumer surface has no row to echo: GET /api/consumers/live, the
 *  NAME-keyed probe (clusterId + name + stage) the Detected panel renders for a consumer the inventory
 *  does not know. Both routes answer through the server's ONE probe
 *  implementation (probeConsumerLive, server/domains/units/api.ts), so the two cards can never
 *  answer the same situation differently. `cluster`/`argo`/`drift` are null TOGETHER when onboarding is
 *  not configured (`reason` set) — the same degrade-loud contract the 501 mutating routes follow. */
export interface ConsumerLiveProbeView {
  cluster: LiveClusterView | null;
  argo: LiveArgoView | null;
  drift: LiveDriftView | null;
  /** Server-derived ArgoCD UI deep-link for this consumer's Application (argo.<masterFqdn> for the
   *  master, argo-<slave>.<masterFqdn> for a slave). null when the master FQDN is unknown or onboarding
   *  is not configured — render no link then. Present even when `argo` is `ok:false` (a down ArgoCD is
   *  exactly when the operator wants to click through). */
  argocdUrl: string | null;
  reason?: "onboarding-not-configured";
}

/** GET /api/consumers/:appId/live — the FACTS beside the consumer row's TRACE. Loaded LAZILY per row
 *  by the Consumers reconciliation tab (a slow/unreachable slave spins only its own card). The live
 *  half is ConsumerLiveProbeView above; this row-keyed route additionally echoes the row. */
export interface ConsumerLiveView extends ConsumerLiveProbeView {
  /** Where this consumer SERVES: `<host>.<stage apex>` — the one host its ingress renders, its
   *  admission policy admits and its DNS record names. The apex is the target cluster's own
   *  (`global.unitApex` off that cluster's values chain) and is NOT the cluster's domain, so the
   *  browser cannot compose this from the row and is handed the finished host instead. Null when the
   *  chain could not be read; the card then shows no address rather than a name that resolves
   *  nowhere. */
  unitHost: string | null;
  /** The domain the consumer answers at beside `unitHost`, off its stage registration: "" where it has
   *  none, null where the registration could not be read — the card then offers no domain action. */
  fqdn: string | null;
  /** Whether the stage registration is quiesced (access closed: zero replicas, no Ingress), off the same read as
   *  fqdn; null where it could not be read. */
  quiesced: boolean | null;
  /** Source (1): the SQL row — what the Manager BELIEVES, echoed beside the live facts so the
   *  payload is self-contained. The private repoUrl is deliberately NOT part of it: it is read
   *  server-side to resolve the drift comparison per repo, and never leaves the server. */
  row: {
    id: string;
    name: string;
    /** The public host label the row attests (`host` of the manifest, or the name). */
    host: string;
    clusterId: string;
    domain: string;
    stage: Stage;
    status: AppStatus;
  };
}

/** GET /api/tenants/:id/live — the tenant analogue of ConsumerLiveView. A tenant fans out to MANY
 *  Applications across one namespace per member, so `cluster` folds a smoke of each of them and `argo` is
 *  the whole fan-out rolled up, while `drift` compares the BASE Application's targeted and synced
 *  revision against each other. Same null-together degrade, same per-source `ok:false`. */
export interface TenantLiveView {
  row: {
    id: string;
    guid: string;
    subdomain: string;
    clusterId: string;
    domain: string;
    stage: Stage;
    status: TenantStatus;
    suspended: boolean;
    /** Off the stage registration, as on ConsumerLiveView; null where it could not be read. */
    quiesced: boolean | null;
  };
  cluster: LiveClusterView | null;
  argo: LiveArgoView | null;
  drift: LiveDriftView | null;
  argocdUrl: string | null;
  reason?: "onboarding-not-configured";
}
