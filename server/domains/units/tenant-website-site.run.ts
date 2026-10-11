import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { eq } from "drizzle-orm";
import type { RunDefinition, Step } from "../../executor/types.ts";
import { tenants } from "../../db/schema/inventory.ts";
import { appName, approvedImageTag, siteId, TenantAppSchema, TenantMemberRecordSchema } from "../../../shared/tenant.ts";
import { parseReleaseTag } from "../../../shared/release.ts";
import { errInternal, errNotFound, errValidation } from "../../kernel/errors.ts";
import { attestTenantTargetStep, loadTenantCluster } from "./lifecycle.ts";
import { tenantLocks } from "./tenant-lifecycle.run.ts";
import { validateTenant } from "./validate-tenant.ts";
import type { AddAppPorts } from "./add-app.run.ts";
import { bundleFolderSites, bundleLacksSite, bundleReleaseTag, engineLineRefusal, standingAppNeeds, tenantBundleManifest } from "./engine-line.ts";
import { registryHostFromChain } from "./tenant-values.ts";

// `tenant-set-website-site` — move one website of a standing tenant to another site of its bundle.
//
// A website's site is baked into its member entry: its engine and its renderer boot with SITE_ID and
// serve `sites/<site>/` of the tenant's bundle. Every member of the tenant mounts that one bundle, at
// the registration's appsImageTag. So the run writes the site, the member resolved again with it, and
// the bundle release that carries the site in ONE commit: no pod boots with a site its bundle does not
// hold. Nothing is removed — the website keeps its name, databases, secrets and keys.
//
// The bundle's migration renames the website's stored records at its first boot, so writing the
// previous site and bundle back would serve an empty site. The run registers no undo, and refuses an
// abort once its write stands.

export const TenantSetWebsiteSiteRequest = z.object({
  tenantId: z.string().startsWith("tnt_"),
  app: appName,
  /** The site the website serves from now on. */
  site: siteId,
  /** The image tag of the tenant's bundle release that carries the site. */
  appsImageTag: approvedImageTag,
});

export const TenantSetWebsiteSiteParams = z.object({
  tenantId: z.string().startsWith("tnt_"),
  app: appName,
  site: siteId,
  previousSite: siteId,
  appsImageTag: approvedImageTag,
  previousAppsImageTag: approvedImageTag,
  /** The website's apps[] entry as the plan read it. */
  previousEntry: TenantAppSchema,
  /** The member entry resolved with the new site and bundle, and the one it replaces. */
  member: TenantMemberRecordSchema,
  previousMember: TenantMemberRecordSchema,
});
export type TenantSetWebsiteSiteParams = z.infer<typeof TenantSetWebsiteSiteParams>;

function websiteSiteSteps(ports: AddAppPorts, p: TenantSetWebsiteSiteParams): Step[] {
  return [
    attestTenantTargetStep(ports, p.tenantId),
    {
      name: "write-website-site",
      title: "Record the website's site, its member entry and the bundle release on the registration in one commit",
      run: async (ctx) => {
        const tc = loadTenantCluster(ctx.db, p.tenantId);
        const entry = (await ports.registrations.readTenant(tc.stage, tc.guid))?.entry;
        // The entry the write leaves: parsed again with the site, because the schema derives the path the website answers at from it.
        const stands = (site: string, tag: string, member: unknown): boolean =>
          entry?.appsImageTag === tag &&
          isDeepStrictEqual(entry.apps.find((a) => a.name === p.app), TenantAppSchema.parse({ ...p.previousEntry, site })) &&
          isDeepStrictEqual(entry.members.find((m) => m.name === p.app), member);
        // A resume finds its own write standing.
        if (stands(p.site, p.appsImageTag, p.member)) {
          ctx.log("meta", `website ${p.app} already serves site ${p.site} on ${p.appsImageTag}`);
          return;
        }
        // The plan's facts, asked again: another run may have moved the website or the bundle since.
        if (!stands(p.previousSite, p.previousAppsImageTag, p.previousMember)) {
          throw errValidation(`website ${p.app} or the tenant's bundle changed since this run was planned — plan it again`);
        }
        const { commit } = await ports.registrations.setWebsiteSite(tc.stage, tc.guid, p.app, p.site, p.member, p.appsImageTag, ctx.runId);
        ctx.db.update(tenants).set({ lastRunId: ctx.runId }).where(eq(tenants.id, p.tenantId)).run();
        ctx.checkpoint({ commit });
        ctx.log("meta", `website ${p.app}: site ${p.previousSite} → ${p.site}, bundle ${p.previousAppsImageTag} → ${p.appsImageTag} (${commit}) — the tenant's members roll onto it once the ArgoCD on ${tc.domain} syncs`);
      },
    },
  ];
}

