import { z } from "zod";
import { eq } from "drizzle-orm";
import type { Cleanup, RunDefinition, Step } from "../../executor/types.ts";
import { tenants } from "../../db/schema/inventory.ts";
import { publicFqdn } from "../../../shared/consumer.ts";
import { appName, TenantMemberRecordSchema } from "../../../shared/tenant.ts";
import { errNotFound, errValidation, errInternal } from "../../kernel/errors.ts";
import { ownDomainEntryProblem } from "#unit/shared/unit-host.ts";
import { attestTenantTargetStep, loadTenantCluster } from "./lifecycle.ts";
import { tenantLocks } from "./tenant-lifecycle.run.ts";
import { validateTenant } from "./validate-tenant.ts";
import { customerHostProblem, removeOwnDomainRecord, replacementSentence, ReplacedRecord } from "./own-domain-records.ts";
import { otherTenantsWebsiteHosts, provisionWebsiteRecordsStep, removeWebsiteRecordsCleanup, waitForWebsite, websiteHosts, websiteRecordHosts, websiteRecordsToReplace } from "./website-domain.ts";
import { DnsZoneUnknownError } from "../../adapters/dns/port.ts";
import { WEBSITE_NEEDS_PATH, type AddAppPorts } from "./add-app.run.ts";
import { tenantBundleManifest } from "./engine-line.ts";
import { standingAppDatabases } from "./tenant-app-databases.ts";

// `tenant-set-website-domain` — move one website of a standing tenant to another domain.
//
// A website's domain is baked into its member entry (the chart serves `site.domain`), so the plan
// resolves the member again with the new domain through the same validation add-app renders with, and
// the run writes the domain and the member in one commit. The new hosts' records come first; the
// previous hosts' records go only once the website answers at the new ones, and the wait and the
// removal are one step, so skipping a failed wait removes nothing. The website keeps its name. An abort
// records the previous domain and member again and removes the new hosts' records.

export const TenantSetWebsiteDomainRequest = z.object({
  tenantId: z.string().startsWith("tnt_"),
  app: appName,
  /** The new domain, typed without `www.`. */
  domain: publicFqdn,
});

export const TenantSetWebsiteDomainParams = z.object({
  tenantId: z.string().startsWith("tnt_"),
  app: appName,
  domain: publicFqdn,
  previous: publicFqdn,
  /** The member entry resolved with the new domain, and the one it replaces. */
  member: TenantMemberRecordSchema,
  previousMember: TenantMemberRecordSchema,
  /** The new hosts whose records this run writes, and the previous hosts whose records it removes:
   *  none of those the tenant's own domain holds. */
  recordHosts: z.array(publicFqdn).default([]),
  retiredHosts: z.array(publicFqdn).default([]),
  /** The records standing at recordHosts that this run replaces; an abort writes them back. */
  replacing: z.array(ReplacedRecord).default([]),
});
export type TenantSetWebsiteDomainParams = z.infer<typeof TenantSetWebsiteDomainParams>;

/** On abort: the previous domain and member entry back on the registration. */
function restoreWebsiteDomainCleanup(ports: AddAppPorts, p: TenantSetWebsiteDomainParams): Cleanup {
  return {
    name: "restore-website-domain",
    title: `Record website ${p.app} at ${p.previous} again`,
    run: async (ctx) => {
      const tc = loadTenantCluster(ctx.db, p.tenantId);
      // Only while the website stands where this run put it: a later run's move or a removal is that run's.
      const standing = (await ports.registrations.readTenant(tc.stage, tc.guid))?.entry.apps.find((a) => a.name === p.app)?.domain;
      if (standing !== p.domain) {
        ctx.log("meta", `website ${p.app} stands at ${standing ?? "nothing"} now, not at ${p.domain} where this run put it — left as it is`);
        return;
      }
      const { commit } = await ports.registrations.setWebsiteDomain(tc.stage, tc.guid, p.app, p.previous, p.previousMember, ctx.runId);
      ctx.log("meta", `website ${p.app} back at ${p.previous} (${commit})`);
    },
  };
}

