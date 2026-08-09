import { z } from "zod";
import { and, eq } from "drizzle-orm";
import type { RunDefinition, Step, Cleanup, Plan } from "../../executor/types.ts";
import type { Db } from "../../db/client.ts";
import { tenants, tenantApps } from "../../db/schema/inventory.ts";
import { tenantAppId as mintTenantAppId } from "../../kernel/ids.ts";
import { STAGE } from "../../../shared/enums.ts";
import { guid as guidSchema, appName, TenantMemberRecordSchema, TenantValidationReportSchema } from "../../../shared/tenant.ts";
import { AppError, errNotFound, errValidation } from "../../kernel/errors.ts";
import { localTx } from "../../executor/stepkit.ts";
import { validateTenant } from "./validate-tenant.ts";
import { registryHostFromChain } from "./tenant-values.ts";
import { RequiredImageSchema, requiredImagesFrom, ensureImagesStep } from "./ensure-images.ts";
import { assertDeployState, loadTenantCluster } from "./lifecycle.ts";
import { renderTenantAppProject } from "./appproject.ts";
import { renderTenantMemberAdmissionPolicy } from "./admission-policy.ts";
import { renderTenantArgoSync, tenantSyncUnits } from "./build-rbac.ts";
import { memberApplication, memberNamespace, tenantApplicationSet } from "./tenant-fanout.ts";
import { CATALOG_CHART_BRANCH } from "./tenant-registry.ts";
import type { TenantOnboardPorts } from "./create-tenant.run.ts";
import { tenantLocks } from "./tenant-lifecycle.run.ts";
import { syncedAt, describeUnsynced } from "./tenant-watch.ts";

// The "add-app" Run. The subset sibling of
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
  // The catalog revision this run VALIDATED at — a run fact, not a registration field: the
  // frozen expectedApps/requiredImages were computed from exactly this tree.
  chartsRef: z.string().regex(/^[0-9a-f]{40}$/),
  // The registry host the new app's images are pulled from and probed against — the tenant
  // cluster's own chain (ports.resolveClusterValueFiles -> registryHostFromChain), frozen at plan time.
  registryHost: z.string().min(1),
  app: appName, // the new app being fanned in
  // The new app's MEMBER, resolved from the product manifest at the revision this run validated. The
  // registration's members[] is what the ApplicationSet fans out over, so an appended app that added
  // no member would be recorded as owned and never deployed; frozen here so the append writes what
  // was approved rather than what the manifest says when the step runs.
  member: TenantMemberRecordSchema,
  // Per-app seed tiers — written into the registration's apps[] entry.
  seedReference: z.boolean().default(false), // reference tier → SEED_APP_DATA_ON_BOOT
  seedDemo: z.boolean().default(false), // demo tier → SEED_DEMO_DATA_ON_BOOT
  report: TenantValidationReportSchema, // the fresh subset validation report (audit; not re-committed)
  expectedApps: z.array(z.string()), // ONLY the new member's Application: memberApplication(guid,app,stage)
  // The registry images the NEW app's subset render pulls (filtered to registryHost above) —
  // the ensure-images step probes/builds these BEFORE append-app,
  // exactly like create-tenant. pipeline null ⇒ probe-only (consumer-built, never built here).
  requiredImages: z.array(RequiredImageSchema).default([]),
  // The build units the re-rendered argo-sync grant arms — resolved at plan time from the images
  // above, exactly as create-tenant resolves its own (tenantSyncUnits).
  syncUnits: z.array(z.string()).default([]),
  catalogRepoUrl: z.string().min(1),
});
export type AddAppParams = z.infer<typeof AddAppParams>;

/** The raw operator request from the add-app wizard: the target tenant + the new app name. */
export const AddAppRequest = z.object({
  tenantId: z.string().startsWith("tnt_"),
  app: appName,
  // Per-app seed tiers for the app being added; default off. Reference = roles/nav (operator
  // apps need it), Demo = sample records.
  seedReference: z.boolean().default(false),
  seedDemo: z.boolean().default(false),
});
export type AddAppRequest = z.infer<typeof AddAppRequest>;

