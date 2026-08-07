import type { Hono } from "hono";
import { and, eq, inArray, notInArray } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import type { Executor } from "../../executor/executor.ts";
import type { CredentialStore } from "../../security/store.ts";
import { fingerprintSecret } from "../../security/fingerprint.ts";
import { apps, clusters, servers, tenants, tenantApps } from "../../db/schema/inventory.ts";
import { errNotConfigured, errNotFound, errValidation } from "../../kernel/errors.ts";
import { MASTER_ROLES, TENANT_SETTLED_STATUS, type Stage, type TenantStatus, type ArgoSync, type ArgoHealth } from "../../../shared/enums.ts";
import type { OrphanScanView, DetectedScanView, LiveArgoView, ConsumerLiveView, ConsumerLiveProbeView, TenantLiveView, ChannelStagesView } from "../../../shared/api-types.ts";
import { singleSourceRevision, targetedRevisionFor, type ClusterKubeResolver, type ArgoAppStatus } from "../../adapters/kube/port.ts";
import { tenantArgocdUrl } from "../../../shared/tenant.ts";
// The live reconciliation comparison — driftOf/the per-kind EXPECTED records/the consumer live probe —
// lives in live-recon.ts (one implementation for every card; this file stays the thin route layer).
import { driftOf, probeConsumerLive, readUnitHost, smokeTenant } from "./live-recon.ts";
import { getRunParams } from "../../executor/read.ts";
import type { PlatformRepo } from "../../adapters/git/port.ts";
import { OnboardRequest } from "./onboard.run.ts";
import { PurgeParams } from "./purge.run.ts";
import { AdoptConsumerParams } from "./adopt-consumer.run.ts";
import { RestoreParams, TenantRestoreParams } from "./restore.run.ts";
import { MigrateParams, TenantMigrateParams } from "./migrate.run.ts";
import { scanClusterOrphanConsumers, scanDetectedConsumers } from "./consumer-detected.ts";
// The channel ceiling is read from the ONE table in the platform repo, never restated here.
import { readChannelStages, CHANNEL_STAGES_PATH } from "../inventory/channel-stages.ts";
import type { Registry } from "./registry.ts";
import { CreateTenantRequest } from "./create-tenant.run.ts";
import { AddAppRequest } from "./add-app.run.ts";
import { TenantPurgeRequest, purgeLiveRefusal } from "./tenant-purge.run.ts";
import { assertTenantNotLive } from "./tenant-live-guard.ts";
import { scanOrphanTenants, resolveRunTenantState } from "./tenant-orphans.ts";
import type { TenantRegistry } from "./tenant-registry.ts";
import { memberApplication, memberNamespace, tenantApplicationSet, tenantNamespaces } from "./tenant-fanout.ts";
import { tenantSelector } from "./tenant-lifecycle.run.ts";
import type { AppCatalogProvider } from "./app-catalog.ts";
import type { Activator } from "../../adapters/activation/port.ts";
import { TENANT_COLUMNS } from "./tenant-columns.ts";
import { inviteOrResendTenantAdmin, TENANT_APP_SECRET, BOOTSTRAP_TOKEN_KEY, InviteAdminRequest } from "./tenant-admin-invite.ts";
import { tenantMemberHost } from "./unit-dns.ts";
import type { AppEnv } from "../../http/app-env.ts";

// Consumer API. Deliberately THIN: the onboard trigger and the lifecycle
// triggers create Runs, and everything after — the live gate/step log (SSE), approve, discard,
// cancel, retry, soft-delete — flows through the SAME kind-agnostic Runs API (/api/runs/:id/*).
// So the wizard POSTs here to get a runId, then watches /api/runs/:id/events and approves via
// /api/runs/:id/approve. When onboarding is not wired (the git/kube/vault/gate-runner adapters
// are absent), the mutating routes answer 501 NOT_CONFIGURED — the same degrade-loud contract as
// the Branches/Reset routes — while the read route (the consumer list) stays live.

export interface ConsumerApiDeps {
  executor: Executor;
  db: Db;
  /** True once the onboarding Run family is registered with its adapters (wire.ts). */
  onboardingEnabled: boolean;
}

/** The consumer routes additionally seal the operator's raw repo PAT before any run
 *  exists — the tenant routes never see a raw secret, so the store rides only here. */
export interface ConsumerOnboardApiDeps extends ConsumerApiDeps {
  store: CredentialStore;
  /** The platform GitOps repo — the channel-table read (GET /api/consumers/channels) serves
   *  global.channelStages LITERALLY from platform/values-common.yaml, so the controller keeps no
   *  copy of the one table the release pipeline enforces. Absent ⇒ the route answers 501. */
  platformRepo?: PlatformRepo;
  /** The per-cluster kube resolver — powers the per-consumer live reconciliation read
   *  (GET /api/consumers/:appId/live). Absent when onboarding is not configured (no adapters
   *  wired): the live endpoint then degrades to SQL-only, mirroring the 501 mutating routes. */
  resolver?: ClusterKubeResolver;
  /** The consumer registration registry — powers the operator-triggered DETECTED scan
   *  (GET /api/consumers/detected), which diffs the LIVE registrations/**
   *  against the inventory. The SAME Registry the consumer runs commit through, exactly as the tenant
   *  routes carry the TenantRegistry for their orphan scan. Absent when consumer onboarding is not
   *  wired ⇒ the scan route answers every list empty plus a `reason` instead of 501: it is a READ, and
   *  a read degrades. The CLUSTER half of that same scan needs `resolver` too, and degrades on its own
   *  when only that one is missing. */
  registry?: Registry;
}

