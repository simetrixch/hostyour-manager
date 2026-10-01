import { z } from "zod";
import { and, eq } from "drizzle-orm";
import type { RunDefinition, Step, Plan } from "../../executor/types.ts";
import { tenants, tenantApps } from "../../db/schema/inventory.ts";
import { tenantAppId as mintTenantAppId } from "../../kernel/ids.ts";
import { STAGE } from "../../../shared/enums.ts";
import { guid as guidSchema, appName, appDatabases, appFolder, siteId, isWebsiteAppNameOf, websiteAppName, TenantMemberRecordSchema, TenantValidationReportSchema } from "../../../shared/tenant.ts";
import { publicFqdn } from "../../../shared/consumer.ts";
import { ownDomainEntryProblem } from "#unit/shared/unit-host.ts";
import { errNotFound, errValidation, errInternal } from "../../kernel/errors.ts";
import { localTx } from "../../executor/stepkit.ts";
import { validateTenant } from "./validate-tenant.ts";
import { registryHostFromChain } from "./tenant-values.ts";
import { RequiredImageSchema, requiredImagesFrom } from "./ensure-images.ts";
import { loadTenantCluster } from "./lifecycle.ts";
import { assertDeployState } from "#unit/server/lifecycle.ts";
import { renderTenantAppProject } from "./appproject.ts";
import { renderTenantMemberAdmissionPolicy } from "./admission-policy.ts";
import { renderTenantArgoSync, tenantSyncUnits } from "#unit/server/build-rbac.ts";
import { memberApplication, memberNamespace, tenantApplicationSet } from "./tenant-fanout.ts";
import { tenantAppsUnit } from "./tenant-apps-tree.ts";
import type { TenantOnboardPorts } from "./create-tenant.run.ts";
import { placeholderTagFromChain } from "./tenant-values.ts";
import { NO_GITHUB_APP, resolveTenantAppsUnit, tenantAppsRepoSteps, TenantAppsUnitSchema } from "./tenant-apps-steps.ts";
import { readTenantSpec, recordAppsRepoStep } from "./tenant-apps-repo.run.ts";
import { readOwnerIdentity } from "#unit/server/owners.ts";
import { BuildUnitSchema, buildUnitStep, planBuildUnits, tenantImageSteps, type TenantBuildRuntime } from "./tenant-builds.ts";
import { probeBuildUnit } from "./tenant-probes.ts";
import { addedMemberVersions, newMembersRefusal } from "./tenant-versions.ts";
import type { ProbeCtx } from "../../executor/probe.ts";
import { tenantLocks } from "./tenant-lifecycle.run.ts";
import { syncedAt, describeUnsynced } from "#unit/server/argo-app-status.ts";
import { customerHostProblem, replacementSentence, ReplacedRecord } from "./own-domain-records.ts";
import { otherTenantsWebsiteHosts, provisionWebsiteRecordsStep, removeWebsiteRecordsCleanup, waitForWebsite, websiteHosts, websiteRecordHosts, websiteRecordsToReplace, type WebsiteDomainPorts } from "./website-domain.ts";
import { builtBundleEngine, throwEngineLineRefusal } from "./engine-line.ts";
import { seedTenantAppKeyStep } from "./tenant-app-keys.ts";
import { assertAddAppAbortable, revertAppendCleanup } from "./add-app-abort.ts";

// The "tenant-add-app" Run. The subset sibling of
// create-tenant: it fans ONE new app into a LIVE tenant. It shares create-tenant's streaming-plan
// skeleton (planStream — validation streams gate-by-gate to the approve card) and its
// TenantOnboardPorts, but three things differ from create-tenant:
//   1. targetKind='tenant' (the run acts on an existing tenant row), not 'cluster'.
//   2. apply-appproject creates the NEW member's OWN project <guid>-<app> and touches no sibling's —
//      a member is self-contained, so adding an app adds exactly one namespace and one AppProject.
//      The tenant's argo-sync grant is the one object that is not per-member: it names every member
//      Application at once, so provision-argo-sync re-renders it whole with the new name in it.
//   3. it appends ONE apps[] entry (updateTenantApps, preserving the last report) with a
//      revert-append cleanup, and the set-watch waits ONLY on the NEW member's Application.
//
// mutating: true ⇒ steps()[0] is attest-target.

/** The frozen add-app params: the tenant it targets + the new app + everything the plan resolved
 *  (the tenant's pin/context, the approved report, the NEW app's expected Application set). */