/** The inverse of append-app — registered by append-app, run only on an explicit abort-with-cleanup.
 *  Drops the ONE app this run appended. Read-first: an app the registration does not carry was never
 *  appended (or is already dropped), so the drop is skipped instead of the registry's refusal being
 *  swallowed — a real git failure now propagates and fails the cleanup step visibly, where the old
 *  bare catch reported it as a completed rollback. The new member's namespace, AppProject and
 *  admission policy are cluster state and stay (soft state, re-addable) — only tenant-purge reaps a
 *  tenant's namespaces, which is why add-app registers no project or policy delete. */
function revertAppendCleanup(ports: TenantOnboardPorts, p: AddAppParams): Cleanup {
  return {
    name: "revert-app-append",
    title: "Drop the appended app from the tenant registration",
    run: async (ctx) => {
      const current = await ports.registry.readTenant(p.stage, p.guid);
      if (!current || !current.entry.apps.some((a) => a.name === p.app)) {
        ctx.log("meta", `app "${p.app}" is not in tenant ${p.guid}'s registration — nothing to drop`);
        return;
      }
      const { commit } = await ports.registry.updateTenantApps(p.stage, p.guid, { op: "drop", app: p.app, runId: ctx.runId });
      ctx.log("meta", `app "${p.app}" dropped from tenant ${p.guid} (${commit}) — ArgoCD will now prune only this member's Application`);
    },
  };
}

/** The abort's PRECONDITION (RunDefinition.assertAbortable), keyed on the NEW MEMBER and never on the
 *  tenant: add-app only ever targets a live tenant, so the tenant-level rule (assertTenantNotLive)
 *  would refuse EVERY add-app abort. What the rollback drops is the one appended apps[] entry — and
 *  that drop is destructive by cascade: the appset stops generating the member's Application, ArgoCD
 *  prunes it, the member's ServiceClaim is deleted and the service-provisioner drops its databases
 *  with its user. So the question is whether THIS member is live, asked from both ends:
 *
 *  1. THE INVENTORY ROW — record-inventory settled the member "active" (the run failed only after it,
 *     or a later run settled it), so the product advertises a serving member the abort would delete.
 *  2. THE CLUSTER, when the row does not say live: the run died at watch-sync-set or smoke, which
 *     cannot tell A STEP THAT FAILED from A STEP THAT TIMED OUT WHILE SUCCEEDING — the member can
 *     converge after the watch budget and carry data by the time anyone aborts. The member's
 *     Application is read back at the moment the abort asks; Synced + Healthy means the run's work
 *     is live, and the way to make the record agree with the cluster is a RETRY (every step re-reads
 *     the world: the watch passes, record-inventory writes the row, the run settles green).
 *
 *  Both ends are asked only while the registration still CARRIES the app — an entry already dropped
 *  generates nothing, and the rollback then has nothing live to reach. Fail-closed: an unreadable
 *  registration or ArgoCD propagates, since "cannot read" is never "is not there". */
async function assertAddAppAbortable(ports: TenantOnboardPorts, p: AddAppParams, db: Db): Promise<void> {
  const current = await ports.registry.readTenant(p.stage, p.guid);
  if (!current || !current.entry.apps.some((a) => a.name === p.app)) return;
  const rollback =
    `aborting this add-app would drop "${p.app}" from the registration, ArgoCD would prune the member's Application, and the prune deletes its ServiceClaim — ` +
    `the service-provisioner then drops the member's databases and user`;
  const row = db
    .select({ status: tenantApps.status })
    .from(tenantApps)
    .where(and(eq(tenantApps.tenantId, p.tenantId), eq(tenantApps.name, p.app)))
    .get();
  const rowLive = row?.status === "active";
  let clusterLive = false;
  if (!rowLive) {
    const { argoReader, argoNamespace } = await ports.resolver.resolve(p.clusterId);
    const status = await argoReader.getApplication(argoNamespace, memberApplication(p.guid, p.app, p.stage));
    clusterLive = status !== null && status.sync === "Synced" && status.health === "Healthy";
  }
  if (!rowLive && !clusterLive) return;
  throw errValidation(
    `app "${p.app}" of tenant ${p.guid} is ${rowLive ? "recorded active and its registration entry is generating a member" : "LIVE on the cluster (its member Application reads Synced/Healthy)"} — ${rollback}: data loss on a member that is serving. ` +
      `Retry the run from its failed step instead so it records the member and settles green, or use remove-app to take a live member out deliberately — its prune drops the member's databases too, so back them up first. ` +
      `This run has nothing left to roll back; delete the run once you no longer need its log.`,
  );
}