// backup rides the same no-body shape: the run resolves everything off the appId, and the folder it
// leaves on the storage box is named after the unit.
// restart-workloads rides it too: no body either, and the run resolves the namespace off the appId.
const LIFECYCLE = ["offboard", "suspend", "resume", "restart-workloads", "backup"] as const;

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function registerConsumerRoutes(app: Hono<AppEnv>, deps: ConsumerOnboardApiDeps): void {
  const { executor, db, store, onboardingEnabled, resolver, registry, platformRepo } = deps;

  // The consumer inventory: every onboarded app + which cluster it runs on (apps.clusterId ->
  // clusters.domain/stage). provenance "controller" marks a consumer this Controller onboarded and
  // gate-validated, "adopted" one whose row was reconstructed from the registration — the same two
  // words the tenant projection below carries, so a reader compares the two lists on one vocabulary.
  app.get("/api/consumers", (c) =>
    c.json(
      db
        .select({
          id: apps.id,
          name: apps.name,
          clusterId: apps.clusterId,
          domain: clusters.domain,
          stage: clusters.stage,
          repoUrl: apps.repoUrl,
          chartPath: apps.chartPath,
          provenance: apps.provenance,
          status: apps.status,
          lastRunId: apps.lastRunId,
          createdAt: apps.createdAt,
        })
        .from(apps)
        .innerJoin(clusters, eq(apps.clusterId, clusters.id))
        .all(),
    ),
  );

  // The DETECTED scan (the consumer twin of GET /api/tenants/orphans), in TWO halves that answer
  // together and fail apart (consumer-detected.ts):
  //
  //   the REGISTRATION diff — every consumer the GitOps registrations know and the inventory does
  //   not: an onboard that died before record-inventory, or a registration committed by hand;
  //   the CLUSTER scan — every consumer NAMESPACE neither books account for. The diff above cannot
  //   express that state at all, because it starts from the registrations and this consumer has none:
  //   a removed registration whose workloads were never pruned serves on, invisible.
  //
  // Registered BEFORE /:appId/live so the static path is never shadowed, like the tenant statics
  // before /:id.
  //
  // EXPLICIT, never eager: this fetches every active cluster's install branch AND smokes every
  // consumer namespace on every active cluster, so it must stay an operator-triggered action — never
  // a page-load read.
  //
  // FAIL-SOFT like the tenant orphan route, and for the same honesty reasons documented there — but
  // per half, because one half's failure must never be told in the other's words. An unreadable
  // registration branch answers 200 with an EMPTY `detected` plus the failure text (`error`), which
  // the UI renders as "the scan itself failed", never as "none detected"; a broken registration lands
  // in `skipped`; a cluster that cannot be read lands in `unscanned` while the OTHER clusters still
  // report their orphans; no registry (consumer onboarding unwired) degrades the whole route to
  // `reason`. Every arm is `satisfies DetectedScanView` — the ONE declaration (shared/api-types.ts)
  // the browser's scanDetectedConsumers is typed by.
  app.get("/api/consumers/detected", async (c) => {
    if (!registry) return c.json({ detected: [], skipped: [], clusterOrphans: [], unscanned: [], reason: "onboarding-not-configured" } satisfies DetectedScanView);
    // The two halves are INDEPENDENT and are told apart on the wire, so they are settled apart here:
    // the registration diff can fail whole (its `error`), the cluster scan fails per cluster (its own
    // `unscanned`), and neither failure may empty the other's list or be told in the other's words.
    // Without a resolver there is no per-cluster client at all, so the cluster half simply produces
    // nothing — the same degrade the live probes take, and the panel says which half it lost.
    const cluster = resolver
      ? await scanClusterOrphanConsumers({ db, registry, resolver })
      : { clusterOrphans: [], unscanned: [] };
    try {
      const { detected, skipped } = await scanDetectedConsumers({ db, registry });
      return c.json({ detected, skipped, ...cluster } satisfies DetectedScanView);
    } catch (e) {
      return c.json({ detected: [], skipped: [], ...cluster, error: errText(e) } satisfies DetectedScanView);
    }
  });

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

  // Per-consumer reconciliation: the SQL row is a TRACE of what the Controller BELIEVES;
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
        id: apps.id, name: apps.name, clusterId: apps.clusterId, domain: clusters.domain,
        stage: clusters.stage, repoUrl: apps.repoUrl, status: apps.status,
      })
      .from(apps)
      .innerJoin(clusters, eq(apps.clusterId, clusters.id))
      .where(eq(apps.id, appId))
      .get();
    if (!found) throw errNotFound(`consumer ${appId}`);
    // Source (1): the SQL row — what the Controller BELIEVES (the TRACE). Echoed alongside the live
    // facts so the response is a self-contained FACT-vs-TRACE payload (repoUrl stays server-side only:
    // it is which repo the two revisions are resolved FOR, not something the card shows).
    const { repoUrl, ...row } = found;
    if (!resolver) return c.json({ row, unitHost: null, cluster: null, argo: null, drift: null, argocdUrl: null, reason: "onboarding-not-configured" } satisfies ConsumerLiveView);
    const [probe, unitHost] = await Promise.all([
      probeConsumerLive(db, resolver, { clusterId: row.clusterId, name: row.name, stage: row.stage, repoUrl }),
      readUnitHost(registry, row.name, row.domain, row.stage),
    ]);
    return c.json({ row, unitHost, ...probe } satisfies ConsumerLiveView);
  });

  // The onboard target picker: the clusters a consumer can be onboarded to — ALL active clusters,
  // including the master's self-cluster — the owner may onboard their OWN trusted apps to
  // it). The master self-cluster is seeded as a regular clusters row, so it appears here
  // dynamically from inventory — no cluster-name list anywhere; who qualifies is purely a row
  // question (status = active).
  app.get("/api/consumers/targets", (c) =>
    c.json(
      db
        .select({ id: clusters.id, domain: clusters.domain, stage: clusters.stage, tier: clusters.tier, status: clusters.status })
        .from(clusters)
        .where(eq(clusters.status, "active"))
        .all(),
    ),
  );

  // The channel table the onboard wizard reads: which stages a release channel may reach.
  // The source is LITERALLY the platform repo's platform/values-common.yaml → global.channelStages —
  // the ONE literal table, enforced in the release pipeline at the point that writes; the controller
  // carries NO copy, so a table change reaches the wizard without a controller release. Read off the
  // trunk (master): the install branches carry the same file, and the trunk is the copy every
  // cluster shares.
  app.get("/api/consumers/channels", async (c) => {
    if (!platformRepo) throw errNotConfigured(`the platform repo is not configured on this controller — the channel table lives in ${CHANNEL_STAGES_PATH}`);
    return c.json({ channelStages: await readChannelStages(platformRepo) } satisfies ChannelStagesView);
  });

  // Onboard: the streaming plan path. Returns { runId } immediately; the run sits in `planning`
  // while the gate-runner validates, streaming gate lines to /api/runs/:id/events, then settles
  // `planned` (approve to deploy) or `failed` (rejected, the full report frozen for inspection).
  app.post("/api/consumers", async (c) => {
    if (!onboardingEnabled) throw errNotConfigured("onboarding is not configured on this controller — the gate-runner and git/kube/vault adapters must be wired first");
    const parsed = OnboardRequest.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) throw errValidation(`invalid onboard request: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    // Seal the raw repo PAT BEFORE the run exists: planStreamed persists its raw params verbatim
    // (params_json), so only the sealed reference may enter the executor — the raw value lives in
    // the request body (TLS), the sealed store, and the Vault app tier, nowhere else.
    // Fail-closed: a seal failure is a thrown error, no run is created. The zod issues above carry
    // field paths + generic messages only, never the submitted value.
    const { repoPat, ...req } = parsed.data;
    const plaintext = Buffer.from(repoPat, "utf8");
    const fingerprint = fingerprintSecret(plaintext); // before seal() zeroes the buffer
    const ref = await store.seal({ kind: "pat", label: `consumer repo PAT (${req.consumerName})`, plaintext, fingerprint });
    return c.json(await executor.planStreamed("onboard", { ...req, repoCredentialId: ref.id }), 201);
  });

  // Lifecycle: offboard/suspend/resume plan synchronously (no gate-runner) — approve via the Runs API.
  for (const action of LIFECYCLE) {
    app.post(`/api/consumers/:appId/${action}`, async (c) => {
      if (!onboardingEnabled) throw errNotConfigured("onboarding is not configured on this controller");
      return c.json(await executor.plan(action, { appId: c.req.param("appId") }), 201);
    });
  }

  // Relocation with a target: restore rebuilds the unit from its Storage Box folder onto
  // the named cluster, migrate moves it there through the same folder. Both need the target, which no
  // row can answer, so they take a body — validated through the run's OWN params schema, one contract.
  for (const kind of ["restore", "migrate"] as const) {
    app.post(`/api/consumers/:appId/${kind}`, async (c) => {
      if (!onboardingEnabled) throw errNotConfigured("onboarding is not configured on this controller");
      const body = (await c.req.json().catch(() => ({}))) as { targetClusterId?: unknown };
      const schema = kind === "restore" ? RestoreParams : MigrateParams;
      const parsed = schema.safeParse({ appId: c.req.param("appId"), targetClusterId: body.targetClusterId });
      if (!parsed.success) throw errValidation(`invalid ${kind} request: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
      return c.json(await executor.plan(kind, parsed.data), 201);
    });
  }

  // Purge / force-offboard: remove a consumer's WHOLE footprint BY NAME even when NO inventory row
  // exists (an orphaned partial onboard — onboard writes the row last, so a failure at watch-sync/
  // smoke leaves the pointer/AppProject/namespace/Vault/mongo behind with no appId to offboard).
  // Keyed on name+stage+cluster (G1), NOT an appId, so it needs a body rather than a path :appId —
  // there may be no app row to name. Plans synchronously (no gate-runner); approve via the Runs API.
  app.post("/api/consumers/purge", async (c) => {
    if (!onboardingEnabled) throw errNotConfigured("onboarding is not configured on this controller");
    const parsed = PurgeParams.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) throw errValidation(`invalid purge request: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    return c.json(await executor.plan("purge", parsed.data), 201);
  });

  // Adopt: reconstruct a DETECTED consumer's missing apps row FROM its GitOps
  // pointer, via a Run with a live-cluster attest (adopt-consumer.run.ts). Keyed on name+stage+cluster
  // exactly like purge — there is no appId, that absence is the whole problem — so it takes a body,
  // not a path :appId. Plans synchronously (no gate-runner: nothing is deployed or validated, the only
  // mutation is the inventory row); approve via the Runs API.
  app.post("/api/consumers/adopt", async (c) => {
    if (!onboardingEnabled) throw errNotConfigured("onboarding is not configured on this controller");
    const parsed = AdoptConsumerParams.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) throw errValidation(`invalid adopt request: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    return c.json(await executor.plan("adopt-consumer", parsed.data), 201);
  });
}

