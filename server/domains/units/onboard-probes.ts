// WHAT THE CONSUMER ONBOARDING MEASURES BEFORE THE APPROVE (hostyour-manager#208): the read-only
// twins of its steps, in the shape every probe answers (executor/probe.ts). Each function here is
// hung on the step whose run() will meet what it measures, so the finding table on the approve
// card reads in step order and a refusal names the step that would have failed.
//
// WHAT IS MEASURED, AND WITH WHAT. The identity of the repository (the sealed credential the run
// opens: a PAT with its scopes, or the App and its reach); one private package of every scope the
// repository's .npmrc routes to GitHub Packages, read with that identity — the read the build's npm
// install makes, and the one an App token cannot (2026-09-19, apps7); the repository's hooks,
// readable with the identity, and whether one stands at the build plane already; the unit's DNS
// record — free, this cluster's already, another cluster's, or a leftover; the target's deploy-state, which attest-target re-asks at run time (step 0 of a
// mutating run stays a step). WHAT IS NOT: Vault's write paths (the seeder is write-only), the
// registry's identities (no port of the onboarding reads it) and the release kit's push right —
// each of those the run proves by doing, and the table says nothing about them rather than
// something invented.
import type { PreflightCheck } from "../../../shared/preflight.ts";
import type { ProbeCtx } from "../../executor/probe.ts";
import type { OnboardPorts, OnboardParams, DeployableOnboardParams } from "./onboard.run.ts";
import { parseGitHubOwnerRepo } from "./onboard-webhook.ts";
import { readOwnerIdentity } from "./owners.ts";
import { CONSUMER_WIZARD, npmrcPackageScopes, packagesReaderMissing, patHookRefusal } from "./repo-identity.ts";
import { consumerUnitHost } from "#unit/shared/unit-host.ts";
import { readStandingHost } from "./unit-dns.ts";
import { missingConsumerPatScopes, requiredConsumerPatScopesSummary } from "./pat-scopes.ts";
import { WebhookScopeError, webhookTargetUrl } from "../../adapters/github-consumer/port.ts";

const check = (id: string, title: string, severity: PreflightCheck["severity"], status: PreflightCheck["status"], detail: string, hint?: string): PreflightCheck =>
  ({ id, title, severity, status, detail, ...(hint ? { hint } : {}) });

/** A port the probe would measure with is not wired: the probe says so and measures nothing. The
 *  wiring gap is the STEP's to refuse, loud, at run time (every step here does) — a probe reports
 *  the world, and a manager that cannot ask is not a world that answered no. */
const unmeasured = (id: string, title: string, why: string): PreflightCheck => check(id, title, "soft", "warn", `not measured: ${why}`);

/** The credential the run will open, opened now for the probes' reads and zeroed after. */
async function withIdentity<T>(ctx: ProbeCtx, p: OnboardParams, purpose: string, f: (token: string, viaApp: boolean) => Promise<T>): Promise<T> {
  const viaApp = (await ctx.creds.list({ kind: "github-app" })).some((row) => row.id === p.repoCredentialId);
  const token = await ctx.creds.open(p.repoCredentialId, { purpose, runId: "plan" });
  return withToken(token, (t) => f(t, viaApp));
}

async function withToken<T>(token: Buffer, f: (token: string) => Promise<T>): Promise<T> {
  try {
    return await f(token.toString("utf8"));
  } finally {
    token.fill(0);
  }
}

/** attest-target's probe: the target's deploy-state stands and names this domain. */
export async function probeTarget(ports: OnboardPorts, p: DeployableOnboardParams): Promise<PreflightCheck[]> {
  const { clusterReader } = await ports.resolver.resolve(p.clusterId);
  const state = await clusterReader.readDeployState();
  if (!state) return [check("target.deploy-state", `The target cluster ${p.domain}`, "hard", "fail", "carries no hostyour-cloud deploy-state", "is it a provisioned hostyour cluster?")];
  if (state.domain !== p.domain) return [check("target.deploy-state", `The target cluster ${p.domain}`, "hard", "fail", `reports ${state.domain} in its deploy-state`)];
  return [check("target.deploy-state", `The target cluster ${p.domain}`, "hard", "pass", `deploy-state generation ${state.generation}`)];
}

