import type { Hono } from "hono";
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import type { Executor } from "../../executor/executor.ts";
import type { CredentialStore } from "../../security/store.ts";
import type { GitHubApp } from "../../adapters/github-app/port.ts";
import { resolveRepoCredentialId, resolveRepoIdentity } from "#unit/server/repo-identity.ts";
import { readOwnerIdentity } from "#unit/server/owners.ts";
import { apps, clusters, servers, tenants, tenantApps } from "../../db/schema/inventory.ts";
import { errNotConfigured, errNotFound, errValidation } from "../../kernel/errors.ts";
import { SLAVE_ROLES, type Stage } from "../../../shared/enums.ts";
import type { OrphanScanView, DetectedScanView, VersionsView } from "../../../shared/api-types.ts";
import type { LineMoveView } from "../../../shared/api-types-line-move.ts";
import type { ChannelStagesView, CiOnlyUnitView } from "../../../shared/api-types-onboard.ts";
import type { ClusterKubeResolver } from "../../adapters/kube/port.ts";
import { errText } from "./live-recon.ts";
import { getRunParams } from "../../executor/read.ts";
import type { PlatformRepo } from "../../adapters/git/port.ts";
import { OnboardRequest } from "./onboard.run.ts";
import { CiOnlyPlanRequest } from "./onboard-ci-only.ts";
import { OffboardCiOnlyParams } from "./offboard-ci-only.run.ts";
import { PurgeParams } from "./purge.run.ts";
import { AdoptConsumerParams } from "./adopt-consumer.run.ts";
import { RestoreParams, TenantRestoreParams } from "./restore.run.ts";
import { MigrateParams, TenantMigrateRequest } from "./migrate.run.ts";
import { assertTenantProvisioned, loadTenantStatus } from "./tenant-provisioned.ts";
import { registerTenantActionRoutes } from "./api-tenant-actions.ts";
import { registerConsumerDomainRoutes } from "./api-consumer-domain.ts";
import { registerConsumerLiveRoutes, registerTenantLiveRoutes } from "./api-live.ts";
import { invalid } from "./api-invalid.ts";
import { scanClusterOrphanConsumers, scanDetectedConsumers } from "./consumer-detected.ts";
// The channel ceiling is read from the ONE table in the platform repo, never restated here.
import { readChannelStages, CHANNEL_STAGES_PATH } from "../inventory/channel-stages.ts";
import type { Registrations } from "#unit/server/registrations.ts";
import { CreateTenantRequest } from "./create-tenant.run.ts";
import { AddAppRequest } from "./add-app-request.ts";
import { TenantPurgeRequest, purgeLiveRefusal } from "./tenant-purge.run.ts";
import { assertTenantNotLive } from "./tenant-live-guard.ts";
import { scanOrphanTenants, resolveRunTenantState } from "./tenant-orphans.ts";
import type { TenantRegistrations } from "./tenant-registrations.ts";
import { memberNamespace } from "./tenant-fanout.ts";
import type { AppCatalogProvider } from "./app-catalog.ts";
import type { Activator } from "#unit/server/adapters/activation/port.ts";
import { TENANT_COLUMNS } from "./tenant-columns.ts";
import type { TenantFollower } from "./tenant-follow.ts";
import { inviteOrResendTenantAdmin, BOOTSTRAP_TOKEN_KEY, InviteAdminRequest } from "./tenant-admin-invite.ts";
import { TENANT_SECRET } from "./tenant-secrets.ts";
import { tenantMemberUrl } from "#unit/server/unit-dns.ts";
import { resolveNextVersion } from "#unit/server/release-version.ts";
import { onboardRelease } from "./standing-release.ts";
import { parseGitHubOwnerRepo } from "#unit/server/github-repo-url.ts";
import type { GitHubConsumer } from "#unit/server/adapters/github-consumer/port.ts";
import type { AppEnv } from "../../http/app-env.ts";