export const AddAppParams = z.object({
  tenantId: z.string().startsWith("tnt_"),
  guid: guidSchema,
  stage: z.enum(STAGE),
  clusterId: z.string().startsWith("cls_"), // the tenant's cluster (crypto-gate keyed here)
  domain: z.string().min(1),
  // The tenant's target-slave name, read off the LIVE registration at plan time (the registration is
  // the GitOps truth): apply-appproject pins the new member's project to it.
  cluster: z.string().min(1),
  // The deploy repository revision this run VALIDATED at — a run fact, not a registration field: the
  // frozen expectedApps/requiredImages were computed from exactly this tree.
  chartsRef: z.string().regex(/^[0-9a-f]{40}$/),
  // The registry host the new app's images are pulled from and probed against — the tenant
  // cluster's own chain (ports.resolveClusterValueFiles -> registryHostFromChain), frozen at plan time.
  registryHost: z.string().min(1),
  app: appName, // the new app being fanned in, with the database list its catalog entry declares
  databases: appDatabases.optional(),
  // The new app's MEMBER, resolved from the product manifest at the revision this run validated. The
  // registration's members[] is what the ApplicationSet fans out over, so an appended app that added
  // no member would be recorded as owned and never deployed; frozen here so the append writes what
  // was approved rather than what the manifest says when the step runs.
  member: TenantMemberRecordSchema,
  // The app's selections — written into the registration's apps[] entry the way create-tenant
  // writes them: the two seed tiers as fields, every further one under selections.
  seedReference: z.boolean().default(false), // reference tier → SEED_APP_DATA_ON_BOOT
  seedDemo: z.boolean().default(false), // demo tier → SEED_DEMO_DATA_ON_BOOT
  selections: z.record(z.string(), z.boolean()).default({}),
  report: TenantValidationReportSchema, // the fresh subset validation report (audit; not re-committed)
  expectedApps: z.array(z.string()), // ONLY the new member's Application: memberApplication(guid,app,stage)
  // The registrations images the NEW app's subset render pulls (filtered to registryHost above) —
  // the ensure-images step probes/builds these BEFORE append-app,
  // exactly like create-tenant. pipeline null ⇒ probe-only (consumer-built, never built here).
  requiredImages: z.array(RequiredImageSchema).default([]),
  // The build units the re-rendered argo-sync grant arms — resolved at plan time from the images
  // above, exactly as create-tenant resolves its own (tenantSyncUnits).
  syncUnits: z.array(z.string()).default([]),
  // The build units this run onboards or re-releases BEFORE the image gate (hostyour-manager#214):
  // the new app's images that are absent from the registry and that the tenant spec's buildRepos
  // build — resolved at plan time exactly as create-tenant resolves its own (planBuildUnits).
  buildUnits: z.array(BuildUnitSchema).default([]),
  deployRepoUrl: z.string().min(1),
  // THE TENANT'S BUNDLE (hostyour-manager#213, #215): every app lives in the tenant's own
  // `<bundle>-<subdomain>` repository, so adding one carries the bundle along — created from the
  // deploy repository's template where none stood, extended with this app's folder and entry where one does
  // (write-tree appends what the repository lacks and removes nothing) — built, and recorded on the
  // registration BEFORE the member is fanned out, the fan-out rendered again at the built tag
  // (refresh-images). The four steps of tenant-apps-repo, composed here.
  appsUnit: TenantAppsUnitSchema.optional(),
  appsImage: z.string().optional(), // the bundle's image name, set beside appsUnit
  subdomain: z.string().default(""),
  owner: z.string().default(""),
  seedUsers: z.boolean().default(false),
  demo: z.boolean().default(false), // the tenant is a demo: the new member renders with tenant.demo
  // A website's folder, site and domain, written into its apps[] entry.
  website: z.object({ folder: appName, site: siteId, domain: publicFqdn }).optional(),
  // The website's hosts whose records this run writes: none where the tenant's own domain holds them.
  websiteRecordHosts: z.array(publicFqdn).default([]),
  // The records standing at those hosts that this run replaces; an abort writes them back.
  websiteReplacing: z.array(ReplacedRecord).default([]),
});
export type AddAppParams = z.infer<typeof AddAppParams>;

/** Why a tenant on another routing than `path` takes no website: a website's hosts point at the tenant's
 *  zone, and only path routing gives the zone itself a record (host routing records only its wildcard). */