function addAppSteps(ports: TenantOnboardPorts, p: AddAppParams): Step[] {
  const ns = memberNamespace(p.guid, p.app); // the NEW member's own namespace — no sibling is touched
  return [
    {
      name: "attest-target",
      title: "Attest the target cluster (deploy-state fresh)",
      run: async (ctx) => {
        // Fail closed on a drifted/absent deploy-state, exactly like create-tenant (shared helper).
        // Read it on the TARGET cluster's own reader (a slave over its bearer).
        const { clusterReader } = await ports.resolver.resolve(p.clusterId);
        const state = assertDeployState(await clusterReader.readDeployState(), p.domain, p.stage, "tenant");
        ctx.log("meta", `target ${p.domain} (${p.stage}) attested for ${p.guid} — deploy-state generation ${state.generation}`);
      },
    },
    // The image gate, the SAME step create-tenant runs: the new app's pinned images must EXIST in
    // the tenant cluster's registry before the pointer append fans it out. A probe — a missing image fails
    // the run naming every absent tag, and nothing is built here.
    ensureImagesStep(ports, p),
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
          argoNamespace,
          catalogRepoUrl: p.catalogRepoUrl,
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
        const current = await ports.registry.readTenant(p.stage, p.guid);
        if (!current) throw errNotFound(`tenant ${p.guid} is not onboarded (no registration) — cannot extend its argo-sync grant`);
        const names = current.entry.members.map((m) => m.name);
        const applications = tenantApplicationSet(names.includes(p.app) ? names : [...names, p.app], p.guid, p.stage);
        const { argoNamespace } = await ports.resolver.resolve(p.clusterId);
        const syncGrant = renderTenantArgoSync({ guid: p.guid, applications, argoNamespace, units: p.syncUnits });
        await ports.buildRbac.applyBuildRbac([syncGrant]);
        ctx.checkpoint({ argoSync: `${argoNamespace}/${syncGrant.role.metadata.name}`, applications, units: p.syncUnits });
        ctx.log("meta", `argo-sync grant ${syncGrant.role.metadata.name} now names ${applications.length} Application(s) of tenant ${p.guid}, "${p.app}" included`);
      },
    },
    {
      name: "append-app",
      title: "Append the new app to the tenant registration",
      run: async (ctx) => {
        // Register the inverse BEFORE the commit so an abort-with-cleanup drops the app this run adds.
        // Idempotent on a resume: if a prior partial run already committed the append, skip re-appending
        // (updateTenantApps refuses a duplicate) but keep the cleanup registered.
        ctx.registerCleanup(revertAppendCleanup(ports, p));
        const current = await ports.registry.readTenant(p.stage, p.guid);
        if (!current) throw errNotFound(`tenant ${p.guid} is not onboarded (no registration) — cannot append an app`);
        if (current.entry.apps.some((a) => a.name === p.app)) {
          ctx.log("meta", `app "${p.app}" already present in tenant ${p.guid} — append already committed, skipping`);
          return;
        }
        const { commit } = await ports.registry.updateTenantApps(p.stage, p.guid, { op: "append", app: p.app, member: p.member, seedReference: p.seedReference, seedDemo: p.seedDemo, runId: ctx.runId });
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
        if (!until(byName)) throw errValidation(describeUnsynced(p.expectedApps, byName));
        ctx.log("meta", `app "${p.app}" Application(s) are Synced + Healthy at ${p.chartsRef.slice(0, 7)}`);
      },
    },
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
          if (ex) tx.update(tenantApps).set({ status: "active", lastRunId: ctx.runId }).where(eq(tenantApps.id, ex.id)).run();
          else tx.insert(tenantApps).values({ id: mintTenantAppId(), tenantId: p.tenantId, name: p.app, status: "active", lastRunId: ctx.runId }).run();
          tx.update(tenants).set({ lastRunId: ctx.runId, updatedAt: new Date() }).where(eq(tenants.id, p.tenantId)).run();
        });
        ctx.log("meta", `app "${p.app}" recorded in tenant ${p.guid}`);
      },
    },
  ];
}