// Consumer API. The onboard trigger and the lifecycle
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
  /** The consumer-PAT GitHub client — the onboard POST reads the repository's release tags with it
   *  to name the version the onboarding releases (release-version.ts). Absent ⇒ the POST answers 501. */
  github?: GitHubConsumer;
  /** The platform repository on GitHub, for the platform's own release line (release-version.ts). */
  platformGitHub?: { owner: string; repo: string };
  /** The platform's GitHub App: the identity of every repository its installation reaches, measured
   *  per onboarding (repo-identity.ts). Absent ⇒ every repository is onboarded with its own PAT. */
  githubApp?: GitHubApp;
  /** The platform GitOps repo — the channel-table read (GET /api/consumers/channels) serves
   *  global.channelStages LITERALLY from clusters/platform/values-common.yaml, so the manager keeps no
   *  copy of the one table the release pipeline enforces. Absent ⇒ the route answers 501. */
  platformRepo?: PlatformRepo;
  /** The per-cluster kube resolver — powers the per-consumer live reconciliation read
   *  (GET /api/consumers/:appId/live). Absent when onboarding is not configured (no adapters
   *  wired): the live endpoint then degrades to SQL-only, mirroring the 501 mutating routes. */
  resolver?: ClusterKubeResolver;
  /** The consumer registration registrations — powers the operator-triggered DETECTED scan
   *  (GET /api/consumers/detected), which diffs the LIVE registrations/**
   *  against the inventory. The SAME Registrations the consumer runs commit through, exactly as the tenant
   *  routes carry the TenantRegistrations for their orphan scan. Absent when consumer onboarding is not
   *  wired ⇒ the scan route answers every list empty plus a `reason` instead of 501: it is a READ, and
   *  a read degrades. The CLUSTER half of that same scan needs `resolver` too, and degrades on its own
   *  when only that one is missing. */
  registrations?: Registrations;
}

// The path segment and the run kind are stated apart, exactly as TENANT_LIFECYCLE states them: the
// route is the URL an operator's browser calls and the kind is what the runs table records, and only
// the kind carries the family word.
// backup rides the same no-body shape: the run resolves everything off the appId, and the folder it
// leaves on the storage box is named after the unit.
// restart-workloads rides it too: no body either, and the run resolves the namespace off the appId.
const LIFECYCLE = [
  { path: "offboard", kind: "consumer-offboard" },
  { path: "suspend", kind: "consumer-suspend" },
  { path: "resume", kind: "consumer-resume" },
  { path: "restart-workloads", kind: "consumer-restart-workloads" },
  { path: "backup", kind: "consumer-backup" },
] as const;

/** The target picker both wizards read: the ACTIVE clusters whose server carries the slave part
 *  (SLAVE_ROLES) — every role, since a master carries it as well (hostyour-cloud#232). No
 *  cluster-name list anywhere: who qualifies is a row question, read at request time, and the set
 *  stays the one named place the question is answered. The `stage` here is the CLUSTER's, the
 *  platform's own; it decides nothing about the unit, whose stage the wizard asks separately. */
function targetClusters(db: Db): Array<{ id: string; domain: string; stage: Stage; status: string }> {
  return db
    .select({ id: clusters.id, domain: clusters.domain, stage: clusters.stage, status: clusters.status })
    .from(clusters)
    .innerJoin(servers, eq(servers.id, clusters.serverId))
    .where(and(eq(clusters.status, "active"), inArray(servers.role, [...SLAVE_ROLES])))
    .all();
}