export const WEBSITE_NEEDS_PATH = (subdomain: string, routing: string): string =>
  `tenant ${subdomain} is on ${routing} routing — a website's hosts point at the tenant's zone, which has a record of its own only under path routing; move the tenant to path routing first`;

/** What add-app reads beyond the onboarding ports: the probe and its wait, for a website's hosts. */
export type AddAppPorts = TenantOnboardPorts & Pick<WebsiteDomainPorts, "probe" | "routingWaitMs" | "routingPollMs">;

/** The raw operator request from the add-app wizard: the target tenant + the new app name. */
export const AddAppRequest = z.object({
  tenantId: z.string().startsWith("tnt_"),
  app: appName,
  // The app's selections, in the shape of one create-tenant apps[] entry (TenantAppSchema): the
  // two seed tiers as fields, every further selection the catalog declares under selections. T4
  // holds all of them against the app's catalog entry.
  seedReference: z.boolean().default(false),
  seedDemo: z.boolean().default(false),
  selections: z.record(z.string(), z.boolean()).default({}),
  // A website names all three (TenantAppSchema): the folder it runs, the site it serves and is named
  // after, and the domain, typed without `www.`, that it is served at.
  folder: appName.optional(),
  site: siteId.optional(),
  domain: publicFqdn.optional(),
}).superRefine((r, ctx) => {
  const given = [r.folder, r.site, r.domain].filter((v) => v !== undefined).length;
  if (given !== 0 && given !== 3) ctx.addIssue({ code: "custom", path: ["domain"], message: "a website names its folder, its site and its domain" });
  if (r.site !== undefined && !isWebsiteAppNameOf(r.app, r.site)) {
    ctx.addIssue({ code: "custom", path: ["app"], message: `a website of site ${r.site} is named ${websiteAppName(r.site, new Set())}, or that name with -2, -3 and on where it is taken, never ${r.app}` });
  }
  if (r.domain === undefined) return;
  const typed = ownDomainEntryProblem(r.domain);
  if (typed !== null) ctx.addIssue({ code: "custom", path: ["domain"], message: typed });
});
export type AddAppRequest = z.infer<typeof AddAppRequest>;

