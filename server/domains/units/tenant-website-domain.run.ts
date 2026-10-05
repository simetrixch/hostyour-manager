import { z } from "zod";
import { eq } from "drizzle-orm";
import type { Cleanup, PlanStreamCtx, PlanStreamResult, RunDefinition, Step } from "../../executor/types.ts";
import { tenants } from "../../db/schema/inventory.ts";
import { publicFqdn } from "../../../shared/consumer.ts";
import { appName, TenantMemberRecordSchema, type TenantRegistration } from "../../../shared/tenant.ts";
import { errNotFound, errValidation, errInternal } from "../../kernel/errors.ts";
import { aliasHosts, ownDomainEntryProblem, tenantOwnHosts, tenantZone } from "#unit/shared/unit-host.ts";
import { attestTenantTargetStep, loadTenantCluster } from "./lifecycle.ts";
import { tenantLocks } from "./tenant-lifecycle.run.ts";
import { validateTenant } from "./validate-tenant.ts";
import { checkMailRecordsStep, customerHostProblem, mailRecordHashes, mailRecordSentence, hostRecordStates, removeOwnDomainRecord, type HostRecordState, replacementSentence, MailRecordHash, ReplacedRecord } from "./own-domain-records.ts";
import { otherTenantsWebsiteHosts, provisionWebsiteRecordsStep, removeWebsiteRecordsCleanup, tenantWebsiteHosts, waitForWebsite, websiteHosts, websiteRecordHosts, websiteRecordsToReplace } from "./website-domain.ts";
import { DnsZoneUnknownError } from "../../adapters/dns/port.ts";
import { WEBSITE_NEEDS_PATH, type AddAppPorts } from "./add-app.run.ts";
import { tenantBundleManifest } from "./engine-line.ts";
import { standingAppDatabases } from "./tenant-app-databases.ts";
import { refuseOffStageHosts } from "./stage-hosts.ts";

// `tenant-set-website-domain` — move one website of a standing tenant to another domain, or give it
// other alias domains (the same domain with another alias list).
//
// ALIAS DOMAINS: each alias, typed without `www.`, answers with its `www.` with a permanent redirect to
// the domain (the chart's `site.aliases`, filled from the app's `{aliases}`). A MOVE KEEPS THE DOMAIN IT
// LEAVES as an alias, so links to it keep working; only a later run that drops an alias removes its
// records. An alias cannot become the domain in the same run: a browser that cached its permanent
// redirect would loop; drop the alias first. The run writes only CNAME records, and refuses to start
// where a mail record beside its hosts changed since the plan.
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
  /** The alias domains, each typed without `www.`; absent keeps the website's. */
  aliases: z.array(publicFqdn).optional(),
});

export const TenantSetWebsiteDomainParams = z.object({
  tenantId: z.string().startsWith("tnt_"),
  app: appName,
  domain: publicFqdn,
  previous: publicFqdn,
  /** The alias domains to set, and the ones the website had. */
  aliases: z.array(publicFqdn).default([]),
  previousAliases: z.array(publicFqdn).default([]),
  /** The member entry resolved with the new domain, and the one it replaces. */
  member: TenantMemberRecordSchema,
  previousMember: TenantMemberRecordSchema,
  /** The new hosts whose records this run writes, and the previous hosts whose records it removes:
   *  none of those the tenant's own domain holds. */
  recordHosts: z.array(publicFqdn).default([]),
  retiredHosts: z.array(publicFqdn).default([]),
  /** The records standing at recordHosts that this run replaces; an abort writes them back. */
  replacing: z.array(ReplacedRecord).default([]),
  /** The mail records beside the hosts the run writes or removes, hashed by the plan. */
  mailRecords: z.array(MailRecordHash).default([]),
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
      const standing = (await ports.registrations.readTenant(tc.stage, tc.guid))?.entry.apps.find((a) => a.name === p.app);
      if (!standing || !standsAt(standing, p.domain, p.aliases)) {
        ctx.log("meta", `website ${p.app} stands at ${standing?.domain ?? "nothing"} now, not as this run put it — left as it is`);
        return;
      }
      const { commit } = await ports.registrations.setWebsiteDomain(tc.stage, tc.guid, p.app, p.previous, p.previousAliases, p.previousMember, ctx.runId);
      ctx.log("meta", `website ${p.app} back at ${p.previous} (${commit})`);
    },
  };
}

/** Whether a website's apps[] entry stands at `domain` with exactly `aliases`. */
function standsAt(entry: { domain?: string | undefined; aliases?: readonly string[] | undefined }, domain: string, aliases: readonly string[]): boolean {
  const held = entry.aliases ?? [];
  return entry.domain === domain && held.length === aliases.length && held.every((a) => aliases.includes(a));
}