// The tenant (multi-app) API — the SAME thin shape as
// the consumer routes above: a trigger creates a Run and everything after (the live gate/step log,
// approve, discard, retry) flows through the kind-agnostic Runs API (/api/runs/:id/*). create-tenant
// and add-app are the two validated triggers, so they POST through planStreamed (the streaming gate-
// by-gate planner) exactly like consumer onboard; remove-app + tenant-suspend/-resume/-offboard carry
// no gate-runner and plan synchronously. onboardingEnabled here is the TENANT family's flag
// (wire-onboarding's tenantEnabled) — when the catalog write PAT is absent the mutating
// routes answer 501 NOT_CONFIGURED while the read routes (the tenant list/detail) stay live.

/** One-line 400 mapping of a zod parse failure — the consumer route's inline shape, lifted to a
 *  helper for the tenant POSTs. Structurally typed over the issues so no zod value/type import leaks
 *  into this thin route module. */
function invalid(kind: string, err: { issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }> }): never {
  throw errValidation(`invalid ${kind} request: ${err.issues.map((i) => `${i.path.map(String).join(".")}: ${i.message}`).join("; ")}`);
}

/** The tenant fields the list/detail views project (JOIN clusters for domain/stage), mirroring the
 *  consumer list — the guid identity + suspend state instead of a repoUrl. */

