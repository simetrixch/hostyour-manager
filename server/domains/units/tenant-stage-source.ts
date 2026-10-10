import { and, eq } from "drizzle-orm";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { PlanStreamCtx, PlanStreamResult, Step } from "../../executor/types.ts";
import { tenants } from "../../db/schema/inventory.ts";
import { errValidation } from "../../kernel/errors.ts";
import type { Stage } from "../../../shared/enums.ts";
import { findStagePlacementConflict } from "../../../shared/tenant-stage-placement.ts";
import { CONSUMER_MANIFEST_PATH, ConsumerManifestSchema } from "../../../shared/consumer.ts";
import type { CreateTenantRequest, CreateTenantStageParams, TenantOnboardPorts } from "./create-tenant.run.ts";
import { loadTenantCluster } from "./lifecycle.ts";
import { assertTenantProvisioned, loadTenantStatus } from "./tenant-provisioned.ts";
import { registryHostFromChain, resolveTenantCluster } from "./tenant-values.ts";
import { validateTenant } from "./validate-tenant.ts";
import { tenantApplicationSet } from "./tenant-fanout.ts";
import { stagePinsOf } from "./tenant-versions.ts";
import { requiredImagesFrom } from "./ensure-images.ts";
import { tenantSyncUnits } from "#unit/server/build-rbac.ts";
import { tenantZone, standingHostFrom } from "#unit/server/unit-dns.ts";
import { tenantLocks } from "./tenant-lifecycle.run.ts";
import { appIdentityRowId } from "../../security/app-identity.ts";
import { provisionOwnDomainRecord, recordsToReplace } from "./own-domain-records.ts";
import { websiteHosts } from "./website-domain.ts";
import { hostAtStage } from "./stage-hosts.ts";
import { resolveUnitQuota } from "#unit/server/unit-size.ts";
import { TENANT_BRINGS } from "#unit/shared/unit-size.ts";