/** Whether the run leaves the website where it stands and only writes the host records it misses.
 *  False for params carrying no domain: the boot's guard asks a def for its steps with none. */
function isRecordRepair(p: TenantSetWebsiteDomainParams): boolean {
  return p.domain !== undefined && p.domain === p.previous && standsAt({ domain: p.previous, aliases: p.previousAliases }, p.domain, p.aliases);
}

function websiteDomainSteps(ports: AddAppPorts, p: TenantSetWebsiteDomainParams): Step[] {
  if (isRecordRepair(p)) {
    return [attestTenantTargetStep(ports, p.tenantId), checkMailRecordsStep(ports, p.mailRecords), provisionWebsiteRecordsStep(ports, p.tenantId, p.app, p.recordHosts, p.replacing)];
  }
  return [
    attestTenantTargetStep(ports, p.tenantId),
    checkMailRecordsStep(ports, p.mailRecords),
    provisionWebsiteRecordsStep(ports, p.tenantId, p.app, p.recordHosts, p.replacing, websiteHosts(p.previous, p.previousAliases)),
    {
      name: "write-website-domain",
      title: "Record the website's new domain and its member entry on the registration",
      run: async (ctx) => {
        const tc = loadTenantCluster(ctx.db, p.tenantId);
        const current = await ports.registrations.readTenant(tc.stage, tc.guid);
        const standing = current?.entry.apps.find((a) => a.name === p.app);
        // The plan's fact, asked again: another run may have moved the website since. A resume finds
        // its own write standing.
        if (!standing || (!standsAt(standing, p.previous, p.previousAliases) && !standsAt(standing, p.domain, p.aliases))) {
          throw errValidation(`website ${p.app} stands at ${standing?.domain ?? "no domain"} now, not as when this run was planned — plan it again`);
        }
        ctx.registerCleanup(restoreWebsiteDomainCleanup(ports, p));
        const { commit } = await ports.registrations.setWebsiteDomain(tc.stage, tc.guid, p.app, p.domain, p.aliases, p.member, ctx.runId);
        ctx.db.update(tenants).set({ lastRunId: ctx.runId, updatedAt: new Date() }).where(eq(tenants.id, p.tenantId)).run();
        ctx.checkpoint({ commit });
        ctx.log("meta", `website ${p.app}: ${p.previous} → ${p.domain}${p.aliases.length ? `, aliases ${p.aliases.join(", ")}` : ""} (${commit}) — its chart serves the new hosts once the ArgoCD on ${tc.domain} syncs`);
      },
    },
    {
      name: "retire-previous-website-domain",
      title: "Wait until the website answers at its new hosts, then remove the previous hosts' records",
      run: async (ctx) => {
        await waitForWebsite(ctx, ports, p.domain, `The previous hosts' records still stand: retry this step once the new ones answer, or abort the run to put the website back at ${p.previous}.`, p.aliases);
        const tc = loadTenantCluster(ctx.db, p.tenantId);
        for (const host of p.retiredHosts) await removeOwnDomainRecord(ctx, ports, tc, host);
      },
    },
  ];
}

/** The alias list a request asks for, as the run sets it: a move adds the domain it leaves, and the new
 *  domain is never its own alias. A domain that is an alias now cannot become the domain directly. */
function keptAliases(domain: string, asked: readonly string[], previous: string, previousAliases: readonly string[]): string[] {
  if (domain !== previous && previousAliases.includes(domain)) throw errValidation(`${domain} is an alias of this website, whose permanent redirect a browser may have cached — drop the alias in one run, then make it the domain in another`);
  if (new Set(asked).size !== asked.length) throw errValidation("an alias domain is named twice");
  if (asked.includes(domain)) throw errValidation(`${domain} is the domain itself — an alias names another domain`);
  if (domain === previous) return [...asked];
  return asked.includes(previous) ? [...asked] : [...asked, previous];
}

/** A website that stands at the domain and aliases asked for: a run that writes the host records it
 *  misses, and nothing else — no registration write, no member resolved again. A website a stage was
 *  added with before Add stage wrote its www record has such a gap. Refused where no record is missing. */