function websiteDomainSteps(ports: AddAppPorts, p: TenantSetWebsiteDomainParams): Step[] {
  return [
    attestTenantTargetStep(ports, p.tenantId),
    provisionWebsiteRecordsStep(ports, p.tenantId, p.recordHosts, p.replacing),
    {
      name: "write-website-domain",
      title: "Record the website's new domain and its member entry on the registration",
      run: async (ctx) => {
        const tc = loadTenantCluster(ctx.db, p.tenantId);
        const current = await ports.registrations.readTenant(tc.stage, tc.guid);
        const standing = current?.entry.apps.find((a) => a.name === p.app)?.domain;
        // The plan's fact, asked again: another run may have moved the website since. A resume finds
        // its own write standing.
        if (standing !== p.previous && standing !== p.domain) throw errValidation(`website ${p.app} stands at ${standing ?? "no domain"} now, not at ${p.previous} as when this run was planned — plan it again`);
        ctx.registerCleanup(restoreWebsiteDomainCleanup(ports, p));
        const { commit } = await ports.registrations.setWebsiteDomain(tc.stage, tc.guid, p.app, p.domain, p.member, ctx.runId);
        ctx.db.update(tenants).set({ lastRunId: ctx.runId, updatedAt: new Date() }).where(eq(tenants.id, p.tenantId)).run();
        ctx.checkpoint({ commit });
        ctx.log("meta", `website ${p.app}: ${p.previous} → ${p.domain} (${commit}) — its chart serves the new hosts once the ArgoCD on ${tc.domain} syncs`);
      },
    },
    {
      name: "retire-previous-website-domain",
      title: "Wait until the website answers at its new hosts, then remove the previous hosts' records",
      run: async (ctx) => {
        await waitForWebsite(ctx, ports, p.domain, `The previous hosts' records still stand: retry this step once the new ones answer, or abort the run to put the website back at ${p.previous}.`);
        const tc = loadTenantCluster(ctx.db, p.tenantId);
        for (const host of p.retiredHosts) await removeOwnDomainRecord(ctx, ports, tc, host);
      },
    },
  ];
}