/** preflight-scopes' probe: a PAT's scopes, or the App's reach of the repository. */
export async function probeIdentity(ports: OnboardPorts, p: OnboardParams, ctx: ProbeCtx): Promise<PreflightCheck[]> {
  const { owner, repo } = parseGitHubOwnerRepo(p.repoURL);
  const title = `The identity of ${owner}/${repo}`;
  if (!ports.github) return [unmeasured("identity", title, "no GitHub client is wired on this manager")];
  return withIdentity(ctx, p, "consumer-onboard:probe-identity", async (token, viaApp) => {
    if (viaApp) {
      // The reach was measured when the identity was chosen (repo-identity.ts); the token opened
      // above is one the App minted a moment ago, which is the measurement repeated.
      return [check("identity", title, "hard", "pass", "the platform's GitHub App reaches it and minted a token")];
    }
    let scopes;
    try {
      scopes = await ports.github!.readTokenScopes({ owner, repo, token, signal: ctx.signal });
    } catch (err) {
      if (err instanceof WebhookScopeError) return [check("identity", title, "hard", "fail", `the PAT is invalid or expired (${err.message})`, `provide a classic PAT with ${requiredConsumerPatScopesSummary()}`)];
      throw err;
    }
    if (!scopes.classic) return [check("identity", title, "hard", "fail", "the token is fine-grained, which reports no scopes", `provide a CLASSIC PAT with ${requiredConsumerPatScopesSummary()}`)];
    const missing = missingConsumerPatScopes(scopes.scopes);
    return [missing.length === 0
      ? check("identity", title, "hard", "pass", `a classic PAT with ${scopes.scopes.join(", ")}`)
      : check("identity", title, "hard", "fail", `the PAT lacks ${missing.join(", ")}`, `provide a classic PAT with ${requiredConsumerPatScopesSummary()}`)];
  });
}

/** seed-repo-pat's probe: one private package per scope the repository routes to GitHub Packages,
 *  read with the owner's packages reader — the token the build's `.npmrc` will carry (#220).
 *  Refused by name where the owner records none. */
export async function probePackages(ports: OnboardPorts, p: OnboardParams, ctx: ProbeCtx): Promise<PreflightCheck[]> {
  if (!ports.github) return [];
  const clone = await ports.repo.cloneAtRef({ repoURL: p.repoURL, ref: p.resolvedSha, credentialId: p.repoCredentialId, signal: ctx.signal });
  try {
    const npmrc = await ports.repo.readFile(clone.workdir, ".npmrc");
    const scopes = npmrcPackageScopes(npmrc);
    if (scopes.length === 0) return [check("packages", "Private npm packages", "soft", "pass", "the repository routes no scope to GitHub Packages — no packages reader needed")];
    const lock = (await ports.repo.readFile(clone.workdir, "pnpm-lock.yaml")) ?? (await ports.repo.readFile(clone.workdir, "package-lock.json")) ?? "";
    const { owner, repo } = parseGitHubOwnerRepo(p.repoURL);
    const readerId = readOwnerIdentity(ctx.db, owner)?.packagesCredentialId;
    if (!readerId) return [check("packages", "Private npm packages", "hard", "fail", packagesReaderMissing(owner, repo, scopes, CONSUMER_WIZARD), `record it in ${CONSUMER_WIZARD}`)];
    const reader = await ctx.creds.open(readerId, { purpose: "consumer-onboard:probe-packages", runId: "plan" });
    return withToken(reader, async (token) => {
      const out: PreflightCheck[] = [];
      for (const scope of scopes) {
        const name = lock.match(new RegExp(`@${scope.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/([A-Za-z0-9._-]+)[@/'"]`))?.[1];
        const title = `The packages of @${scope} on GitHub Packages`;
        if (!name) { out.push(check(`packages.${scope}`, title, "soft", "pass", "the lockfile names none")); continue; }
        const answer = await ports.github!.readPackage({ scope, name, token, signal: ctx.signal });
        out.push(answer === "readable"
          ? check(`packages.${scope}`, title, "hard", "pass", `@${scope}/${name} is readable with the packages reader of ${owner}`)
          : answer === "absent"
            ? check(`packages.${scope}`, title, "hard", "warn", `@${scope}/${name} is not published there`)
            : check(`packages.${scope}`, title, "hard", "fail", `@${scope}/${name} is not readable with the packages reader of ${owner}`, `record a packages reader of ${scope === owner ? owner : `${owner} that also reads @${scope}`} in ${CONSUMER_WIZARD}`));
      }
      return out;
    });
  } finally {
    await ports.repo.dispose(clone.workdir);
  }
}