export function makeAddAppDef(ports: TenantOnboardPorts): RunDefinition<AddAppParams> {
  return {
    kind: "add-app",
    paramsSchema: AddAppParams,
    mutating: true, // mutating ⇒ steps()[0] MUST be attest-target
    plan: () => {
      throw new AppError("INTERNAL", "add-app is planned via planStream (the streaming entrypoint), not plan()");
    },
    // The streaming planner: load the live tenant (row + registration) -> refuse a duplicate app ->
    // clone catalog at the tenant's pin -> render + T1..T4 the NEW app (subset), streamed
    // gate-by-gate -> freeze params (watch only the new app's Application). A rejection freezes the
    // full report.
    planStream: async (rawParams, ctx) => {
      const req = AddAppRequest.parse(rawParams);
      const tc = loadTenantCluster(ctx.db, req.tenantId);
      const current = await ports.registry.readTenant(tc.stage, tc.guid);
      if (!current) throw errNotFound(`tenant ${tc.guid} is not onboarded (no registration at ${tc.stage})`);
      // A suspended tenant renders with no workloads, so a new app's members would never come up and
      // the watch would burn the full timeout — refuse up front.
      if (current.entry.suspended) throw errValidation(`tenant ${tc.guid} is suspended — resume it before adding an app`);
      if (current.entry.apps.some((a) => a.name === req.app)) {
        throw errValidation(`app "${req.app}" already exists in tenant ${tc.guid}`);
      }
      // The registration is the GitOps truth for the tenant's target slave; apply-appproject pins the
      // new member's project against exactly it.
      const { cluster } = current.entry;
      const clusterValueFiles = await ports.resolveClusterValueFiles(tc.domain, tc.stage);
      const registryHost = registryHostFromChain(clusterValueFiles);
      const outcome = await validateTenant(
        {
          repoURL: ports.catalogRepoUrl,
          ref: CATALOG_CHART_BRANCH,
          stage: tc.stage,
          apps: [{ name: req.app }],
          probeGuid: tc.guid,
          clusterValueFiles,
          ...(ports.catalogCredentialId ? { credentialId: ports.catalogCredentialId } : {}),
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
      const expectedApps = [memberApplication(tc.guid, req.app, tc.stage)];
      // Freeze the ensure-images set for the SUBSET render (the trio + the new app), filtered to
      // the tenant cluster's registry host — the already-live members' images are provably present.
      const requiredImages = requiredImagesFrom(outcome.images, registryHost);
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
        report: outcome.report,
        expectedApps,
        requiredImages,
        syncUnits,
        catalogRepoUrl: ports.catalogRepoUrl,
      };
      const stepDefs = addAppSteps(ports, params);
      const plan: Plan = {
        kind: "add-app",
        targetKind: "tenant",
        targetId: tc.tenantId,
        summary: `Add app "${req.app}" to tenant ${tc.guid} on ${tc.domain} (${tc.stage}), validated at catalog ${outcome.resolvedSha.slice(0, 7)}: ${stepDefs.length} steps.`,
        steps: stepDefs.map((s) => ({ name: s.name, title: s.title })),
        targets: [],
        locks: tenantLocks(ports.registry),
        warnings: [],
        requiredSecrets: [],
      };
      return { outcome: "planned", params, plan };
    },
    steps: (params) => addAppSteps(ports, params),
    cleanups: (params) => [revertAppendCleanup(ports, params)],
    // The rollback's precondition: the drop above is destructive by cascade (the member's databases go
    // with its ServiceClaim), so it must never fire for a run whose NEW member has meanwhile gone live.
    assertAbortable: (params, deps) => assertAddAppAbortable(ports, params, deps.db),
  };
}