export function makeTenantSetWebsiteDomainDef(ports: AddAppPorts): RunDefinition<TenantSetWebsiteDomainParams> {
  return {
    kind: "tenant-set-website-domain",
    paramsSchema: TenantSetWebsiteDomainParams,
    mutating: true,
    plan: () => {
      throw errInternal("tenant-set-website-domain is planned via planStream, not plan()");
    },
    planStream: async (rawParams, ctx) => {
      const req = TenantSetWebsiteDomainRequest.parse(rawParams);
      const tc = loadTenantCluster(ctx.db, req.tenantId);
      const current = await ports.registrations.readTenant(tc.stage, tc.guid);
      if (!current) throw errNotFound(`tenant ${tc.guid} is not onboarded (no registration at ${tc.stage})`);
      if (current.entry.suspended) throw errValidation(`tenant ${tc.guid} is suspended — its ingress is down, so the website could never answer at its new hosts; resume it first`);
      const entry = current.entry.apps.find((a) => a.name === req.app);
      if (!entry?.folder || !entry.site || !entry.domain) throw errValidation(`app "${req.app}" of tenant ${tc.guid} is no website — it names no folder, site and domain`);
      const typed = ownDomainEntryProblem(req.domain);
      if (typed !== null) throw errValidation(typed);
      if (req.domain === entry.domain) throw errValidation(`website ${req.app} is already served at ${req.domain}`);
      const serving = current.entry.apps.find((a) => a.name !== req.app && a.domain === req.domain);
      if (serving) throw errValidation(`${req.domain} is already the domain of website "${serving.name}" in tenant ${tc.guid}`);
      if (tc.routing !== "path") throw errValidation(WEBSITE_NEEDS_PATH(tc.subdomain, tc.routing));
      const apex = await ports.resolveUnitApex(tc.domain, tc.stage);
      const websites = await otherTenantsWebsiteHosts(ports.registrations, tc.guid);
      for (const host of websiteHosts(req.domain)) {
        const problem = customerHostProblem(ctx.db, tc.tenantId, host, apex, websites);
        if (problem !== null) throw errValidation(problem);
      }
      const previousMember = current.entry.members.find((m) => m.name === req.app);
      if (!previousMember) throw errValidation(`website ${req.app} has no member entry in tenant ${tc.guid}'s registration`);
      // The member resolved again with the new domain, by the same validation add-app renders the
      // website with, at the tenant's own bundle as it stands.
      const appDatabases = await standingAppDatabases((bundle, signal) => tenantBundleManifest(ports, bundle, signal), current.entry, ctx);
      const outcome = await validateTenant(
        {
          repoURL: ports.deployRepoUrl,
          ref: ports.registrations.branch,
          stage: tc.stage,
          apps: [{ name: req.app, folder: entry.folder, site: entry.site, domain: req.domain, seedReference: entry.seedReference, seedDemo: entry.seedDemo, selections: entry.selections }],
          // A standing website: its site, and its database list, may stand in the tenant's own repository alone.
          isStandingTenant: true,
          appDatabases,
          probeGuid: tc.guid,
          subdomain: current.entry.subdomain,
          seedUsers: current.entry.seedUsers,
          appsImage: current.entry.appsImage,
          appsImageTag: current.entry.appsImageTag,
          clusterValueFiles: await ports.resolveClusterValueFiles(tc.domain, tc.stage),
          ...(ports.deployCredentialId ? { credentialId: ports.deployCredentialId } : {}),
        },
        { repo: ports.repo, helm: ports.helm, log: ctx.log, signal: ctx.signal },
      );
      if (outcome.verdict !== "pass") {
        const failed = outcome.report.gates.filter((g) => g.status !== "pass");
        return { outcome: "rejected", summary: `Moving website ${req.app} to ${req.domain} was rejected — ${failed.length} gate(s) did not pass: ${failed.map((g) => g.id).join(", ")}`, planJson: outcome.report };
      }
      const member = outcome.memberRecords.find((m) => m.name === req.app);
      if (!member) throw errValidation(`the validated fan-out has no member for website "${req.app}"`);
      const recordHosts = websiteRecordHosts(req.domain, current.entry);
      const kept = new Set(recordHosts);
      const retiredHosts = websiteRecordHosts(entry.domain, current.entry).filter((h) => !kept.has(h));
      const replacing = await websiteRecordsToReplace(ctx.db, ports, tc, recordHosts, ctx.signal);
      const params: TenantSetWebsiteDomainParams = { tenantId: tc.tenantId, app: req.app, domain: req.domain, previous: entry.domain, member, previousMember, recordHosts, retiredHosts, replacing };
      const steps = websiteDomainSteps(ports, params);
      const [site, ...redirects] = websiteHosts(req.domain);
      return {
        outcome: "planned",
        params,
        plan: {
          kind: "tenant-set-website-domain",
          targetKind: "tenant",
          targetId: tc.tenantId,
          summary:
            `Move website ${req.app} of tenant ${tc.guid} from ${entry.domain} to ${req.domain} (${tc.domain}, ${tc.stage}): ` +
            `${recordHosts.length ? `point ${recordHosts.join(", ")} at the tenant's zone, ` : ""}record the domain and the member resolved with it, ` +
            `wait until https://${site}/ answers and ${redirects.map((h) => `https://${h}/`).join(", ")} redirects` +
            `${retiredHosts.length ? `, then remove the records of ${retiredHosts.join(", ")}` : ""}. The website keeps its name ${req.app}. ` +
            `From the moment the new domain is recorded, the website answers only there. ` +
            `Where this installation does not manage the DNS zone of a host, set its record (CNAME onto the tenant's zone) BEFORE approving.${replacementSentence(replacing)}`,
          steps: steps.map((s) => ({ name: s.name, title: s.title })),
          targets: [],
          locks: tenantLocks(ports.registrations),
          warnings: [],
          requiredSecrets: [],
        },
      };
    },
    steps: (params) => websiteDomainSteps(ports, params),
    cleanups: (params) => [removeWebsiteRecordsCleanup(ports, params.tenantId, params.recordHosts, params.replacing), restoreWebsiteDomainCleanup(ports, params)],
    // Refused once a previous host's record, which this installation wrote, is gone: the website then
    // stands on its new hosts alone, and the abort would move it back onto hosts that no longer point at it.
    assertAbortable: async (params) => {
      if (!ports.dns) return;
      for (const host of params.retiredHosts) {
        let standing: string | null;
        try {
          standing = await ports.dns.readRecordContent({ name: host, type: "CNAME" });
        } catch (e) {
          // A zone nobody here manages: this run never removed that record, so the abort takes nothing.
          if (e instanceof DnsZoneUnknownError) continue;
          throw e;
        }
        if (standing === null) {
          throw errValidation(`${host}, a previous host's record, is gone — the website stands on ${params.domain} alone, and an abort would move it back. Retry the run instead.`);
        }
      }
    },
  };
}