function addAppSteps(ports: AddAppPorts, p: AddAppParams): Step[] {
  const ns = memberNamespace(p.guid, p.app, p.stage); // the NEW member's own namespace — no sibling is touched
  // What the bundle steps hand the steps after them: the built tag, and the image set and sync units
  // rendered again against it. Empty on a tenant that had its bundle already.
  const runtime: TenantBuildRuntime = {};
  const app = { name: p.app, ...p.website, seedReference: p.seedReference, seedDemo: p.seedDemo, selections: p.selections };
  return [
    {
      name: "attest-target",
      title: "Attest the target cluster (deploy-state fresh)",
      run: async (ctx) => {
        // Fail closed on a drifted/absent deploy-state, exactly like create-tenant (shared helper).
        // Read it on the TARGET cluster's own reader (a slave over its bearer).
        const { clusterReader } = await ports.resolver.resolve(p.clusterId);
        const state = assertDeployState(await clusterReader.readDeployState(), p.domain, "tenant");
        ctx.log("meta", `target ${p.domain} attested for ${p.guid} at ${p.stage} — deploy-state generation ${state.generation}`);
      },
    },
    // The build units whose images the new app pulls and the registry lacks, built before anything
    // of the tenant is written — the same step create-tenant runs per unit.
    ...(p.buildUnits ?? []).map((unit) => ({
      ...buildUnitStep(() => ports.onboard?.(), { guid: p.guid, owner: p.owner, stage: p.stage }, unit),
      probe: (ctx: ProbeCtx) => probeBuildUnit(() => ports.onboard?.(), ports, p, unit, ctx),
    })),
    // The tenant's bundle, created where none stood and extended where one does: this app's folder
    // and entry from the template, built, recorded on the registration (tenant-apps-repo's own
    // steps, composed here).
    ...(p.appsUnit
      ? [
        ...tenantAppsRepoSteps(ports, { ...p.appsUnit, subdomain: p.subdomain, guid: p.guid, stage: p.stage, owner: p.owner, apps: [appFolder(app)], ...(p.website ? { sites: { [p.website.folder]: [p.website.site] } } : {}) }, runtime),
        recordAppsRepoStep(ports, { subdomain: p.subdomain, guid: p.guid, stage: p.stage, org: p.appsUnit.org, bundle: p.appsUnit.templateBuild }, runtime),
      ]
      : []),
    // The image gate, the SAME steps create-tenant runs: the fan-out is rendered again at the tag the
    // bundle was just built at, then the new app's pinned images must EXIST in the tenant cluster's
    // registrations before the pointer append fans it out. A probe — an image no build unit above
    // produced fails the run naming every absent tag.
    ...tenantImageSteps(ports, { guid: p.guid, domain: p.domain, stage: p.stage, subdomain: p.subdomain, apps: [app], seedUsers: p.seedUsers, demo: p.demo, registryHost: p.registryHost, requiredImages: p.requiredImages, ...(p.appsImage !== undefined ? { appsImage: p.appsImage } : {}) }, runtime),
    {
      name: "apply-appproject",
      title: "Apply the new member's isolation AppProject and admission policy",
      run: async (ctx) => {
        // The NEW member's OWN project <guid>-<app>, before the append: the generated Application
        // references .spec.project == that name and ArgoCD rejects an Application whose project is
        // absent. No sibling member's project is read or written, so a broken add-app cannot disturb an
        // app that is already serving. Beside it, the member's ValidatingAdmissionPolicy on the
        // TARGET cluster, exactly as create-tenant applies one per member: the project whitelists the
        // Namespace kind, the policy holds that grant to the member's own name and the platform's
        // stamped labels. Idempotent on resume (both writers replace in place).
        const { projectWriter, clusterReader, argoNamespace } = await ports.resolver.resolve(p.clusterId);
        const project = renderTenantAppProject({
          guid: p.guid,
          member: p.app,
          stage: p.stage,
          argoNamespace,
          deployRepoUrl: p.deployRepoUrl,
          platformRepoURL: ports.platformRepoURL,
          cluster: p.cluster,
        });
        const { created } = await projectWriter.applyAppProject(argoNamespace, project);
        const { policy, binding } = renderTenantMemberAdmissionPolicy({ guid: p.guid, member: p.app, stage: p.stage });
        await clusterReader.applyAdmissionPolicy(policy, binding);
        ctx.checkpoint({ appProject: ns, created, admissionPolicy: policy.metadata.name });
        ctx.log("meta", `AppProject ${ns} ${created ? "created" : "confirmed"} in ${argoNamespace}; admission policy ${policy.metadata.name} applied — the member may create only its own namespace, with no platform label beyond the stamped set`);
      },
    },
    {
      name: "provision-argo-sync",
      title: "Extend the tenant's argo-sync grant to the new member",
      run: async (ctx) => {
        // The grant is written whole, so the new member's Application has to stand in it BEFORE the
        // append generates it — a name the grant does not carry is a hit no release may sync. The
        // member list comes from the LIVE registration plus this run's app, so the re-render covers
        // every sibling that is already serving instead of shrinking the grant to the new member.
        const current = await ports.registrations.readTenant(p.stage, p.guid);
        if (!current) throw errNotFound(`tenant ${p.guid} is not onboarded (no registration) — cannot extend its argo-sync grant`);
        const names = current.entry.members.map((m) => m.name);
        const applications = tenantApplicationSet(names.includes(p.app) ? names : [...names, p.app], p.guid, p.stage);
        const { argoNamespace } = await ports.resolver.resolve(p.clusterId);
        const units = runtime.syncUnits ?? p.syncUnits; // as they stand after a bundle build, else as planned
        const syncGrant = renderTenantArgoSync({ guid: p.guid, applications, argoNamespace, units });
        await ports.buildRbac.applyBuildRbac([syncGrant]);
        ctx.checkpoint({ argoSync: `${argoNamespace}/${syncGrant.role.metadata.name}`, applications, units });
        ctx.log("meta", `argo-sync grant ${syncGrant.role.metadata.name} now names ${applications.length} Application(s) of tenant ${p.guid}, "${p.app}" included`);
      },
    },
    // Before the append generates the engine that reads them.
    seedTenantAppKeyStep(ports.seeder, "password-field-key", p.stage, p.guid, p.app),
    ...(p.website
      ? [
        seedTenantAppKeyStep(ports.seeder, "revalidate-secret", p.stage, p.guid, p.app),
        seedTenantAppKeyStep(ports.seeder, "form-signing-key", p.stage, p.guid, p.app),
      ]
      : []),
    {
      name: "append-app",
      title: "Append the new app to the tenant registration",
      run: async (ctx) => {
        // Register the inverse BEFORE the commit so an abort-with-cleanup drops the app this run adds.
        // Idempotent on a resume: if a prior partial run already committed the append, skip re-appending
        // (updateTenantApps refuses a duplicate) but keep the cleanup registered.
        ctx.registerCleanup(revertAppendCleanup(ports, p));
        const current = await ports.registrations.readTenant(p.stage, p.guid);
        if (!current) throw errNotFound(`tenant ${p.guid} is not onboarded (no registration) — cannot append an app`);
        if (current.entry.apps.some((a) => a.name === p.app)) {
          ctx.db.update(tenants).set({ approvedTags: current.entry.approvedTags, updatedAt: new Date() }).where(eq(tenants.id, p.tenantId)).run();
          ctx.log("meta", `app "${p.app}" already present in tenant ${p.guid} — append already committed, skipping`);
          return;
        }
        // The app starts on the newest available version of every build, fixed as its own (#296), beside
        // the bundle the registration names, which record-apps-repo moved to this pass's build.
        const approved = await addedMemberVersions(ports, p.stage, current.entry, p.app, p.member, ctx);
        const { commit, approvedTags } = await ports.registrations.updateTenantApps(p.stage, p.guid, { op: "append", app: p.app, ...(p.website ? { website: p.website } : {}), member: p.member, approved, seedReference: p.seedReference, seedDemo: p.seedDemo, selections: p.selections, ...(p.databases ? { databases: p.databases } : {}), runId: ctx.runId });
        ctx.db.update(tenants).set({ approvedTags, updatedAt: new Date() }).where(eq(tenants.id, p.tenantId)).run();
        ctx.checkpoint({ commit, app: p.app });
        ctx.log("meta", `app "${p.app}" appended to tenant ${p.guid} (${commit}) — the master ArgoCD will now generate the new Application`);
      },
    },
    {
      name: "watch-sync-set",
      title: "Wait for ArgoCD to sync the new app at the pinned commit",
      run: async (ctx) => {
        // Watch ONLY the NEW member's Application — the rest of the fan-out is already live, so waiting
        // on it would be redundant. Filtered by platform/tenant=<guid>; an absent member reads Missing.
        const until = syncedAt(p.expectedApps);
        const { argoReader, argoNamespace } = await ports.resolver.resolve(p.clusterId);
        const byName = await argoReader.watchApplicationSet(argoNamespace, p.expectedApps, until, {
          timeoutMs: ports.argoWatchTimeoutMs,
          signal: ctx.signal,
          labelSelector: `platform/tenant=${p.guid}`,
        });
        if (!until(byName)) throw errValidation(`tenant ${p.guid} fan-out did not converge — ${describeUnsynced(p.expectedApps, byName)}`);
        ctx.log("meta", `app "${p.app}" Application(s) are Synced + Healthy at ${p.chartsRef.slice(0, 7)}`);
      },
    },
    // A website's hosts: their records, then the wait until it answers there.
    ...websiteSteps(ports, p),
    {
      name: "smoke",
      title: "Smoke-check the new member's namespace",
      run: async (ctx) => {
        const { clusterReader } = await ports.resolver.resolve(p.clusterId);
        const smoke = await clusterReader.smoke(ns);
        if (!smoke.namespaceExists) throw errValidation(`namespace ${ns} does not exist`);
        const failing = smoke.workloads.filter((w) => !w.available);
        if (failing.length) {
          throw errValidation(`workloads not available in ${ns}: ${failing.map((w) => `${w.kind}/${w.name}${w.message ? ` (${w.message})` : ""}`).join(", ")}`);
        }
        if (!smoke.externalSecretsReady) {
          throw errValidation(`ExternalSecrets are not all Ready in ${ns} — the new member's secrets did not materialize`);
        }
        ctx.checkpoint({ namespaceExists: true, workloads: smoke.workloads.length, externalSecretsReady: true });
        ctx.log("meta", `smoke ok — ${smoke.workloads.length} workload(s) available, external secrets ready`);
      },
    },
    {
      name: "record-inventory",
      title: "Record the new app in inventory",
      run: async (ctx) => {
        // Overwrite-idempotent: upsert the tenant_apps row on (tenantId, name) and bump the tenant
        // row's lastRunId/updatedAt. ONE tx so a crash leaves a consistent, resumable picture.
        localTx(ctx, (tx) => {
          const ex = tx.select().from(tenantApps).where(and(eq(tenantApps.tenantId, p.tenantId), eq(tenantApps.name, p.app))).get();
          const site = p.website?.site ?? null;
          if (ex) tx.update(tenantApps).set({ status: "active", lastRunId: ctx.runId, site }).where(eq(tenantApps.id, ex.id)).run();
          else tx.insert(tenantApps).values({ id: mintTenantAppId(), tenantId: p.tenantId, name: p.app, status: "active", lastRunId: ctx.runId, site }).run();
          tx.update(tenants).set({ lastRunId: ctx.runId, updatedAt: new Date() }).where(eq(tenants.id, p.tenantId)).run();
        });
        ctx.log("meta", `app "${p.app}" recorded in tenant ${p.guid}`);
      },
    },
  ];
}