export async function planStandingStage(
  ports: TenantOnboardPorts, tenantId: string,
  placement: { stage: Stage; clusterId: string }, request: CreateTenantRequest, ctx: PlanStreamCtx,
): Promise<PlanStreamResult<CreateTenantStageParams>> {
  assertTenantProvisioned(loadTenantStatus(ctx.db, tenantId), "adding a stage");
  const source = loadTenantCluster(ctx.db, tenantId);
  const registered = await ports.registrations.readTenant(source.stage, source.guid);
  if (!registered) throw errValidation(`tenant ${source.guid} ${source.stage} has no registration to provision another stage from`);
  const entry = registered.entry;
  if (placement.stage === source.stage) throw errValidation(`tenant ${source.guid} already has ${source.stage}`);
  const existing = ctx.db.select({ id: tenants.id, status: tenants.status }).from(tenants).where(and(eq(tenants.guid, source.guid), eq(tenants.stage, placement.stage))).get();
  if ((existing && existing.status !== "purged") || (await ports.registrations.scanTenant(placement.stage, source.guid)).status !== "absent") throw errValidation(`tenant ${source.guid} already has a ${placement.stage} stage; finish or purge it before adding that stage`);
  const rc = resolveTenantCluster(ctx.db, placement.clusterId, placement.stage);
  const standing = ctx.db.select({ stage: tenants.stage, clusterId: tenants.clusterId, status: tenants.status }).from(tenants).where(eq(tenants.guid, source.guid)).all();
  const clash = findStagePlacementConflict(standing, placement.stage, rc.clusterId);
  if (clash) throw errValidation(`tenant ${source.guid} ${placement.stage} cannot stand on ${rc.domain}: its ${clash.stage} stage stands there, and TEST and PROD cannot share a machine`);
  if (ports.carryTrunkToBooksBranch) await ports.carryTrunkToBooksBranch();
  const clusterValueFiles = await ports.resolveClusterValueFiles(rc.domain, placement.stage);
  const registryHost = registryHostFromChain(clusterValueFiles);
  // Every public host at the new stage, the stage directly before the zone that holds it.
  const atStage = (host: string): Promise<string> => hostAtStage(ports.dns, host, source.stage, placement.stage, ctx.signal);
  const ownDomain = await atStage(entry.ownDomain);
  const ownDomainRedirects = await Promise.all(entry.ownDomainRedirects.map(async (host) => host.startsWith("www.") ? `www.${await atStage(host.slice(4))}` : atStage(host)));
  // A website's alias domains stay with the stage they were given on, as the own domain's do (never
  // copied): the new stage is given its own with "Domain and aliases…".
  const apps = await Promise.all(entry.apps.map(async ({ aliases: _aliases, ...app }) => ({ ...app, ...(app.domain ? { domain: await atStage(app.domain) } : {}) })));
  const domains = new Map(entry.apps.filter((app) => app.domain).map((app) => [app.domain!, apps.find((a) => a.name === app.name)!.domain!]));
  // The members' values carry the alias list the fanout rendered from `{aliases}`: it goes with its
  // key, and so does an object the drop leaves empty, as the fanout renders a website without aliases.
  const aliasHosts = new Set(entry.apps.flatMap((app) => app.aliases ?? []));
  const DROPPED = Symbol("dropped");
  const transform = (value: unknown): unknown => {
    if (typeof value === "string") return domains.get(value) ?? value;
    if (Array.isArray(value)) return value.length > 0 && value.every((v) => typeof v === "string" && aliasHosts.has(v)) ? DROPPED : value.map(transform);
    if (value && typeof value === "object") {
      const entries = Object.entries(value).map(([key, v]) => [key, transform(v)] as const).filter(([, v]) => v !== DROPPED);
      return entries.length === 0 && Object.keys(value).length > 0 ? DROPPED : Object.fromEntries(entries);
    }
    return value;
  };
  const members = entry.members.map((member) => ({ ...member, sources: member.sources.map((s) => { const values = transform(s.values); return { ...s, values: (values === DROPPED ? {} : values) as Record<string, unknown> }; }) }));
  const pins = await stagePinsOf((chart) => ports.registrations.listPinnedBuilds(placement.stage, chart), members);
  const approvedTags = Object.fromEntries(members.map((member) => [member.name, { ...entry.approvedTags[member.name], ...pins[member.name] }]));
  const channels = await ports.channelStages();
  for (const tag of [...Object.values(approvedTags).flatMap(Object.values), ...(entry.appsImageTag ? [entry.appsImageTag] : [])]) {
    const channel = tag.split("-")[1] as keyof typeof channels;
    if (!channels[channel]?.includes(placement.stage)) throw errValidation(`release ${tag} does not reach ${placement.stage}; use a release channel admitted to that stage`);
  }
  const outcome = await validateTenant({
    repoURL: ports.deployRepoUrl, ref: ports.registrations.branch, stage: placement.stage,
    apps, members, identityProvider: entry.identityProvider, isStandingTenant: true,
    appDatabases: Object.fromEntries(apps.filter((app) => app.databases).map((app) => [app.name, app.databases!])),
    probeGuid: source.guid, subdomain: entry.subdomain, seedUsers: false, demo: entry.demo === true,
    quota: resolveUnitQuota(ctx.db, request.size, TENANT_BRINGS), size: request.size,
    appsImage: entry.appsImage, appsImageTag: entry.appsImageTag, ownDomain, ownDomainRedirects,
    approvedTags, clusterValueFiles, clusterFqdn: rc.domain,
    ...(ports.deployCredentialId ? { credentialId: ports.deployCredentialId } : {}),
  }, { repo: ports.repo, helm: ports.helm, log: ctx.log, signal: ctx.signal, ...standingHostFrom(ports.dns, ctx.db, ctx.signal) });
  if (outcome.verdict !== "pass") return { outcome: "rejected", summary: `Add ${placement.stage} to tenant ${source.guid} rejected: ${outcome.report.gates.filter((g) => g.status !== "pass").map((g) => g.id).join(", ")}`, planJson: outcome.report };
  const requiredImages = requiredImagesFrom(outcome.images, registryHost);
  const params: CreateTenantStageParams = {
    guid: source.guid, subdomain: entry.subdomain, stage: placement.stage,
    clusterId: rc.clusterId, cluster: rc.cluster, domain: rc.domain, chartsRef: outcome.resolvedSha,
    registryHost, apps, members: outcome.memberRecords, identityProvider: entry.identityProvider,
    seedUsers: false, demo: entry.demo === true, size: request.size, owner: source.owner,
    // A new stage is shown under the name the stage it is added from carries.
    displayName: entry.displayName,
    report: outcome.report, expectedApps: tenantApplicationSet(members.map((m) => m.name), source.guid, placement.stage),
    requiredImages, syncUnits: tenantSyncUnits(requiredImages, await ports.attestedBuilds()), buildUnits: [],
    deployRepoUrl: ports.deployRepoUrl, replaces: [], ownDomain, ownDomainRedirects, approvedTags,
    sourceTenantId: tenantId, sourceStage: source.stage, sourceRegistration: JSON.stringify(entry), isStandingTenant: true,
    ...(entry.appsImage ? { appsImage: entry.appsImage, appsImageTag: entry.appsImageTag, appsRepo: entry.appsRepo } : {}),
    ...(outcome.spec?.issuerRecordLabel ? { issuerRecordLabel: outcome.spec.issuerRecordLabel } : {}),
    ...(request.adminEmail ? { adminEmail: request.adminEmail } : {}),
  };
  return { outcome: "planned", params, plan: { kind: "tenant-create", targetKind: "tenant", targetId: tenantId,
    summary: `Add fresh ${placement.stage} to ${source.guid} on ${rc.domain}`, steps: [], targets: [],
    locks: tenantLocks(ports.registrations), warnings: [], requiredSecrets: [] } };
}