export function registerConsumerRoutes(app: Hono<AppEnv>, deps: ConsumerOnboardApiDeps): void {
  const { executor, db, store, onboardingEnabled, resolver, registrations, platformRepo, github, platformGitHub, githubApp } = deps;
  registerConsumerDomainRoutes(app, { db, executor, onboardingEnabled, ...(registrations ? { registrations } : {}) });

  // The consumer inventory: every onboarded app, its own stage, and which cluster it runs on
  // (apps.clusterId -> clusters.domain). provenance "manager" marks a consumer this Manager onboarded
  // and gate-validated, "adopted" one whose row was reconstructed from the registration — the same two
  // words the tenant projection below carries, so a reader compares the two lists on one vocabulary.
  app.get("/api/consumers", (c) =>
    c.json(
      db
        .select({
          id: apps.id,
          name: apps.name,
          clusterId: apps.clusterId,
          domain: clusters.domain,
          stage: apps.stage,
          repoUrl: apps.repoUrl,
          chartPath: apps.chartPath,
          provenance: apps.provenance,
          status: apps.status,
          lastRunId: apps.lastRunId,
          check: apps.checkJson,
          createdAt: apps.createdAt,
          updatedAt: apps.updatedAt,
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
  // report their orphans; no registrations (consumer onboarding unwired) degrades the whole route to
  // `reason`. Every arm is `satisfies DetectedScanView` — the ONE declaration (shared/api-types.ts)
  // the browser's scanDetectedConsumers is typed by.
  app.get("/api/consumers/detected", async (c) => {
    if (!registrations) return c.json({ detected: [], skipped: [], clusterOrphans: [], unscanned: [], reason: "onboarding-not-configured" } satisfies DetectedScanView);
    // The two halves are INDEPENDENT and are told apart on the wire, so they are settled apart here:
    // the registration diff can fail whole (its `error`), the cluster scan fails per cluster (its own
    // `unscanned`), and neither failure may empty the other's list or be told in the other's words.
    // Without a resolver there is no per-cluster client at all, so the cluster half simply produces
    // nothing — the same degrade the live probes take, and the panel says which half it lost.
    const cluster = resolver
      ? await scanClusterOrphanConsumers({ db, registrations, resolver })
      : { clusterOrphans: [], unscanned: [] };
    try {
      const { detected, skipped } = await scanDetectedConsumers({ db, registrations });
      return c.json({ detected, skipped, ...cluster } satisfies DetectedScanView);
    } catch (e) {
      return c.json({ detected: [], skipped: [], ...cluster, error: errText(e) } satisfies DetectedScanView);
    }
  });

  registerConsumerLiveRoutes(app, deps);

  app.get("/api/consumers/targets", (c) => c.json(targetClusters(db)));

  // The units that only run CI, read off the registration tree: they have no apps row to list. Static
  // path, registered before the :appId routes so it is never shadowed.
  app.get("/api/consumers/ci-only", async (c) => {
    if (!registrations) throw errNotConfigured("onboarding is not configured on this manager — the registrations that say where a unit stands are not wired");
    const units = (await registrations.listBuildRegistrations()).filter((r) => r.ciOnly);
    return c.json(units.map(({ entry }) => ({ name: entry.name, repoUrl: entry.repoURL, owner: entry.owner ?? null, onboardedAt: entry.onboardedAt ?? null })) satisfies CiOnlyUnitView[]);
  });

  // Offboard of one of them. The run needs the repository for the steps after the registration is gone,
  // so the route reads it off the registration instead of asking the operator for it.
  app.post("/api/consumers/ci-only/:name/offboard", async (c) => {
    if (!onboardingEnabled || !registrations) throw errNotConfigured("onboarding is not configured on this manager");
    const name = c.req.param("name");
    const read = await registrations.readBuildRegistration(name);
    if (read === null) throw errNotFound(`build registration of ${name}`);
    return c.json(await executor.plan("consumer-offboard-ci-only", OffboardCiOnlyParams.parse({ consumerName: name, repoURL: read.entry.repoURL })), 201);
  });

  // The channel table the onboard wizard reads: which stages a release channel may reach.
  // The source is LITERALLY the platform repo's clusters/platform/values-common.yaml → global.channelStages —
  // the ONE literal table, enforced in the release pipeline at the point that writes; the manager
  // carries NO copy, so a table change reaches the wizard without a manager release. Read off the
  // trunk (master): the install branches carry the same file, and the trunk is the copy every
  // cluster shares.
  app.get("/api/consumers/channels", async (c) => {
    if (!platformRepo) throw errNotConfigured(`the platform repo is not configured on this manager — the channel table lives in ${CHANNEL_STAGES_PATH}`);
    return c.json({ channelStages: await readChannelStages(platformRepo) } satisfies ChannelStagesView);
  });

  // Onboard: the streaming plan path. Returns { runId } immediately; the run sits in `planning`
  // while the gate-runner validates, streaming gate lines to /api/runs/:id/events, then settles
  // `planned` (approve to deploy) or `failed` (rejected, the full report frozen for inspection).
  app.post("/api/consumers", async (c) => {
    if (!onboardingEnabled) throw errNotConfigured("onboarding is not configured on this manager — the gate-runner and git/kube/vault adapters must be wired first");
    const body: unknown = await c.req.json().catch(() => ({}));
    if ((body as { form?: unknown } | null)?.form === "ci-only") {
      // The CI only form releases nothing, so no version is read: only the identity is chosen and sealed.
      const ciOnly = CiOnlyPlanRequest.omit({ repoCredentialId: true }).safeParse(body);
      if (!ciOnly.success) throw errValidation(`invalid onboard request: ${ciOnly.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
      const repoCredentialId = await resolveRepoCredentialId({ repoURL: ciOnly.data.repoURL, githubApp, owners: (org) => readOwnerIdentity(db, org), store, signal: c.req.raw.signal });
      return c.json(await executor.planStreamed("consumer-onboard", { ...ciOnly.data, repoCredentialId }), 201);
    }
    const parsed = OnboardRequest.safeParse(body);
    if (!parsed.success) throw errValidation(`invalid onboard request: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    // The repository's identity is chosen and sealed BEFORE the run exists: planStreamed persists
    // its raw params verbatim (params_json), so only the sealed reference may enter the executor.
    // The identity is the owner's (repo-identity.ts, #220): the App where its installation
    // reaches the repository, else the owner's repository PAT where recorded, else a refusal
    // naming both; and the owner's packages reader must stand, or the build could install no
    // private package. Fail-closed: a seal failure is a thrown error, no run is created.
    const req = parsed.data;
    if (!github || !registrations) throw errNotConfigured("onboarding is not configured on this manager — the GitHub client that reads a repository's release tags, or the registrations that say where a unit stands, are not wired");
    const identity = await resolveRepoIdentity({ repoURL: req.repoURL, githubApp, owners: (org) => readOwnerIdentity(db, org), store, signal: c.req.raw.signal });
    // The release the onboarding puts on the stage, read with the identity's token before it is
    // sealed; nobody types it, so no onboarding names a release that stands at another commit.
    // Only a stage the unit stands at runs a release: an offboarded one leaves its delivery branch behind.
    const { version, channel, existing } = await onboardRelease(github, { ...parseGitHubOwnerRepo(req.repoURL), token: identity.token, signal: c.req.raw.signal }, await registrations.readUnitStages(req.consumerName), () => resolveNextVersion({ github, ...(platformGitHub ? { platformGitHub } : {}), ...(platformRepo ? { platformRepo } : {}) }, { repoURL: req.repoURL, token: identity.token, signal: c.req.raw.signal }));
    // The credential the run opens the repository with: the App's one row or the owner's PAT row,
    // resolved now — no row of the unit's (#226).
    const repoCredentialId = await resolveRepoCredentialId({ repoURL: req.repoURL, githubApp, owners: (org) => readOwnerIdentity(db, org), store, signal: c.req.raw.signal });
    return c.json(await executor.planStreamed("consumer-onboard", { ...req, version, channel, existing, repoCredentialId }), 201);
  });

  // Lifecycle: offboard/suspend/resume plan synchronously (no gate-runner) — approve via the Runs API.
  for (const { path, kind } of LIFECYCLE) {
    app.post(`/api/consumers/:appId/${path}`, async (c) => {
      if (!onboardingEnabled) throw errNotConfigured("onboarding is not configured on this manager");
      return c.json(await executor.plan(kind, { appId: c.req.param("appId") }), 201);
    });
  }

  // Relocation with a target: restore rebuilds the unit from the backup generation the body names onto
  // the named cluster, migrate moves it there through a generation of its own. Both need the target,
  // which no row can answer, so they take a body — validated through the run's OWN params schema.
  for (const { path, kind } of [
    { path: "restore", kind: "consumer-restore" },
    { path: "migrate", kind: "consumer-migrate" },
  ] as const) {
    app.post(`/api/consumers/:appId/${path}`, async (c) => {
      if (!onboardingEnabled) throw errNotConfigured("onboarding is not configured on this manager");
      const body = (await c.req.json().catch(() => ({}))) as { targetClusterId?: unknown; generation?: unknown };
      const schema = kind === "consumer-restore" ? RestoreParams : MigrateParams;
      const parsed = schema.safeParse({ appId: c.req.param("appId"), targetClusterId: body.targetClusterId, generation: body.generation });
      if (!parsed.success) throw errValidation(`invalid ${kind} request: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
      return c.json(await executor.plan(kind, parsed.data), 201);
    });
  }

  // Purge / force-offboard: remove a consumer's WHOLE footprint BY NAME even when NO inventory row
  // exists (an orphaned partial onboard — onboard writes the row last, so a failure at watch-sync/
  // smoke leaves the pointer/AppProject/namespace/Vault/mongo behind with no appId to offboard).
  // Keyed on name+stage+cluster (the namespace is <name>-<stage>), NOT an appId, so it needs a body
  // rather than a path :appId — there may be no app row to name. Plans synchronously (no
  // gate-runner); approve via the Runs API.
  app.post("/api/consumers/purge", async (c) => {
    if (!onboardingEnabled) throw errNotConfigured("onboarding is not configured on this manager");
    const parsed = PurgeParams.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) throw errValidation(`invalid purge request: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    return c.json(await executor.plan("consumer-purge", parsed.data), 201);
  });

  // Adopt: reconstruct a DETECTED consumer's missing apps row FROM its GitOps
  // pointer, via a Run with a live-cluster attest (adopt-consumer.run.ts). Keyed on name+stage+cluster
  // exactly like purge — there is no appId, that absence is the whole problem — so it takes a body,
  // not a path :appId. Plans synchronously (no gate-runner: nothing is deployed or validated, the only
  // mutation is the inventory row); approve via the Runs API.
  app.post("/api/consumers/adopt", async (c) => {
    if (!onboardingEnabled) throw errNotConfigured("onboarding is not configured on this manager");
    const parsed = AdoptConsumerParams.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) throw errValidation(`invalid adopt request: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    return c.json(await executor.plan("consumer-adopt", parsed.data), 201);
  });
}

// The tenant (multi-app) API — the same shape as
// the consumer routes above: a trigger creates a Run and everything after (the live gate/step log,
// approve, discard, retry) flows through the kind-agnostic Runs API (/api/runs/:id/*). create-tenant
// and add-app are the two validated triggers, so they POST through planStreamed (the streaming gate-
// by-gate planner) exactly like consumer onboard; remove-app + tenant-suspend/-resume/-offboard carry
// no gate-runner and plan synchronously. onboardingEnabled here is the TENANT family's flag
// (wire-units's tenantEnabled) — when tenant onboarding is not configured the mutating
// routes answer 501 NOT_CONFIGURED while the read routes (the tenant list/detail) stay live.

/** The tenant fields the list/detail views project (JOIN clusters for domain/stage), mirroring the
 *  consumer list — the guid identity + suspend state instead of a repoUrl. */

// `refuseWhenProvisioning` names the action in the refusal message, or is null when the run kind IS allowed
// on a tenant whose create-tenant run never finished. Only the removal run kind is
// allowed: tenant-offboard's teardown is idempotent and copes with a half-deployed fan-out, so it is the
// clean way out, while suspend/resume flip a pointer that may never have been written at all.
const TENANT_LIFECYCLE = [
  { path: "offboard", kind: "tenant-offboard", refuseWhenProvisioning: null },
  { path: "suspend", kind: "tenant-suspend", refuseWhenProvisioning: "suspending it" },
  { path: "resume", kind: "tenant-resume", refuseWhenProvisioning: "resuming it" },
  { path: "restart-workloads", kind: "tenant-restart-workloads", refuseWhenProvisioning: "restarting its workloads" },
  { path: "backup", kind: "tenant-backup", refuseWhenProvisioning: "backing it up" },
] as const;

/** The tenant routes' deps: the consumer set + the OPTIONAL app catalog provider. The provider
 *  clones the deploy repository and the apps repository it names to read the create-tenant wizard's apps; it
 *  is absent when tenant onboarding is not wired (no deploy repository access), in which case the catalog
 *  route serves { apps: [] } and the wizard degrades — the SAME degrade-loud shape as the 501
 *  mutating routes. */
export interface TenantApiDeps extends ConsumerApiDeps {
  appCatalog?: AppCatalogProvider;
  /** The per-cluster kube resolver — powers the per-tenant live reconciliation read
   *  (GET /api/tenants/:id/live), the tenant analogue of the consumer live endpoint. Absent when
   *  tenant onboarding is not configured (no adapters wired): the live endpoint then degrades to
   *  SQL-only (reason), mirroring the 501 mutating routes. */
  resolver?: ClusterKubeResolver;
  /** The ONE repo every tenant's charts live in (config.deployRepo.repoURL) — what a tenant has
   *  INSTEAD of a consumer's per-app repoUrl column, since a tenant's repo is a platform constant of
   *  the one-time deploy repository registration (shared/tenant.ts TenantEntrySchema). The live read needs
   *  it to ask the base Application which of its spec sources targets the deploy repository, exactly as the
   *  consumer read asks with apps.repoUrl. Wired TOGETHER with `resolver` — both come from
   *  config.deployRepo (wire-units buildTenantOnboarding), so they are present or absent
   *  together, and the live route degrades to SQL-only unless it has BOTH. */
  deployRepoUrl?: string;
  /** The post-onboard activation client — powers the operator-driven first-admin invite/resend
   *  (POST /api/tenants/:id/invite-admin). The SAME HttpActivator the create-tenant `activate` step
   *  uses. Absent when tenant onboarding is not wired ⇒ the invite route answers 501, like the other
   *  mutating routes. */
  activator?: Activator;
  /** The tenant pointer registrations in the deploy repository — powers the operator-triggered ORPHAN SCAN
   *  (GET /api/tenants/orphans), which diffs the LIVE pointers against the inventory. The SAME
   *  TenantRegistrations the tenant runs commit through. Absent when tenant onboarding is not wired ⇒ the
   *  scan route answers { orphans: [], reason } instead of 501: it is a READ, and a read degrades. */
  registrations?: TenantRegistrations;
  /** What the Versions dialog offers for one tenant (tenant-versions.ts readTenantVersions). Absent with
   *  the tenant family unwired; the route then answers 501. */
  versions?: (db: Db, tenantId: string, signal?: AbortSignal) => Promise<VersionsView>;
  /** The engine line a tenant runs and the move to a newer one (tenant-line-move.ts readTenantLineMoves). */
  lineMoves?: (db: Db, tenantId: string, signal?: AbortSignal) => Promise<LineMoveView>;
  /** Moves the tenants that follow releases (tenant-follow.ts). Absent without the tenant family. */
  follower?: TenantFollower;
  /** The public apex (global.unitApex) of a cluster, read off its values chain on the platform repo —
   *  the SAME resolver the tenant runs carry (create-tenant.run.ts TenantOnboardPorts). The invite
   *  route needs it because a tenant member is addressed at `<subdomain>.<unitApex>/<member>` and the
   *  apex is nowhere on the tenants/clusters rows: `clusters.domain` is where the CLUSTER is reached,
   *  while the apex is where its UNITS serve. Absent when tenant onboarding is not wired ⇒ the invite
   *  route answers 501, like the other mutating routes. */
  resolveUnitApex?: (domain: string, stage: Stage) => Promise<string>;
}

export function registerTenantRoutes(app: Hono<AppEnv>, deps: TenantApiDeps): void {
  const { executor, db, onboardingEnabled, appCatalog, resolver, activator, registrations, versions, lineMoves, resolveUnitApex } = deps;
  // The routing move — a route file of its own, the way the resize is.
  registerTenantActionRoutes(app, { db, executor, tenantEnabled: onboardingEnabled, ...(versions ? { versions } : {}), ...(lineMoves ? { lineMoves } : {}), ...(deps.follower ? { follower: deps.follower } : {}) });

  // The tenant inventory: every onboarded tenant + which cluster it fans out on (JOIN clusters for
  // domain/stage). Always live — the read path never degrades on missing config.
  app.get("/api/tenants", (c) =>
    c.json(db.select(TENANT_COLUMNS).from(tenants).innerJoin(clusters, eq(tenants.clusterId, clusters.id)).all()),
  );

  registerTenantLiveRoutes(app, deps);

  // The tenant target picker: the clusters a tenant can be created on — every ACTIVE cluster,
  // whatever role or stage it carries. Placement is not a function of the role; a tenant runs on a
  // slave and equally on a master, and the tenant's own stage is the wizard's separate input.
  // The same list the consumer picker offers, and the create-tenant plan re-checks `active` itself
  // (resolveCluster), so this route is the UI convenience it always was.
  app.get("/api/tenants/targets", (c) => c.json(targetClusters(db)));

  // The create-tenant wizard's app CATALOG: the apps the picker can offer with their titles,
  // descriptions and selections, read off the apps repository's apps.yaml (app-catalog.ts) — never a
  // hardcoded list — so a selected name and selection is always one gate T4 will accept. A READ
  // route: always live, registered BEFORE /:id so the static path is not captured by the param
  // route. FAIL-SOFT — the provider caches with a short TTL and answers no apps on any clone/read
  // error, and no provider (tenant onboarding not wired) is likewise { apps: [] }; the request's
  // abort signal cancels an in-flight clone.
  app.get("/api/tenants/app-catalog", async (c) =>
    c.json(appCatalog ? await appCatalog.list(c.req.raw.signal) : { apps: [] }),
  );

  // The ORPHAN SCAN: every tenant the GitOps pointers know and the inventory does
  // not — the ONLY way an operator ever learns an orphan's guid, which is minted by the plan and typed
  // by nobody (tenant-orphans.ts). Registered BEFORE /:id so the static path is not captured by the
  // param route, like app-catalog above.
  //
  // EXPLICIT, never eager: this CLONES the deploy repository and scans all three stages, so it must stay an
  // operator-triggered action — firing it on every Tenants page load would clone the repo behind the
  // operator's back on a screen that otherwise reads pure SQL.
  //
  // FAIL-SOFT like the app-catalog route: a broken/drifted pointer does not wedge the scan, and an
  // unreachable deploy repository answers 200 with an EMPTY list plus the failure text rather than an error
  // status — the Tenants page must never break on a git hiccup. The `error` field is NOT cosmetic: a
  // silent empty list would read as "no orphans found", the exact opposite of the truth, so the caller
  // renders the failure instead of the (unknown) result. With no registrations (tenant onboarding unwired) it
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
    if (!registrations) return c.json({ orphans: [], skipped: [], reason: "onboarding-not-configured" } satisfies OrphanScanView);
    try {
      const { orphans, skipped } = await scanOrphanTenants({ db, registrations, ...(resolver ? { resolver } : {}) });
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
    if (run.kind !== "tenant-create") {
      throw errValidation(`run ${runId} is a ${run.kind} run — only a tenant-create run mints a tenant of its own`);
    }
    return c.json(resolveRunTenantState(db, runId, run.params));
  });

  // One tenant + its per-app rows (the guid × apps[] matrix). 404 when the tenant row is absent.
  app.get("/api/tenants/:id", (c) => {
    const id = c.req.param("id");
    const tenant = db.select(TENANT_COLUMNS).from(tenants).innerJoin(clusters, eq(tenants.clusterId, clusters.id)).where(eq(tenants.id, id)).get();
    if (!tenant) throw errNotFound(`tenant ${id}`);
    const appRows = db
      .select({ id: tenantApps.id, name: tenantApps.name, status: tenantApps.status, lastRunId: tenantApps.lastRunId, site: tenantApps.site, createdAt: tenantApps.createdAt })
      .from(tenantApps)
      .where(eq(tenantApps.tenantId, id))
      .all();
    return c.json({ ...tenant, apps: appRows });
  });

  // Create tenant: the streaming plan path (identical contract to consumer onboard). Returns { runId }
  // immediately; the run sits in `planning` while the T1..T4 fan-out gates validate, streaming gate
  // lines to /api/runs/:id/events, then settles `planned` (approve to deploy) or `failed` (rejected).
  app.post("/api/tenants", async (c) => {
    if (!onboardingEnabled) throw errNotConfigured("tenant onboarding is not configured on this manager — it needs DEPLOY_REPO and the platform repository (GITHUB_REPO, GITHUB_WRITE_PAT)");
    const parsed = CreateTenantRequest.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) invalid("tenant-create", parsed.error);
    return c.json(await executor.planStreamed("tenant-create", parsed.data), 201);
  });

  // Add app: fan ONE new app into a LIVE tenant — also streaming (a subset validation at the tenant's
  // existing pin). tenantId comes from the path, the new app name from the body.
  app.post("/api/tenants/:id/apps", async (c) => {
    if (!onboardingEnabled) throw errNotConfigured("tenant onboarding is not configured on this manager");
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const parsed = AddAppRequest.safeParse({ ...body, tenantId: c.req.param("id") });
    if (!parsed.success) invalid("tenant-add-app", parsed.error);
    // A tenant that is still provisioning has no finished fan-out to add an app TO: add-app's planner
    // reads the tenant's LIVE registration and its watch waits on the new Application, so on a
    // half-created tenant it would either 404 on the absent pointer or burn the argo timeout. Refuse
    // here, before a Run is even planned. (The suspended case is refused by add-app's own planner,
    // which reads that fact off the pointer; "provisioning" is a ROW fact, so it is refused here.)
    assertTenantProvisioned(loadTenantStatus(db, parsed.data.tenantId), "adding an app");
    return c.json(await executor.planStreamed("tenant-add-app", parsed.data), 201);
  });

  // Remove app: drop ONE app of the guid × apps[] matrix — synchronous plan() (no gate-runner). The
  // app name is a path segment; the tenant + trio + base stay. Refused on a provisioning tenant for the
  // same reason add-app is: the drop is a pointer edit and the prune watch waits on that app's
  // Application, neither of which exists on a tenant whose create-tenant run never wrote the pointer.
  app.post("/api/tenants/:id/apps/:app/remove", async (c) => {
    if (!onboardingEnabled) throw errNotConfigured("tenant onboarding is not configured on this manager");
    const id = c.req.param("id");
    assertTenantProvisioned(loadTenantStatus(db, id), `removing the app "${c.req.param("app")}"`);
    return c.json(await executor.plan("tenant-remove-app", { tenantId: id, app: c.req.param("app") }), 201);
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
    if (!onboardingEnabled) throw errNotConfigured("tenant onboarding is not configured on this manager");
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
    const ns = memberNamespace(found.guid, found.identityProvider, found.stage);
    const { clusterReader } = await resolver.resolve(found.clusterId);
    const token = await clusterReader.readSecretValue(ns, TENANT_SECRET, BOOTSTRAP_TOKEN_KEY);
    if (!token) throw errValidation(`the tenant bootstrap token (Secret ${TENANT_SECRET} key ${BOOTSTRAP_TOKEN_KEY}) is absent in ${ns} — cannot invite the first admin`);
    // WHERE the tenant's own example-auth serves: the address `tenantMemberUrl` gives the IdP
    // member, the one its ingress renders and its record covers. The apex comes off the
    // target cluster's values chain, never off `found.domain` — that column is where the CLUSTER is reached,
    // and install.sh defaults the apex to the cluster FQDN minus its first label, so composing from
    // the domain posts the bootstrap token at a host nothing serves.
    const result = await inviteOrResendTenantAdmin({
      activator,
      token,
      idpUrl: tenantMemberUrl(found.identityProvider, found.stage, found.subdomain, await resolveUnitApex(found.domain, found.stage), found.ownDomain),
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
      if (!onboardingEnabled) throw errNotConfigured("tenant onboarding is not configured on this manager");
      const id = c.req.param("id");
      if (refuseWhenProvisioning !== null) assertTenantProvisioned(loadTenantStatus(db, id), refuseWhenProvisioning);
      return c.json(await executor.plan(kind, { tenantId: id }), 201);
    });
  }

  // Tenant relocation with a target: tenant-restore rebuilds the whole bracket from the backup
  // generation the body names onto the named cluster, tenant-migrate moves it there through its own.
  // Validated through the run's OWN params schema — one contract, exactly like the consumer routes.
  for (const { path, kind, refuse } of [
    { path: "restore", kind: "tenant-restore", refuse: "restoring it" },
    { path: "migrate", kind: "tenant-migrate", refuse: "moving it" },
  ] as const) {
    app.post(`/api/tenants/:id/${path}`, async (c) => {
      if (!onboardingEnabled) throw errNotConfigured("tenant onboarding is not configured on this manager");
      const id = c.req.param("id");
      assertTenantProvisioned(loadTenantStatus(db, id), refuse);
      const body = (await c.req.json().catch(() => ({}))) as { targetClusterId?: unknown; generation?: unknown; stage?: unknown; sourceClusterId?: unknown };
      const schema = kind === "tenant-restore" ? TenantRestoreParams : TenantMigrateRequest;
      const parsed = schema.safeParse({ tenantId: id, targetClusterId: body.targetClusterId, generation: body.generation, stage: body.stage, sourceClusterId: body.sourceClusterId });
      if (!parsed.success) invalid(kind, parsed.error);
      return c.json(await executor.plan(kind, parsed.data), 201);
    });
  }

  // Tenant purge / force-offboard: remove a tenant's WHOLE footprint BY GUID even when NO inventory row
  // exists (an ORPHAN — see tenant-purge.run.ts), and the only run kind that also destroys the crypto entry and
  // the namespace, which the pointer-driven offboard leaves standing on a half-created tenant.
  // Keyed on guid+stage+cluster, NOT a path :id — there may be no tenant row to name — so it
  // takes a body, exactly like the consumer purge. Unlike that one it plans through planStreamed: the
  // teardown target (the fan-out watch set) can only be read off the LIVE registration the first step
  // git-rm's, so it must be resolved and frozen BEFORE the run starts (tenant-purge.run.ts). Approve via
  // the Runs API, like every other plan.
  app.post("/api/tenants/purge", async (c) => {
    if (!onboardingEnabled) throw errNotConfigured("tenant onboarding is not configured on this manager");
    const parsed = TenantPurgeRequest.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) invalid("tenant-purge", parsed.error);
    // The one refusal this destructive run kind owes the sibling run kinds' guarantee: a tenant the inventory
    // still calls live, whose pointer still stands, is DEPLOYED — offboard removes such a tenant, purge
    // would deprovision it. Asked here so the operator is refused immediately, before a Run exists — and
    // asked AGAIN, from the same rule, in the run's own attest-target step (tenant-purge.run.ts), because
    // this end alone does not hold: a purge legitimately planned against a "provisioning" row stays
    // approvable while a create-tenant retry settles that row to "active", and approve re-validates
    // nothing. A hidden button is a convenience; ONE rule asked at BOTH ends is the guard.
    await assertTenantNotLive(db, registrations, parsed.data, purgeLiveRefusal(parsed.data));
    return c.json(await executor.planStreamed("tenant-purge", parsed.data), 201);
  });
}