async function planRecordRepair(
  ports: AddAppPorts,
  ctx: PlanStreamCtx,
  tc: ReturnType<typeof loadTenantCluster>,
  registration: TenantRegistration,
  app: string,
  domain: string,
  aliases: readonly string[],
): Promise<PlanStreamResult<TenantSetWebsiteDomainParams>> {
  const served = `website ${app} is already served at ${domain}${aliases.length ? ` with the aliases ${aliases.join(", ")}` : ""}`;
  const hosts = websiteRecordHosts(domain, aliases, registration);
  if (hosts.length === 0) throw errValidation(`${served}, at hosts of the tenant's own domain, whose records Set own domain holds`);
  const states = await hostRecordStates(ports, hosts, tenantZone(tc.subdomain, tc.stage, await ports.resolveUnitApex(tc.domain, tc.stage)), ctx.signal);
  if (states === null) throw errValidation(`${served}; no DNS provider is configured on this manager, so its host records are set at the provider of each host`);
  const hostsIn = (state: HostRecordState): string[] => hosts.filter((h) => states.get(h) === state);
  const recordHosts = hostsIn("missing");
  const foreign = hostsIn("foreign");
  const unmanaged = hostsIn("unmanaged");
  const foreignSentence = foreign.length === 0 ? "" : ` It leaves ${foreign.join(", ")} alone: ${foreign.length === 1 ? "a record this installation did not write stands there" : "records this installation did not write stand there"}.`;
  const unmanagedSentence = unmanaged.length === 0 ? "" : ` The DNS zone of ${unmanaged.join(", ")} is not managed here, so ${unmanaged.length === 1 ? "its record is" : "their records are"} set at its provider.`;
  if (recordHosts.length === 0) {
    if (unmanaged.length === hosts.length) throw errValidation(`${served}; the DNS zone of ${unmanaged.join(", ")} is not managed here, so its records are set at its provider`);
    throw errValidation(`${served}, and every host record of it stands.${foreignSentence}${unmanagedSentence}`);
  }
  const member = registration.members.find((m) => m.name === app);
  if (!member) throw errValidation(`website ${app} has no member entry in tenant ${tc.guid}'s registration`);
  const mailRecords = await mailRecordHashes(ports, recordHosts, ctx.signal);
  const params: TenantSetWebsiteDomainParams = {
    tenantId: tc.tenantId, app, domain, previous: domain, aliases: [...aliases], previousAliases: [...aliases], member, previousMember: member, recordHosts, retiredHosts: [], replacing: [], mailRecords,
  };
  return {
    outcome: "planned",
    params,
    plan: {
      kind: "tenant-set-website-domain",
      targetKind: "tenant",
      targetId: tc.tenantId,
      summary:
        `Write the missing host record${recordHosts.length === 1 ? "" : "s"} ${recordHosts.join(", ")} of website ${app} of tenant ${tc.guid} at ${domain} (${tc.domain}, ${tc.stage}): ` +
        `point ${recordHosts.length === 1 ? "it" : "them"} at the tenant's zone. The website stays where it stands, and its registration is not written. ` +
        `An abort removes ${recordHosts.length === 1 ? "the record" : "the records"} again.${foreignSentence}${unmanagedSentence}${mailRecordSentence(mailRecords)}`,
      steps: websiteDomainSteps(ports, params).map((s) => ({ name: s.name, title: s.title })),
      targets: [],
      locks: tenantLocks(ports.registrations),
      warnings: [],
      requiredSecrets: [],
    },
  };
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
      for (const typedEntry of [req.domain, ...(req.aliases ?? [])]) {
        const typed = ownDomainEntryProblem(typedEntry);
        if (typed !== null) throw errValidation(typed);
      }
      const previousAliases = entry.aliases ?? [];
      const aliases = keptAliases(req.domain, req.aliases ?? previousAliases, entry.domain, previousAliases);
      if (standsAt(entry, req.domain, aliases)) return planRecordRepair(ports, ctx, tc, current.entry, req.app, req.domain, aliases);
      const serving = current.entry.apps.find((a) => a.name !== req.app && a.domain === req.domain);
      if (serving) throw errValidation(`${req.domain} is already the domain of website "${serving.name}" in tenant ${tc.guid}`);
      if (tc.routing !== "path") throw errValidation(WEBSITE_NEEDS_PATH(tc.subdomain, tc.routing));
      const apex = await ports.resolveUnitApex(tc.domain, tc.stage);
      const websites = await otherTenantsWebsiteHosts(ports.registrations, tc.guid);
      // A host the tenant already serves — its own domain's, or another website's — is no alias of this one.
      const ownWebsites = await tenantWebsiteHosts(ports.registrations, { stage: tc.stage, guid: tc.guid });
      for (const host of websiteHosts(entry.domain, previousAliases)) ownWebsites.delete(host);
      const served = new Set([...tenantOwnHosts(current.entry.ownDomain, current.entry.ownDomainRedirects, current.entry.ownDomainAliases), ...ownWebsites]);
      for (const host of aliasHosts(aliases)) if (served.has(host)) throw errValidation(`${host} is a host tenant ${tc.guid} already serves — an alias names another domain`);
      // The domain may be the tenant's own (its records stand already), but never another website's alias.
      for (const host of websiteHosts(req.domain)) if (ownWebsites.has(host)) throw errValidation(`${host} is a host another website of tenant ${tc.guid} already serves`);
      // Only a host the move claims: one the website does not hold already, for the reason the
      // own-domain move gives.
      const held = new Set(websiteHosts(entry.domain, previousAliases));
      for (const host of websiteHosts(req.domain, aliases).filter((h) => !held.has(h))) {
        const problem = customerHostProblem(ctx.db, tc.tenantId, host, apex, websites);
        if (problem !== null) throw errValidation(problem);
      }
      // Only what is typed now: the domain where it changes, and an alias added. The domain a move
      // leaves, kept as an alias, and an alias dropped, are not judged.
      const typed = [...(req.domain !== entry.domain ? [req.domain] : []), ...aliases.filter((a) => a !== entry.domain && !previousAliases.includes(a))];
      await refuseOffStageHosts(ports.dns, typed, tc.stage, ctx);
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
          apps: [{ name: req.app, folder: entry.folder, site: entry.site, domain: req.domain, aliases, seedReference: entry.seedReference, seedDemo: entry.seedDemo, selections: entry.selections }],
          // A standing website: its site, and its database list, may stand in the tenant's own repository alone.
          isStandingTenant: true,
          appDatabases,
          probeGuid: tc.guid,
          subdomain: current.entry.subdomain,
          quota: current.entry.quota, size: current.entry.size,
          seedUsers: current.entry.seedUsers,
          demo: current.entry.demo === true,
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
      const recordHosts = websiteRecordHosts(req.domain, aliases, current.entry);
      const kept = new Set(recordHosts);
      const retiredHosts = websiteRecordHosts(entry.domain, previousAliases, current.entry).filter((h) => !kept.has(h));
      const replacing = await websiteRecordsToReplace(ctx.db, ports, tc, recordHosts, ctx.signal);
      const mailRecords = await mailRecordHashes(ports, [...recordHosts, ...retiredHosts], ctx.signal);
      const params: TenantSetWebsiteDomainParams = {
        tenantId: tc.tenantId, app: req.app, domain: req.domain, previous: entry.domain, aliases, previousAliases, member, previousMember, recordHosts, retiredHosts, replacing, mailRecords,
      };
      const steps = websiteDomainSteps(ports, params);
      const [site, ...redirects] = websiteHosts(req.domain, aliases);
      const what = req.domain === entry.domain ? `Give website ${req.app} of tenant ${tc.guid} at ${req.domain} the aliases ${aliases.join(", ") || "none"}` : `Move website ${req.app} of tenant ${tc.guid} from ${entry.domain} to ${req.domain}, keeping ${entry.domain} as an alias`;
      return {
        outcome: "planned",
        params,
        plan: {
          kind: "tenant-set-website-domain",
          targetKind: "tenant",
          targetId: tc.tenantId,
          summary:
            `${what} (${tc.domain}, ${tc.stage}): ` +
            `${recordHosts.length ? `point ${recordHosts.join(", ")} at the tenant's zone, ` : ""}record the domain and the member resolved with it, ` +
            `wait until https://${site}/ answers and ${redirects.map((h) => `https://${h}/`).join(", ")} redirects` +
            `${retiredHosts.length ? `, then remove the records of ${retiredHosts.join(", ")}` : ""}. The website keeps its name ${req.app}. ` +
            `From the moment the new domain is recorded, the website answers only there. ` +
            `Where this installation does not manage the DNS zone of a host, set its record (CNAME onto the tenant's zone) BEFORE approving.${replacementSentence(replacing)}${mailRecordSentence(mailRecords)}`,
          steps: steps.map((s) => ({ name: s.name, title: s.title })),
          targets: [],
          locks: tenantLocks(ports.registrations),
          warnings: [],
          requiredSecrets: [],
        },
      };
    },
    steps: (params) => websiteDomainSteps(ports, params),
    cleanups: (params) =>
      isRecordRepair(params)
        ? [removeWebsiteRecordsCleanup(ports, params.tenantId, params.app, params.recordHosts, params.replacing)]
        : [removeWebsiteRecordsCleanup(ports, params.tenantId, params.app, params.recordHosts, params.replacing, websiteHosts(params.previous, params.previousAliases)), restoreWebsiteDomainCleanup(ports, params)],
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
