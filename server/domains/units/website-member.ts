// A website's member entry resolved again with another domain. The website chart serves `site.domain`,
// which the member's values carry, so a run that moves a website writes the member this resolves in
// the same commit as the domain.
import type { PlanStreamCtx } from "../../executor/types.ts";
import type { TenantMemberRecord, TenantRegistration } from "../../../shared/tenant.ts";
import { errValidation } from "../../kernel/errors.ts";
import type { TenantCluster } from "./lifecycle.ts";
import type { AddAppPorts } from "./add-app.run.ts";
import { validateTenant } from "./validate-tenant.ts";
import { tenantBundleManifest } from "./engine-line.ts";
import { standingAppDatabases } from "./tenant-app-databases.ts";

/** What resolving a website's member reads: the product's manifest and charts, and the cluster's values. */
export type WebsiteMemberPorts = Pick<AddAppPorts, "repo" | "helm" | "registrations" | "deployRepoUrl" | "deployCredentialId" | "resolveClusterValueFiles">;

/** The member resolved with the new domain beside the one it replaces, or the gates that did not pass. */
export type WebsiteMember = { member: TenantMemberRecord; previousMember: TenantMemberRecord } | { failedGates: string[]; report: unknown };

/** Resolve website `app`'s member again with `domain` and `aliases`, by the same validation add-app
 *  renders the website with, at the tenant's own bundle as it stands. */
export async function resolveWebsiteMember(
  ports: WebsiteMemberPorts,
  ctx: PlanStreamCtx,
  tc: Pick<TenantCluster, "guid" | "stage" | "domain">,
  registration: TenantRegistration,
  app: string,
  domain: string,
  aliases: readonly string[],
): Promise<WebsiteMember> {
  const entry = registration.apps.find((a) => a.name === app);
  if (!entry?.folder || !entry.site) throw errValidation(`app "${app}" of tenant ${tc.guid} is no website — it names no folder and site`);
  const previousMember = registration.members.find((m) => m.name === app);
  if (!previousMember) throw errValidation(`website ${app} has no member entry in tenant ${tc.guid}'s registration`);
  const appDatabases = await standingAppDatabases((bundle, signal) => tenantBundleManifest(ports, bundle, signal), registration, ctx);
  const outcome = await validateTenant(
    {
      repoURL: ports.deployRepoUrl,
      ref: ports.registrations.branch,
      stage: tc.stage,
      apps: [{ name: app, folder: entry.folder, site: entry.site, domain, aliases: [...aliases], seedReference: entry.seedReference, seedDemo: entry.seedDemo, selections: entry.selections }],
      // A standing website: its site, and its database list, may stand in the tenant's own repository alone.
      isStandingTenant: true,
      appDatabases,
      probeGuid: tc.guid,
      subdomain: registration.subdomain,
      quota: registration.quota, size: registration.size,
      seedUsers: registration.seedUsers,
      demo: registration.demo === true,
      appsImage: registration.appsImage,
      appsImageTag: registration.appsImageTag,
      clusterValueFiles: await ports.resolveClusterValueFiles(tc.domain, tc.stage),
      ...(ports.deployCredentialId ? { credentialId: ports.deployCredentialId } : {}),
    },
    { repo: ports.repo, helm: ports.helm, log: ctx.log, signal: ctx.signal },
  );
  if (outcome.verdict !== "pass") return { failedGates: outcome.report.gates.filter((g) => g.status !== "pass").map((g) => g.id), report: outcome.report };
  const member = outcome.memberRecords.find((m) => m.name === app);
  if (!member) throw errValidation(`the validated fan-out has no member for website "${app}"`);
  return { member, previousMember };
}