// `refuseWhenProvisioning` names the action in the refusal message, or is null when the verb IS allowed
// on a tenant whose create-tenant run never finished. Only the removal verb is
// allowed: tenant-offboard's teardown is idempotent and copes with a half-deployed fan-out, so it is the
// clean way out, while suspend/resume flip a pointer that may never have been written at all.
const TENANT_LIFECYCLE = [
  { path: "offboard", kind: "tenant-offboard", refuseWhenProvisioning: null },
  { path: "suspend", kind: "tenant-suspend", refuseWhenProvisioning: "suspending it" },
  { path: "resume", kind: "tenant-resume", refuseWhenProvisioning: "resuming it" },
  { path: "restart-workloads", kind: "tenant-restart-workloads", refuseWhenProvisioning: "restarting its workloads" },
  { path: "backup", kind: "tenant-backup", refuseWhenProvisioning: "backing it up" },
] as const;

/** The two columns every provisional refusal needs; 404 when the tenant row is absent. */
export function loadTenantStatus(db: Db, id: string): { subdomain: string; status: TenantStatus } {
  const row = db.select({ subdomain: tenants.subdomain, status: tenants.status }).from(tenants).where(eq(tenants.id, id)).get();
  if (!row) throw errNotFound(`tenant ${id}`);
  return row;
}

/** Refuse an action that assumes a LIVE tenant when the tenant's create-tenant run never finished
 *. Since create-tenant now records its row BEFORE it deploys (record-provisional),
 *  a "provisioning" row means the tenant may have no namespace, no example-auth ingress and no fan-out at
 *  all — every such action would burn a watch timeout or hit a raw DNS/connect error and blame the wrong
 *  thing. SERVER-SIDE and unconditional: the Tenants UI hides these actions too, but a hidden button is a
 *  convenience, not a guard — this route is the only place the refusal actually holds. The message names
 *  the two ways out because they are genuinely the whole option set: finish the create-tenant run, or
 *  remove the tenant (offboard/purge). Modelled on the `suspended` refusal on the invite route. */
export function assertTenantProvisioned(t: { subdomain: string; status: TenantStatus }, action: string): void {
  if (t.status !== "provisioning") return;
  throw errValidation(
    `tenant ${t.subdomain} is still provisioning — its create-tenant run never finished, so it may not be deployed at all and ${action} would act on a tenant that is not there. Finish the create-tenant run, or offboard/purge the tenant.`,
  );
}

/** The tenant routes' deps: the consumer set + the OPTIONAL app-type catalog provider. The provider
 *  clones catalog to discover the create-tenant wizard's selectable app-types; it is absent when
 *  tenant onboarding is not wired (no catalog access), in which case the catalog route serves
 *  { apps: [] } and the wizard degrades — the SAME degrade-loud shape as the 501 mutating routes. */
export interface TenantApiDeps extends ConsumerApiDeps {
  appCatalog?: AppCatalogProvider;
  /** The per-cluster kube resolver — powers the per-tenant live reconciliation read
   *  (GET /api/tenants/:id/live), the tenant analogue of the consumer live endpoint. Absent when
   *  tenant onboarding is not configured (no adapters wired): the live endpoint then degrades to
   *  SQL-only (reason), mirroring the 501 mutating routes. */
  resolver?: ClusterKubeResolver;
  /** The ONE repo every tenant's charts live in (config.catalog.repoURL) — what a tenant has
   *  INSTEAD of a consumer's per-app repoUrl column, since a tenant's repo is a platform constant of
   *  the one-time catalog registration (shared/tenant.ts TenantEntrySchema). The live read needs
   *  it to ask the base Application which of its spec sources targets catalog, exactly as the
   *  consumer read asks with apps.repoUrl. Wired TOGETHER with `resolver` — both come from
   *  config.catalog (wire-onboarding buildTenantOnboarding), so they are present or absent
   *  together, and the live route degrades to SQL-only unless it has BOTH. */
  catalogRepoUrl?: string;
  /** The post-onboard activation client — powers the operator-driven first-admin invite/resend
   *  (POST /api/tenants/:id/invite-admin). The SAME HttpActivator the create-tenant `activate` step
   *  uses. Absent when tenant onboarding is not wired ⇒ the invite route answers 501, like the other
   *  mutating routes. */
  activator?: Activator;
  /** The catalog tenant pointer registry — powers the operator-triggered ORPHAN SCAN
   *  (GET /api/tenants/orphans), which diffs the LIVE pointers against the inventory. The SAME
   *  TenantRegistry the tenant runs commit through. Absent when tenant onboarding is not wired ⇒ the
   *  scan route answers { orphans: [], reason } instead of 501: it is a READ, and a read degrades. */
  registry?: TenantRegistry;
  /** The public apex (global.unitApex) of a cluster, read off its values chain on the platform repo —
   *  the SAME resolver the tenant runs carry (create-tenant.run.ts TenantOnboardPorts). The invite
   *  route needs it because a tenant member is addressed at `<member>.<subdomain>.<unitApex>` and the
   *  apex is nowhere on the tenants/clusters rows: `clusters.domain` is where the CLUSTER is reached,
   *  while the apex is where its UNITS serve. Absent when tenant onboarding is not wired ⇒ the invite
   *  route answers 501, like the other mutating routes. */
  resolveUnitApex?: (domain: string, stage: Stage) => Promise<string>;
}

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