/** What the plan says about a website, or nothing for an app that is none. */
function websitePlanLine(p: AddAppParams): string {
  if (!p.website) return "";
  const records = p.websiteRecordHosts.length
    ? `this run points ${p.websiteRecordHosts.join(", ")} at the tenant's zone and waits until the site answers`
    : "the tenant's own domain holds its records, and this run waits until the site answers";
  return ` It is a website of site ${p.website.site}, served at ${websiteHosts(p.website.domain)[0]}, and ${websiteHosts(p.website.domain).slice(1).join(", ")} redirects there; ${records}.`;
}

/** A website's two steps after its member syncs: its hosts' records, then the wait until it answers. */
function websiteSteps(ports: AddAppPorts, p: AddAppParams): Step[] {
  const website = p.website;
  if (!website) return [];
  return [
    provisionWebsiteRecordsStep(ports, p.tenantId, p.websiteRecordHosts, p.websiteReplacing),
    { name: "wait-website", title: `Wait until the website answers at ${websiteHosts(website.domain)[0]}`, run: (ctx) => waitForWebsite(ctx, ports, website.domain, "The website's member stands: retry this step once its records and certificate are in place, or remove the website.") },
  ];
}

export function makeAddAppDef(ports: AddAppPorts): RunDefinition<AddAppParams> {
  return {
    kind: "tenant-add-app",
    paramsSchema: AddAppParams,
    mutating: true, // mutating ⇒ steps()[0] MUST be attest-target
    plan: () => {
      throw errInternal("add-app is planned via planStream (the streaming entrypoint), not plan()");
    },
    // The streaming planner: load the live tenant (row + registration) -> refuse a duplicate app ->
    // read the tenant's own catalog off its bundle's repository -> clone the deploy repository at the books branch
    // -> render + T1..T4 the NEW app (subset) against that catalog, streamed gate-by-gate -> freeze
    // params (watch only the new app's Application). A rejection freezes the full report.
    planStream: async (rawParams, ctx) => {
      const req = AddAppRequest.parse(rawParams);
      const tc = loadTenantCluster(ctx.db, req.tenantId);
      const current = await ports.registrations.readTenant(tc.stage, tc.guid);
      if (!current) throw errNotFound(`tenant ${tc.guid} is not onboarded (no registration at ${tc.stage})`);
      // A suspended tenant renders with no workloads, so a new app's members would never come up and
      // the watch would burn the full timeout — refuse up front.
      if (current.entry.suspended) throw errValidation(`tenant ${tc.guid} is suspended — resume it before adding an app`);
      if (current.entry.apps.some((a) => a.name === req.app)) {
        throw errValidation(`app "${req.app}" already exists in tenant ${tc.guid}`);
      }
      const website = req.folder !== undefined && req.site !== undefined && req.domain !== undefined ? { folder: req.folder, site: req.site, domain: req.domain } : undefined;
      if (website) {
        if (tc.routing !== "path") throw errValidation(WEBSITE_NEEDS_PATH(tc.subdomain, tc.routing));
        const serving = current.entry.apps.find((a) => a.domain === website.domain);
        if (serving) throw errValidation(`${website.domain} is already the domain of website "${serving.name}" in tenant ${tc.guid}`);
        const apex = await ports.resolveUnitApex(tc.domain, tc.stage);
        const websites = await otherTenantsWebsiteHosts(ports.registrations, tc.guid);
        for (const host of websiteHosts(website.domain)) {
          const problem = customerHostProblem(ctx.db, tc.tenantId, host, apex, websites);
          if (problem !== null) throw errValidation(problem);
        }
      }
      // Every app lives in the tenant's own bundle, and the deploy repository's TEMPLATE names what can be
      // added (#213, #215): the app is judged against the template's catalog, and the bundle steps
      // carry its folder and entry into the tenant's repository — creating the repository where
      // none stood (a tenant onboarded as its platform alone), appending to it where one does. The
      // fan-out is rendered at the tag the bundle stands at (the placeholder where it is not built
      // yet), exactly as create-tenant renders a tenant born with apps; refresh-images re-renders at
      // the built tag before the image gate. The bundle's NAME is the composer's (#216), never the
      // registration's: a registration naming another bundle is stale, and record-apps-repo
      // overwrites it with what this run created.
      const { appsImage: standingImage, appsImageTag: standingTag } = current.entry;
      const clusterValueFiles = await ports.resolveClusterValueFiles(tc.domain, tc.stage);
      const registryHost = registryHostFromChain(clusterValueFiles);
      if (!ports.githubApp) throw errValidation(NO_GITHUB_APP);
      const resolved = await resolveTenantAppsUnit(ports, { subdomain: current.entry.subdomain, chosen: [appFolder({ name: req.app, ...website })], ...(website ? { sites: { [website.folder]: [website.site] } } : {}), spec: await readTenantSpec(ports, ctx), owners: (org) => readOwnerIdentity(ctx.db, org), signal: ctx.signal, log: ctx.log });
      if (resolved.outcome === "refused") throw errValidation(resolved.why);
      const appsUnit = resolved.unit;
      const appsImage = tenantAppsUnit(appsUnit.templateBuild, current.entry.subdomain);
      const hasBundle = Boolean(current.entry.appsRepo && standingImage === appsImage && standingTag);
      const appsImageTag = hasBundle ? standingTag! : placeholderTagFromChain(clusterValueFiles);
      ctx.log(hasBundle
        ? `tenant ${tc.guid}'s bundle ${appsUnit.org}/${appsImage} gains "${req.app}" from ${appsUnit.templateRepoURL}, is built and recorded before the member is fanned out`
        : `tenant ${tc.guid} has no apps bundle yet — this run creates ${appsUnit.org}/${appsImage} from ${appsUnit.templateRepoURL} with "${req.app}" as its first app, builds it and records it before the member is fanned out`);
      // The registration is the GitOps truth for the tenant's target slave; apply-appproject pins the
      // new member's project against exactly it.
      const { cluster } = current.entry;
      const outcome = await validateTenant(
        {
          repoURL: ports.deployRepoUrl,
          // The revision the member Application will read its chart at, and therefore the only one
          // worth rendering the gates over (tenant-registrations.ts, the `branch` getter).
          ref: ports.registrations.branch,
          stage: tc.stage,
          apps: [{ name: req.app, ...website, seedReference: req.seedReference, seedDemo: req.seedDemo, selections: req.selections }],
          probeGuid: tc.guid,
          subdomain: current.entry.subdomain,
          seedUsers: current.entry.seedUsers,
          demo: current.entry.demo === true,
          // The tenant's own bundle, as the appset delivers it: the new app's engine renders with it
          // and ensure-images probes it.
          appsImage,
          appsImageTag,
          clusterValueFiles,
          ...(ports.deployCredentialId ? { credentialId: ports.deployCredentialId } : {}),
        },
        { repo: ports.repo, helm: ports.helm, log: ctx.log, signal: ctx.signal },
      );
      if (outcome.verdict !== "pass") {
        const failed = outcome.report.gates.filter((g) => g.status !== "pass");
        return {
          outcome: "rejected",
          summary: `Adding app "${req.app}" to tenant ${tc.guid} was rejected — ${failed.length} gate(s) did not pass: ${failed.map((g) => g.id).join(", ")}`,
          planJson: outcome.report,
        };
      }
      // The new app's member, out of the SAME validation the gates passed on: the subset resolves the
      // standing members plus this one app, so exactly one entry of the outcome is it.
      const newMember = outcome.memberRecords.find((m) => m.name === req.app);
      if (!newMember) throw errValidation(`the validated fan-out has no member for app "${req.app}" — the tenant product's manifest does not build one`);
      // The bundle this run builds, beside the new app's engines at their stage pins (engine-line.ts).
      throwEngineLineRefusal(await newMembersRefusal({ engine: await builtBundleEngine(ports, hasBundle ? current.entry.appsRepo : undefined, resolved.unit.engine, ctx), held: current.entry.approvedTags, newMembers: [newMember], pinned: (chart) => ports.registrations.listPinnedBuilds(tc.stage, chart) }), `app "${req.app}" cannot be added to tenant ${tc.subdomain}`);
      const expectedApps = [memberApplication(tc.guid, req.app, tc.stage)];
      // Freeze the ensure-images set for the SUBSET render (the trio + the new app), filtered to
      // the tenant cluster's registry host — the already-live members' images are provably present.
      const requiredImages = requiredImagesFrom(outcome.images, registryHost);
      // The units that build what the registry lacks, exactly as create-tenant plans them (#214): an
      // app added after the platform pulls images no earlier run had to build.
      const planned = await planBuildUnits({
        requiredImages, registryHost, buildRepos: outcome.spec?.buildRepos ?? [], appsBundle: outcome.spec?.appsBundle, appsImage, probe: ports.registryProbe,
        registration: ports.buildUnitRegistration ?? (async () => null), githubApp: ports.githubApp, owners: (org) => readOwnerIdentity(ctx.db, org), stage: tc.stage, subdomain: current.entry.subdomain, signal: ctx.signal, log: ctx.log,
      });
      if (planned.outcome === "rejected") return { outcome: "rejected", summary: planned.summary, planJson: outcome.report };
      const built = planned.builds;
      // The argo-sync grant's subjects, derived like create-tenant's: the units that attest a build
      // this render pulls. The subset render carries the trio too, so the units of the members that
      // are already serving come along and the re-rendered grant keeps arming them.
      const syncUnits = tenantSyncUnits(requiredImages, await ports.attestedBuilds());
      const params: AddAppParams = {
        tenantId: tc.tenantId,
        guid: tc.guid,
        stage: tc.stage,
        clusterId: tc.clusterId,
        domain: tc.domain,
        cluster,
        chartsRef: outcome.resolvedSha,
        registryHost,
        app: req.app,
        member: newMember,
        seedReference: req.seedReference, // reference tier for the appended apps[] entry
        seedDemo: req.seedDemo, // demo tier for the appended apps[] entry
        ...(outcome.appDatabases[req.app] ? { databases: outcome.appDatabases[req.app] } : {}),
        selections: req.selections, // every further selection, as T4 held it against the catalog
        report: outcome.report,
        expectedApps,
        requiredImages,
        syncUnits,
        buildUnits: built.units,
        deployRepoUrl: ports.deployRepoUrl,
        appsUnit,
        appsImage,
        subdomain: current.entry.subdomain,
        owner: tc.owner,
        seedUsers: current.entry.seedUsers,
        demo: current.entry.demo === true,
        ...(website ? { website } : {}),
        websiteRecordHosts: website ? websiteRecordHosts(website.domain, current.entry) : [],
        websiteReplacing: website ? await websiteRecordsToReplace(ctx.db, ports, tc, websiteRecordHosts(website.domain, current.entry), ctx.signal) : [],
      };
      const stepDefs = addAppSteps(ports, params);
      const plan: Plan = {
        kind: "tenant-add-app",
        targetKind: "tenant",
        targetId: tc.tenantId,
        summary: `Add app "${req.app}" to tenant ${tc.guid} on ${tc.domain} (${tc.stage}), validated at deploy repository ${outcome.resolvedSha.slice(0, 7)}: ${stepDefs.length} steps.${websitePlanLine(params)}${hasBundle ? ` The tenant's own apps repository ${appsUnit.org}/${appsImage} gains "${req.app}" from ${appsUnit.templateRepoURL} and is built first` : ` The tenant's own apps repository ${appsUnit.org}/${appsImage} is created from ${appsUnit.templateRepoURL} with "${req.app}", onboarded build-only and built first`}; the member is fanned out at the built tag.${replacementSentence(params.websiteReplacing)}`,
        steps: stepDefs.map((s) => ({ name: s.name, title: s.title })),
        targets: [],
        locks: tenantLocks(ports.registrations),
        warnings: built.warnings,
        requiredSecrets: [], // a build unit's identity is its owner's, never asked at approve (#220)
      };
      return { outcome: "planned", params, plan };
    },
    steps: (params) => addAppSteps(ports, params),
    cleanups: (params) => [revertAppendCleanup(ports, params), removeWebsiteRecordsCleanup(ports, params.tenantId, params.websiteRecordHosts, params.websiteReplacing)],
    // The rollback's precondition: the drop above is destructive by cascade (the member's databases go
    // with its ServiceClaim), so it must never fire for a run whose NEW member has meanwhile gone live.
    assertAbortable: (params, deps) => assertAddAppAbortable(ports, params, deps.db),
  };
}
