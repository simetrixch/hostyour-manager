// WHAT THE TENANT ONBOARDING MEASURES BEFORE THE APPROVE (hostyour-manager#209): the read-only
// twins of its steps, in the shape every probe answers (executor/probe.ts), hung on the step whose
// run() will meet what they measure.
//
// WHAT IS MEASURED. The target's deploy-state (attest-target re-asks it at run time, step 0 of a
// mutating run stays a step); the catalog — readable with the manager's credential
// (write-registration; the push is proven by the commit); the apps repository's owner — the one the App is
// installed in — and the template the tree is copied from, reached by the App (create-repository);
// every build unit's identity — a registered unit's stored credential reads the repository's hooks,
// an unregistered unit the App reaches is reached, and one whose PAT comes at approve is NOT
// measured, because nothing is there to measure with yet (build-unit:<unit>); the tenant's wildcard
// record, judged as the step judges it (provision-dns). The consumer probes of #208 do not run
// here: a build unit's onboarding is composed inside its step, at run time, from a clone the
// approve-time credential makes.
import type { PreflightCheck } from "../../../shared/preflight.ts";
import type { ProbeCtx } from "../../executor/probe.ts";
import type { TenantOnboardPorts, CreateTenantParams } from "./create-tenant.run.ts";
import type { BuildUnit, TenantBuildDeps } from "./tenant-builds.ts";
import { parseGitHubOwnerRepo } from "#unit/server/github-repo-url.ts";
import { judgeRepoIdentity, patHookRefusal, resolveRepoCredentialId } from "#unit/server/repo-identity.ts";
import { readOwnerIdentity } from "#unit/server/owners.ts";
import { tenantRecordName } from "#unit/shared/unit-host.ts";
import { readStandingHost } from "#unit/server/unit-dns.ts";
import { tenantAppsRepoURL } from "./tenant-apps-tree.ts";
import { webhookTargetUrl, WebhookScopeError } from "../../adapters/github-consumer/port.ts";

const check = (id: string, title: string, severity: PreflightCheck["severity"], status: PreflightCheck["status"], detail: string, hint?: string): PreflightCheck =>
  ({ id, title, severity, status, detail, ...(hint ? { hint } : {}) });
const unmeasured = (id: string, title: string, why: string): PreflightCheck => check(id, title, "soft", "warn", `not measured: ${why}`);

/** attest-target's probe: the target's deploy-state stands and names this domain. */
export async function probeTenantTarget(ports: TenantOnboardPorts, p: CreateTenantParams): Promise<PreflightCheck[]> {
  const { clusterReader } = await ports.resolver.resolve(p.clusterId);
  const state = await clusterReader.readDeployState();
  const title = `The target cluster ${p.domain}`;
  if (!state) return [check("target.deploy-state", title, "hard", "fail", "carries no hostyour-cloud deploy-state", "is it a provisioned hostyour cluster?")];
  if (state.domain !== p.domain) return [check("target.deploy-state", title, "hard", "fail", `reports ${state.domain} in its deploy-state`)];
  return [check("target.deploy-state", title, "hard", "pass", `deploy-state generation ${state.generation}`)];
}

/** write-registration's probe: the catalog is readable with the manager's credential. Whether it is
 *  pushable is proven by the commit: the registrations' repository carries its own push identity. */
export async function probeCatalog(ports: TenantOnboardPorts, p: CreateTenantParams): Promise<PreflightCheck[]> {
  const title = `The catalog ${ports.catalogRepoUrl}`;
  const out: PreflightCheck[] = [];
  try {
    const guids = await ports.registrations.listTenantGuids(p.stage);
    out.push(check("catalog.read", title, "hard", "pass", `readable; ${guids.length} tenant(s) registered at ${p.stage}`));
  } catch (err) {
    return [check("catalog.read", title, "hard", "fail", `cannot be read: ${err instanceof Error ? err.message : String(err)}`, "the manager's catalog credential or CATALOG_REPO is wrong")];
  }
  return out;
}

/** create-repository's probe: the App is installed in the owner the apps repository is created
 *  in, and it reaches the template the tree is copied from. */
export async function probeAppsRepository(ports: TenantOnboardPorts, unit: { org: string; templateRepoURL: string; bundle: string; subdomain: string }, ctx: ProbeCtx): Promise<PreflightCheck[]> {
  const repoURL = tenantAppsRepoURL(unit.org, unit.bundle, unit.subdomain);
  const title = `The apps repository ${repoURL}`;
  if (!ports.githubApp) return [check("apps.org", title, "hard", "fail", "no GitHub App is configured on this manager", "answer GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID and GITHUB_APP_PRIVATE_KEY")];
  const org = await ports.githubApp.installationOrg(ctx.signal);
  const out: PreflightCheck[] = [org === unit.org
    ? check("apps.org", title, "hard", "pass", `the platform's GitHub App is installed in ${org}`)
    : check("apps.org", title, "hard", "fail", `the platform's GitHub App is installed in ${org}, not in ${unit.org}`)];
  const template = parseGitHubOwnerRepo(unit.templateRepoURL);
  const reaches = await ports.githubApp.reachesRepository({ ...template, signal: ctx.signal });
  out.push(reaches
    ? check("apps.template", `The template ${template.owner}/${template.repo}`, "hard", "pass", "reached by the platform's GitHub App")
    : check("apps.template", `The template ${template.owner}/${template.repo}`, "hard", "fail", "not reached by the platform's GitHub App", "install the App on the template's repository"));
  return out;
}