export function registerTenantRoutes(app: Hono<AppEnv>, deps: TenantApiDeps): void {
  const { executor, db, onboardingEnabled, appCatalog, resolver, catalogRepoUrl, activator, registry, resolveUnitApex } = deps;

  // The tenant inventory: every onboarded tenant + which cluster it fans out on (JOIN clusters for
  // domain/stage). Always live — the read path never degrades on missing config.
  app.get("/api/tenants", (c) =>
    c.json(db.select(TENANT_COLUMNS).from(tenants).innerJoin(clusters, eq(tenants.clusterId, clusters.id)).all()),
  );

  // Per-tenant reconciliation — the tenant analogue of GET /api/consumers/:appId/live. The
  // SQL row is a TRACE of what the Controller BELIEVES; this reads the FACTS. A tenant fans out to N
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
    const row = {
      id: found.id, guid: found.guid, subdomain: found.subdomain, clusterId: found.clusterId,
      domain: found.domain, stage: found.stage, status: found.status, suspended: found.suspended,
    };
    // BOTH deps or none: the resolver reaches the cluster + ArgoCD, and the catalog URL is what
    // the pin is asked FOR (see TenantApiDeps). Without either there is no live answer to give, and a
    // half-answer here would mean pinning against the DB column — the very record-as-truth substitution this live read exists to avoid.
    if (!resolver || !catalogRepoUrl) return c.json({ row, cluster: null, argo: null, drift: null, argocdUrl: null, reason: "onboarding-not-configured" } satisfies TenantLiveView);

    const { clusterReader, argoReader, argoNamespace } = await resolver.resolve(found.clusterId);
    // The EXPECTED fan-out Application names from inventory (the faithful DB projection of the
    // registration): the trio always, then one <guid>-<app>-<stage> per
    // NOT-YET-SETTLED app row — via tenantApplicationSet, the single source of truth for names. The
    // filter mirrors tenantWatchSet's exactly (both project the same pointer, and both ask the one named
    // set TENANT_SETTLED_STATUS): a PROVISIONING app row belongs in the expected set, so a half-created
    // tenant's card honestly reports its missing members instead of rolling up a shrunken set and reading
    // Healthy, while an "offboarded" or "purged" row is genuinely gone.
    const appRows = db.select({ name: tenantApps.name }).from(tenantApps).where(and(eq(tenantApps.tenantId, found.id), notInArray(tenantApps.status, [...TENANT_SETTLED_STATUS]))).all();
    const members = [...found.members, ...appRows.map((a) => a.name)];
    const expectedApps = tenantApplicationSet(members, found.guid, found.stage);
    const namespaces = tenantNamespaces(members, found.guid);
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
      .innerJoin(servers, eq(servers.id, clusters.serverId))
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
    // The registration's pin AS ARGOCD SEES IT (what the auth member's catalog source targets).
    // Stays null until the argo read succeeds and that member exists; the DB row is only the fallback.
    let targeted: string | null = null;
    if (argoRes.status === "fulfilled") {
      const byName = argoRes.value;
      const statuses = expectedApps.map((n) => byName.get(n)).filter((s): s is ArgoAppStatus => s !== undefined);
      const rolled = rollupFanoutStatus(statuses);
      // The deployed-revision anchor: the AUTH member's synced revision. Every tenant has that member
      //, so the anchor is always nameable, and it carries the tenant's own chart from
      // catalog — read via singleSourceRevision, which prefers the singular
      // `status.sync.revision` and falls back to the sole entry of `status.sync.revisions[]` for a
      // source expressed inside a one-element `.spec.sources` array. A Missing member has neither ⇒ null.
      const authStatus = byName.get(authApp);
      deployed = authStatus ? singleSourceRevision(authStatus) : null;
      // The PIN, asked per repo — the same question the consumer route asks with apps.repoUrl, put to
      // the tenant's platform-constant repo instead. Asking (rather than taking source 0) is what keeps
      // this correct now that every member Application is multi-source: its chart comes from
      // catalog and its `$values` chain from hostyour-cloud, so source 0 would answer about the
      // wrong repo, exactly the defect the consumer path already fixed.
      targeted = authStatus ? targetedRevisionFor(authStatus, catalogRepoUrl) : null;
      argo = { ok: true, sync: rolled.sync, health: rolled.health, syncRevision: deployed };
    } else {
      argo = { ok: false, error: errText(argoRes.reason) };
    }

    // The high-value comparison: what the auth member TARGETS vs what it RUNS, both read off the CR
    // itself (no git call). There is no third source to fall back on: the registration states no
    // revision and the tenants row records none either, so a comparison is offered exactly where ArgoCD
    // gave both halves. A SUSPENDED tenant keeps every member Application by design, so it goes on
    // being compared exactly like an active one.
    const drift = driftOf({ targeted, deployed, argoRead: argoRes.status === "fulfilled" });
    return c.json({ row, cluster, argo, drift, argocdUrl } satisfies TenantLiveView);
  });

  // The tenant target picker: the clusters a tenant can be created on — every ACTIVE cluster,
  // whatever role it carries. Placement is not a function of the role; a tenant runs on a slave and
  // equally on a master+slave. The same list the consumer picker offers, and the create-tenant plan
  // re-checks `active` itself (resolveCluster), so this route is the UI convenience it always was.
  app.get("/api/tenants/targets", (c) =>
    c.json(
      db
        .select({ id: clusters.id, domain: clusters.domain, stage: clusters.stage, tier: clusters.tier, status: clusters.status })
        .from(clusters)
        .where(eq(clusters.status, "active"))
        .all(),
    ),
  );

  // The create-tenant wizard's app-type CATALOG: the app-types the picker can offer, DISCOVERED from
  // catalog charts/example-engine/values-<app>.yaml (app-catalog.ts) — never a hardcoded list —
  // so a selected name is always one the T4 "apps resolved" gate will accept. A READ route: always
  // live, registered BEFORE /:id so the static path is not captured by the param route. FAIL-SOFT — the
  // provider caches with a short TTL and returns [] on any clone/read error, and no provider (tenant
  // onboarding not wired) is likewise { apps: [] }; the request's abort signal cancels an in-flight clone.
  app.get("/api/tenants/app-catalog", async (c) =>
    c.json({ apps: appCatalog ? await appCatalog.list(c.req.raw.signal) : [] }),
  );

  // The ORPHAN SCAN: every tenant the GitOps pointers know and the inventory does
  // not — the ONLY way an operator ever learns an orphan's guid, which is minted by the plan and typed
  // by nobody (tenant-orphans.ts). Registered BEFORE /:id so the static path is not captured by the
  // param route, like app-catalog above.
  //
  // EXPLICIT, never eager: this CLONES catalog and scans all three stages, so it must stay an
  // operator-triggered action — firing it on every Tenants page load would clone the repo behind the
  // operator's back on a screen that otherwise reads pure SQL.
  //
  // FAIL-SOFT like the app-catalog route: a broken/drifted pointer does not wedge the scan, and an
  // unreachable catalog answers 200 with an EMPTY list plus the failure text rather than an error
  // status — the Tenants page must never break on a git hiccup. The `error` field is NOT cosmetic: a
  // silent empty list would read as "no orphans found", the exact opposite of the truth, so the caller
  // renders the failure instead of the (unknown) result. With no registry (tenant onboarding unwired) it
  // degrades to { orphans: [], skipped: [], reason } — the read routes' contract.
  //
  // `skipped` applies that same honesty PER REGISTRATION: every registrations/<guid>/<stage>.yaml the
  // scan could not read comes back with its directory guid + the reason, because one dropped inside the
  // scan would make an empty `orphans` read as "everything is fine" for a tenant nobody can even see.
  //
  // Every arm is `satisfies OrphanScanView` — the ONE declaration of this body (shared/api-types.ts),
  // the same one the browser's scanTenantOrphans is typed by. The envelope is built HERE, in three
  // separate literals, so without that check a renamed field or a mistyped `reason` in any one of them
  // would reach the UI as an absent value and render as an all-clear.
  app.get("/api/tenants/orphans", async (c) => {
    if (!registry) return c.json({ orphans: [], skipped: [], reason: "onboarding-not-configured" } satisfies OrphanScanView);
    try {
      const { orphans, skipped } = await scanOrphanTenants({ db, registry });
      return c.json({ orphans, skipped } satisfies OrphanScanView);
    } catch (e) {
      return c.json({ orphans: [], skipped: [], error: errText(e) } satisfies OrphanScanView);
    }
  });

  // WHAT ONE create-tenant run's tenant IS RIGHT NOW — the guid its plan froze, resolved against the
  // inventory (resolveRunTenantState, tenant-orphans.ts). It is the PRECISE discovery path straight off
  // the run, and the only one that covers a failure between apply-appproject and write-pointer (no
  // pointer was ever committed, so the scan above structurally cannot see it).
  //
  // The params are read through the executor's narrow accessor (read.ts getRunParams) and PROJECTED to
  // the four target fields + the three row fields the run screen renders: the raw params stay
  // server-side, because they also carry the operator's adminEmail (PII, CreateTenantParams).
  //
  // The tenants ROW — not the run's kind + status — is what decides the answer, and that is the whole
  // point of this route: `activate` is create-tenant's LAST step by design, so a run that failed only
  // there stands behind a tenant that is deployed, recorded active and serving. Only the row can tell
  // the two apart, so only the row may decide whether the screen offers a purge (RunTenantStateView,
  // shared/api-types.ts — the one declaration this route's body and the run screen are both typed by,
  // which is why no `satisfies` is needed here: resolveRunTenantState RETURNS that type).
  // Where there is NO row the run's own step rows decide instead — a run refused at attest-target
  // deployed nothing, a run that died mid-deploy may have left the whole footprint, and both are
  // row-less. A run of any other kind is a caller error (400).
  app.get("/api/tenants/runs/:runId/tenant-state", (c) => {
    const runId = c.req.param("runId");
    const run = getRunParams(db, runId);
    if (!run) throw errNotFound(`run ${runId}`);
    if (run.kind !== "create-tenant") {
      throw errValidation(`run ${runId} is a ${run.kind} run — only a create-tenant run mints a tenant of its own`);
    }
    return c.json(resolveRunTenantState(db, runId, run.params));
  });

  // One tenant + its per-app rows (the guid × apps[] matrix). 404 when the tenant row is absent.
  app.get("/api/tenants/:id", (c) => {
    const id = c.req.param("id");
    const tenant = db.select(TENANT_COLUMNS).from(tenants).innerJoin(clusters, eq(tenants.clusterId, clusters.id)).where(eq(tenants.id, id)).get();
    if (!tenant) throw errNotFound(`tenant ${id}`);
    const appRows = db
      .select({ id: tenantApps.id, name: tenantApps.name, status: tenantApps.status, lastRunId: tenantApps.lastRunId, createdAt: tenantApps.createdAt })
      .from(tenantApps)
      .where(eq(tenantApps.tenantId, id))
      .all();
    return c.json({ ...tenant, apps: appRows });
  });

  // Create tenant: the streaming plan path (identical contract to consumer onboard). Returns { runId }
  // immediately; the run sits in `planning` while the T1..T4 fan-out gates validate, streaming gate
  // lines to /api/runs/:id/events, then settles `planned` (approve to deploy) or `failed` (rejected).
  app.post("/api/tenants", async (c) => {
    if (!onboardingEnabled) throw errNotConfigured("tenant onboarding is not configured on this controller — the catalog write PAT must be wired first");
    const parsed = CreateTenantRequest.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) invalid("create-tenant", parsed.error);
    return c.json(await executor.planStreamed("create-tenant", parsed.data), 201);
  });

  // Add app: fan ONE new app into a LIVE tenant — also streaming (a subset validation at the tenant's
  // existing pin). tenantId comes from the path, the new app name from the body.
  app.post("/api/tenants/:id/apps", async (c) => {
    if (!onboardingEnabled) throw errNotConfigured("tenant onboarding is not configured on this controller");
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const parsed = AddAppRequest.safeParse({ ...body, tenantId: c.req.param("id") });
    if (!parsed.success) invalid("add-app", parsed.error);
    // A tenant that is still provisioning has no finished fan-out to add an app TO: add-app's planner
    // reads the tenant's LIVE registration and its watch waits on the new Application, so on a
    // half-created tenant it would either 404 on the absent pointer or burn the argo timeout. Refuse
    // here, before a Run is even planned. (The suspended case is refused by add-app's own planner,
    // which reads that fact off the pointer; "provisioning" is a ROW fact, so it is refused here.)
    assertTenantProvisioned(loadTenantStatus(db, parsed.data.tenantId), "adding an app");
    return c.json(await executor.planStreamed("add-app", parsed.data), 201);
  });

  // Remove app: drop ONE app of the guid × apps[] matrix — synchronous plan() (no gate-runner). The
  // app name is a path segment; the tenant + trio + base stay. Refused on a provisioning tenant for the
  // same reason add-app is: the drop is a pointer edit and the prune watch waits on that app's
  // Application, neither of which exists on a tenant whose create-tenant run never wrote the pointer.
  app.post("/api/tenants/:id/apps/:app/remove", async (c) => {
    if (!onboardingEnabled) throw errNotConfigured("tenant onboarding is not configured on this controller");
    const id = c.req.param("id");
    assertTenantProvisioned(loadTenantStatus(db, id), `removing the app "${c.req.param("app")}"`);
    return c.json(await executor.plan("remove-app", { tenantId: id, app: c.req.param("app") }), 201);
  });

  // (Re)send the tenant's first-admin invite — the operator-driven Tenants-page action. Unlike the
  // lifecycle routes this is a DIRECT synchronous call (no Run, no GitOps): it reads the tenant's
  // bootstrap token from the Secret on the target slave and invites-or-resends over the tenant's OWN
  // example-auth, returning the activate_url + mail outcome INLINE. It exists because the create-tenant
  // `activate` step's invite is single-shot (409 once the admin was invited) — this resends when the
  // first mail failed. adminEmail is transient PII: used only for the invoke, never persisted (the
  // inventory has no email column) and never logged; the returned activate_url is a credential the
  // caller shows once and stores nowhere.
  app.post("/api/tenants/:id/invite-admin", async (c) => {
    if (!onboardingEnabled) throw errNotConfigured("tenant onboarding is not configured on this controller");
    // resolver reads the bootstrap Secret; resolveUnitApex answers WHERE the tenant's auth serves;
    // activator makes the call. Any of the three absent ⇒ onboarding unwired.
    if (!resolver || !activator || !resolveUnitApex) throw errNotConfigured("tenant admin invite requires the cluster resolver + apex resolver + activation client");
    const parsed = InviteAdminRequest.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) invalid("invite-admin", parsed.error);
    const id = c.req.param("id");
    const found = db.select(TENANT_COLUMNS).from(tenants).innerJoin(clusters, eq(tenants.clusterId, clusters.id)).where(eq(tenants.id, id)).get();
    if (!found) throw errNotFound(`tenant ${id}`);
    // A tenant whose create-tenant run never finished may have no example-auth at all (and certainly no
    // bootstrap Secret), so the invite is refused before the token read — see assertTenantProvisioned.
    assertTenantProvisioned(found, "inviting the admin");
    // A suspended tenant renders no Ingress and runs no pods, so the invoke would only hit a transport
    // error — refuse early with a clear reason (resume first) instead of a raw DNS/connect failure.
    if (found.suspended) throw errValidation(`tenant ${found.subdomain} is suspended — its auth ingress is down; resume it before inviting the admin`);
    // The bootstrap Secret lives in the AUTH member's own namespace — the member that consumes it.
    const ns = memberNamespace(found.guid, found.identityProvider);
    const { clusterReader } = await resolver.resolve(found.clusterId);
    const token = await clusterReader.readSecretValue(ns, TENANT_APP_SECRET, BOOTSTRAP_TOKEN_KEY);
    if (!token) throw errValidation(`the tenant bootstrap token (Secret ${TENANT_APP_SECRET} key ${BOOTSTRAP_TOKEN_KEY}) is absent in ${ns} — cannot invite the first admin`);
    // WHERE the tenant's own example-auth serves: auth.<subdomain>.<unitApex>, the host its ingress
    // renders and the tenant's wildcard record covers. The apex comes off the target cluster's values
    // chain, never off `found.domain` — that column is where the CLUSTER is reached, and install.sh
    // defaults the apex to the cluster FQDN minus its first label, so composing from the domain posts
    // the bootstrap token at a host nothing serves.
    const result = await inviteOrResendTenantAdmin({
      activator,
      token,
      authFqdn: tenantMemberHost(found.identityProvider, found.subdomain, await resolveUnitApex(found.domain, found.stage)),
      email: parsed.data.email,
      signal: c.req.raw.signal,
    });
    return c.json(result);
  });

  // Tenant lifecycle: offboard/suspend/resume plan synchronously (no gate-runner) — approve via the
  // Runs API. Mirrors the consumer lifecycle loop; the kind is the tenant-scoped run kind. suspend and
  // resume additionally refuse a tenant still provisioning (see TENANT_LIFECYCLE); offboard deliberately
  // does not — it is the way OUT of that state.
  for (const { path, kind, refuseWhenProvisioning } of TENANT_LIFECYCLE) {
    app.post(`/api/tenants/:id/${path}`, async (c) => {
      if (!onboardingEnabled) throw errNotConfigured("tenant onboarding is not configured on this controller");
      const id = c.req.param("id");
      if (refuseWhenProvisioning !== null) assertTenantProvisioned(loadTenantStatus(db, id), refuseWhenProvisioning);
      return c.json(await executor.plan(kind, { tenantId: id }), 201);
    });
  }

  // Tenant relocation with a target: tenant-restore rebuilds the whole bracket from its
  // Storage Box folder onto the named cluster, tenant-migrate moves it there through the same folder.
  // Validated through the run's OWN params schema — one contract, exactly like the consumer routes.
  for (const { path, kind, refuse } of [
    { path: "restore", kind: "tenant-restore", refuse: "restoring it" },
    { path: "migrate", kind: "tenant-migrate", refuse: "moving it" },
  ] as const) {
    app.post(`/api/tenants/:id/${path}`, async (c) => {
      if (!onboardingEnabled) throw errNotConfigured("tenant onboarding is not configured on this controller");
      const id = c.req.param("id");
      assertTenantProvisioned(loadTenantStatus(db, id), refuse);
      const body = (await c.req.json().catch(() => ({}))) as { targetClusterId?: unknown };
      const schema = kind === "tenant-restore" ? TenantRestoreParams : TenantMigrateParams;
      const parsed = schema.safeParse({ tenantId: id, targetClusterId: body.targetClusterId });
      if (!parsed.success) invalid(kind, parsed.error);
      return c.json(await executor.plan(kind, parsed.data), 201);
    });
  }

  // Tenant purge / force-offboard: remove a tenant's WHOLE footprint BY GUID even when NO inventory row
  // exists (an ORPHAN — see tenant-purge.run.ts), and the only verb that also destroys the crypto entry and
  // the namespace, which the pointer-driven offboard leaves standing on a half-created tenant.
  // Keyed on guid+stage+cluster, NOT a path :id — there may be no tenant row to name — so it
  // takes a body, exactly like the consumer purge. Unlike that one it plans through planStreamed: the
  // teardown target (the fan-out watch set) can only be read off the LIVE registration the first step
  // git-rm's, so it must be resolved and frozen BEFORE the run starts (tenant-purge.run.ts). Approve via
  // the Runs API, like every other plan.
  app.post("/api/tenants/purge", async (c) => {
    if (!onboardingEnabled) throw errNotConfigured("tenant onboarding is not configured on this controller");
    const parsed = TenantPurgeRequest.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) invalid("tenant-purge", parsed.error);
    // The one refusal this destructive verb owes the sibling verbs' guarantee: a tenant the inventory
    // still calls live, whose pointer still stands, is DEPLOYED — offboard removes such a tenant, purge
    // would deprovision it. Asked here so the operator is refused immediately, before a Run exists — and
    // asked AGAIN, from the same rule, in the run's own attest-target step (tenant-purge.run.ts), because
    // this end alone does not hold: a purge legitimately planned against a "provisioning" row stays
    // approvable while a create-tenant retry settles that row to "active", and approve re-validates
    // nothing. A hidden button is a convenience; ONE rule asked at BOTH ends is the guard.
    await assertTenantNotLive(db, registry, parsed.data, purgeLiveRefusal(parsed.data));
    return c.json(await executor.planStreamed("tenant-purge", parsed.data), 201);
  });
}