export function makeTenantSetWebsiteSiteDef(ports: AddAppPorts): RunDefinition<TenantSetWebsiteSiteParams> {
  return {
    kind: "tenant-set-website-site",
    paramsSchema: TenantSetWebsiteSiteParams,
    mutating: true,
    plan: () => {
      throw errInternal("tenant-set-website-site is planned via planStream, not plan()");
    },
    planStream: async (rawParams, ctx) => {
      const req = TenantSetWebsiteSiteRequest.parse(rawParams);
      const tc = loadTenantCluster(ctx.db, req.tenantId);
      const current = await ports.registrations.readTenant(tc.stage, tc.guid);
      if (!current) throw errNotFound(`tenant ${tc.guid} is not onboarded (no registration at ${tc.stage})`);
      const entry = current.entry.apps.find((a) => a.name === req.app);
      if (!entry?.folder || !entry.site) throw errValidation(`app "${req.app}" of tenant ${tc.guid} is no website — it names no folder and site`);
      if (entry.site === req.site) throw errValidation(`website ${req.app} already serves site ${req.site}`);
      const serving = current.entry.apps.find((a) => a.name !== req.app && a.site === req.site);
      if (serving) throw errValidation(`${req.site} is already the site of website "${serving.name}" in tenant ${tc.guid}`);
      const { appsRepo, appsImage, appsImageTag: previousAppsImageTag } = current.entry;
      if (!appsRepo || !appsImage || !previousAppsImageTag) throw errValidation(`tenant ${tc.guid} runs no apps bundle of its own, so no release of it carries a site`);
      const runs = parseReleaseTag(bundleReleaseTag(previousAppsImageTag));
      const target = parseReleaseTag(bundleReleaseTag(req.appsImageTag));
      if (!runs || !target) throw errValidation(`the bundle the tenant runs, ${previousAppsImageTag}, is no image tag <x.y.z>-<channel>-<ts14>-<sha7>`);
      if (target.ts14 < runs.ts14) throw errValidation(`the bundle ${req.appsImageTag} is older than ${previousAppsImageTag}, the bundle the tenant runs`);
      const release = bundleReleaseTag(req.appsImageTag);
      const manifest = await tenantBundleManifest(ports, { appsRepo, appsImageTag: req.appsImageTag }, ctx.signal);
      if (!manifest || !bundleFolderSites(manifest, entry.folder)?.includes(req.site)) {
        throw errValidation(bundleLacksSite({ appsRepo, appsImageTag: req.appsImageTag }, entry.folder, req.site));
      }
      const offLine = engineLineRefusal(manifest.engine, current.entry.approvedTags);
      if (offLine !== null) throw errValidation(`the bundle ${req.appsImageTag}: ${offLine}`);
      const clusterValueFiles = await ports.resolveClusterValueFiles(tc.domain, tc.stage);
      const registryHost = registryHostFromChain(clusterValueFiles);
      if (!(await ports.registryProbe.imageExists({ registryHost, repo: appsImage, tag: req.appsImageTag }, { signal: ctx.signal }))) {
        throw errValidation(`${registryHost}/${appsImage}:${req.appsImageTag} is not in the registry — release ${release} has not built it`);
      }
      const previousMember = current.entry.members.find((m) => m.name === req.app);
      if (!previousMember) throw errValidation(`website ${req.app} has no member entry in tenant ${tc.guid}'s registration`);
      // The member resolved again with the new site and bundle, by the same validation add-app renders
      // the website with.
      const appNeeds = await standingAppNeeds((bundle, signal) => tenantBundleManifest(ports, bundle, signal), current.entry, ctx);
      const outcome = await validateTenant(
        {
          repoURL: ports.deployRepoUrl,
          ref: ports.registrations.branch,
          stage: tc.stage,
          apps: [{ name: req.app, folder: entry.folder, site: req.site, seedReference: entry.seedReference, seedDemo: entry.seedDemo, selections: entry.selections }],
          isStandingTenant: true,
          appNeeds,
          probeGuid: tc.guid,
          subdomain: current.entry.subdomain,
          quota: current.entry.quota, size: current.entry.size,
          seedUsers: current.entry.seedUsers,
          demo: current.entry.demo === true,
          appsImage,
          appsImageTag: req.appsImageTag,
          clusterValueFiles,
          ...(ports.deployCredentialId ? { credentialId: ports.deployCredentialId } : {}),
        },
        { repo: ports.repo, helm: ports.helm, log: ctx.log, signal: ctx.signal },
      );
      if (outcome.verdict !== "pass") {
        const failed = outcome.report.gates.filter((g) => g.status !== "pass");
        return { outcome: "rejected", summary: `Moving website ${req.app} to site ${req.site} was rejected — ${failed.length} gate(s) did not pass: ${failed.map((g) => g.id).join(", ")}`, planJson: outcome.report };
      }
      const member = outcome.memberRecords.find((m) => m.name === req.app);
      if (!member) throw errValidation(`the validated fan-out has no member for website "${req.app}"`);
      const params: TenantSetWebsiteSiteParams = {
        tenantId: tc.tenantId, app: req.app, site: req.site, previousSite: entry.site, appsImageTag: req.appsImageTag, previousAppsImageTag, previousEntry: entry, member, previousMember,
      };
      const steps = websiteSiteSteps(ports, params);
      return {
        outcome: "planned",
        params,
        plan: {
          kind: "tenant-set-website-site",
          targetKind: "tenant",
          targetId: tc.tenantId,
          summary:
            `Move website ${req.app} of tenant ${tc.guid} (${tc.domain}, ${tc.stage}) from site ${entry.site} to site ${req.site}, ` +
            `and the tenant's apps bundle from ${previousAppsImageTag} to ${req.appsImageTag}, in one commit. Every member of the tenant mounts that bundle, ` +
            `so all of them roll onto it, and the website's engine and renderer boot with site ${req.site}. Nothing is removed: the website keeps its name, ` +
            `databases, secrets and keys. The bundle's migration renames the website's stored records at its first boot, so no abort moves it back: ` +
            `a later move needs a release that carries site ${entry.site} and a migration back.`,
          steps: steps.map((s) => ({ name: s.name, title: s.title })),
          targets: [],
          locks: tenantLocks(ports.registrations),
          warnings: [],
          requiredSecrets: [],
        },
      };
    },
    steps: (params) => websiteSiteSteps(ports, params),
    cleanups: () => [],
    // Refused once the new site is written: from then on the website's members may boot on the new
    // bundle at any moment, and its migration renames the records the previous site served.
    assertAbortable: async (params, { db }) => {
      const tc = loadTenantCluster(db, params.tenantId);
      const site = (await ports.registrations.readTenant(tc.stage, tc.guid))?.entry.apps.find((a) => a.name === params.app)?.site;
      if (site === params.site) {
        throw errValidation(`website ${params.app} serves site ${params.site} on ${params.appsImageTag} now, and this move cannot be undone: the bundle's migration renames its records at the first boot. A move back needs a release that carries site ${params.previousSite} and a migration back.`);
      }
    },
  };
}