/** build-unit:<unit>'s probe: the unit's identity, as far as one stands before the approve. */
export async function probeBuildUnit(deps: () => TenantBuildDeps | undefined, ports: TenantOnboardPorts, p: Pick<CreateTenantParams, "domain">, unit: BuildUnit, ctx: ProbeCtx): Promise<PreflightCheck[]> {
  const { owner, repo } = parseGitHubOwnerRepo(unit.repoURL);
  const title = `The build unit ${unit.unit} (${owner}/${repo})`;
  // The owner's identity, judged now (repo-identity.ts, #226): what the step resolves and opens.
  const judged = await judgeRepoIdentity({ repoURL: unit.repoURL, githubApp: ports.githubApp, owners: (org) => readOwnerIdentity(ctx.db, org), signal: ctx.signal });
  if ("refused" in judged) return [check(`unit.${unit.unit}`, title, "hard", "fail", judged.refused)];
  if (!unit.registered) {
    return [check(`unit.${unit.unit}`, title, "hard", "pass", judged.kind === "github-app" ? "reached by the platform's GitHub App; its packages read with the owner's packages reader" : "its owner's repository PAT; its packages read with the owner's packages reader")];
  }
  const d = deps();
  const github = d?.ports.github;
  if (!github) return [unmeasured(`unit.${unit.unit}`, title, "no GitHub client is wired on this manager")];
  const buildPlaneFqdn = await d!.ports.resolveBuildPlaneFqdn(p.domain);
  const targetUrl = webhookTargetUrl(buildPlaneFqdn, d!.ports.webhookSubdomain);
  const credentialId = await resolveRepoCredentialId({ repoURL: unit.repoURL, githubApp: ports.githubApp, owners: (org) => readOwnerIdentity(ctx.db, org), store: ctx.creds, signal: ctx.signal });
  const token = await ctx.creds.open(credentialId, { purpose: "tenant-create:probe-build-unit" });
  try {
    const stands = await github.hookStandsAt({ owner, repo, token: token.toString("utf8"), targetUrl, signal: ctx.signal });
    return [check(`unit.${unit.unit}`, title, "hard", "pass", stands ? "its stored credential reads the hooks; the build hook stands" : "its stored credential reads the hooks; the re-release sets the build hook")];
  } catch (err) {
    if (!(err instanceof WebhookScopeError)) throw err;
    const status = `HTTP ${err.status ?? "403/404"}`;
    const refusal = judged.kind === "pat" ? await patHookRefusal(github, { owner, repo, token: token.toString("utf8"), signal: ctx.signal }) : null;
    if (refusal) return [check(`unit.${unit.unit}`, title, "hard", "fail", `${refusal.reading} (${status})`, refusal.hint)];
    return [check(`unit.${unit.unit}`, title, "hard", "fail", `its stored credential cannot read the hooks (${status})`, "re-onboard the unit with a PAT holding admin:repo_hook")];
  } finally {
    token.fill(0);
  }
}

/** provision-dns's probe: the tenant's record (the wildcard or the zone, by its routing), judged as the step judges it. A replace stands
 *  on the SAME cluster (the plan refuses any other), so its record already answers "ours". */
export async function probeTenantDns(ports: TenantOnboardPorts, p: CreateTenantParams, ctx: ProbeCtx): Promise<PreflightCheck[]> {
  const unitApex = await ports.resolveUnitApex(p.domain, p.stage);
  const recordName = tenantRecordName(p.routing, p.subdomain, p.stage, unitApex);
  const title = `The DNS record ${recordName}`;
  if (!ports.dns) return [unmeasured("dns.record", title, "no DNS provider is wired on this manager")];
  const judged = await readStandingHost(ports.dns, ctx.db, { recordName, clusterFqdn: p.domain, signal: ctx.signal });
  return [judged.kind === "free" ? check("dns.record", title, "hard", "pass", "is free; the run creates it")
    : judged.kind === "ours" ? check("dns.record", title, "hard", "pass", `already points at ${p.domain}`)
      : judged.kind === "leftover" ? check("dns.record", title, "hard", "warn", `stands as ${judged.type} ${judged.content}, which points at no cluster of this installation; the run replaces it`)
        : check("dns.record", title, "hard", "fail", `points at ${judged.cluster}, a cluster of this installation`, "offboard the tenant there first")];
}