/** setup-webhook's probe: the hooks are readable with the identity, and the build plane is named. */
export async function probeWebhook(ports: OnboardPorts, p: OnboardParams, ctx: ProbeCtx): Promise<PreflightCheck[]> {
  const { owner, repo } = parseGitHubOwnerRepo(p.repoURL);
  const title = `The build webhook of ${owner}/${repo}`;
  if (!ports.github) return [unmeasured("webhook", title, "no GitHub client is wired on this manager")];
  if (!ports.webhookSecret) return [unmeasured("webhook", title, "GITHUB_WEBHOOK_SECRET is not configured on this manager")];
  const buildPlaneFqdn = await ports.resolveBuildPlaneFqdn(p.domain);
  const targetUrl = webhookTargetUrl(buildPlaneFqdn, ports.webhookSubdomain);
  return withIdentity(ctx, p, "consumer-onboard:probe-webhook", async (token, viaApp) => {
    try {
      const stands = await ports.github!.hookStandsAt({ owner, repo, token, targetUrl, signal: ctx.signal });
      return [check("webhook", title, "hard", "pass", stands ? `a hook already stands at ${targetUrl} and is re-set by the run` : `the hooks are readable; the run creates one at ${targetUrl}`)];
    } catch (err) {
      if (!(err instanceof WebhookScopeError)) throw err;
      const status = `HTTP ${err.status ?? "403/404"}`;
      const refusal = viaApp ? null : await patHookRefusal(ports.github!, { owner, repo, token, signal: ctx.signal });
      if (refusal) return [check("webhook", title, "hard", "fail", `${refusal.reading} (${status})`, refusal.hint)];
      return [check("webhook", title, "hard", "fail", `the identity cannot read the hooks (${status})`, "provide a PAT with admin:repo_hook")];
    }
  });
}

/** provision-dns's probe: the record's standing, judged the way the step judges it. */
export async function probeDns(ports: OnboardPorts, p: DeployableOnboardParams, ctx: ProbeCtx): Promise<PreflightCheck[]> {
  const recordName = consumerUnitHost(p.host, p.stage, p.unitApex);
  const title = `The DNS record ${recordName}`;
  if (!ports.dns) return [unmeasured("dns.record", title, "no DNS provider is wired on this manager")];
  const out: PreflightCheck[] = [];
  const judged = await readStandingHost(ports.dns, ctx.db, { recordName, clusterFqdn: p.domain, signal: ctx.signal });
  out.push(judged.kind === "free" ? check("dns.record", title, "hard", "pass", "is free; the run creates it")
    : judged.kind === "ours" ? check("dns.record", title, "hard", "pass", `already points at ${p.domain}`)
      : judged.kind === "leftover" ? check("dns.record", title, "hard", "warn", `stands as ${judged.type} ${judged.content}, which points at no cluster of this installation; the run replaces it`)
        : check("dns.record", title, "hard", "fail", `points at ${judged.cluster}, a cluster of this installation`, "offboard the unit there first"));
  return out;
}