export function stageBundleStep(ports: TenantOnboardPorts, p: CreateTenantStageParams): Step {
  return { name: "admit-bundle-stage", title: "Admit the existing bundle to the new stage",
    run: async (ctx) => {
      if (!p.appsRepo) return;
      const writer = ports.onboard?.()?.ports.consumerRepo;
      if (!writer || !ports.githubApp) throw errValidation("Add stage needs the existing consumer repository writer and GitHub App for the tenant bundle");
      const credentialId = await appIdentityRowId(ctx.creds);
      if (!credentialId) throw errValidation("the GitHub App credential is not recorded");
      const session = await writer.open({ repoURL: p.appsRepo, credentialId, signal: ctx.signal });
      try {
        const raw = await writer.readFile(session.workdir, CONSUMER_MANIFEST_PATH);
        if (!raw) throw errValidation(`${p.appsRepo} has no ${CONSUMER_MANIFEST_PATH}`);
        const manifest = ConsumerManifestSchema.parse(parseYaml(raw));
        if (manifest.envs.includes(p.stage)) return;
        const { commit } = await writer.commitPush({ workdir: session.workdir, branch: session.branch, credentialId,
          message: `Admit ${p.stage} for tenant ${p.guid}`, write: [{ path: CONSUMER_MANIFEST_PATH, content: stringifyYaml({ ...parseYaml(raw), envs: [...manifest.envs, p.stage] }) }], signal: ctx.signal });
        ctx.checkpoint({ commit, stage: p.stage });
        ctx.log("meta", `bundle ${p.appsRepo} now admits ${p.stage} (${commit})`);
      } finally { await writer.dispose(session.workdir); }
    } };
}

export function stageHostsStep(ports: TenantOnboardPorts, p: CreateTenantStageParams): Step {
  return { name: "provision-stage-hosts", title: "Provision only the new stage's public hosts",
    run: async (ctx) => {
      const row = ctx.db.select({ id: tenants.id }).from(tenants).where(and(eq(tenants.guid, p.guid), eq(tenants.stage, p.stage))).get();
      if (!row) throw errValidation(`tenant ${p.guid} ${p.stage} has no provisional inventory row`);
      const tc = loadTenantCluster(ctx.db, row.id);
      const apex = await ports.resolveUnitApex(p.domain, p.stage);
      // Every host a website answers at, its www. included, as the Deploy button of a website writes them; a host the own
      // domain holds is written once.
      const hosts = [...new Set([p.ownDomain, ...(p.ownDomainRedirects ?? []), ...p.apps.flatMap((app) => (app.domain ? websiteHosts(app.domain) : []))].filter((host): host is string => Boolean(host)))];
      for (const host of hosts) {
        const replacements = await recordsToReplace(ctx.db, ports, p.guid, tenantZone(tc.subdomain, tc.stage, apex), [host], ctx.signal);
        if (replacements.length) throw errValidation(`new stage host ${host} already has web records; Add stage replaces no existing host`);
        await provisionOwnDomainRecord(ctx, ports, tc, apex, host, []);
      }
    } };
}
