// WHICH IDENTITY READS AND WRITES A UNIT'S REPOSITORY, AND WHICH READS ITS PACKAGES — the one rule,
// derived from the OWNER of the repository URL and measured (hostyour-manager#218, #220).
//
// The owner names the owner, and the owner's record (owners.ts, #219) is what
// every unit of it is onboarded with; nothing is asked per unit. Two identities, because GitHub
// keeps them apart:
//  - the REPOSITORY identity: the platform's GitHub App where its installation reaches the
//    repository (measured: GET /repos/{owner}/{repo}/installation, never inferred from the owner
//    string) — the credential row stores no token and the store mints an installation token at
//    every open, ONE row per installation (#226); else the owner's REPOSITORY PAT where one is
//    recorded, its own row; else a refusal naming both halves. No unit has a row: the id is
//    resolved from the URL at every use (resolveRepoCredentialId);
//  - the PACKAGES identity: the owner's PACKAGES READER, required for a unit whose
//    repository routes a scope to GitHub Packages (its `.npmrc`, npmrcPackageScopes) and for no
//    other (#221). An App installation token reads no private npm package whatever the App's
//    permissions say, so a build's `.npmrc` carries this token (onboard-seed-repo-pat.ts), never
//    the repository's.
// Callers: the onboard POST and its prefill (api.ts, api-onboard-prefill.ts), the tenant build
// units (tenant-builds.ts) and the tenant's own apps repository (tenant-apps-steps.ts).
import type { GitHubApp } from "../../adapters/github-app/port.ts";
import type { GitHubConsumer } from "../../adapters/github-consumer/port.ts";
import type { CredentialStore } from "../../security/store.ts";
import { appIdentityRowId } from "../../security/app-identity.ts";
import { errValidation } from "../../kernel/errors.ts";
import { parseGitHubOwnerRepo } from "./onboard-webhook.ts";

export type RepoIdentityApp = Pick<GitHubApp, "reachesRepository" | "installationToken" | "identityFingerprint" | "installationOrg">;

/** What the owner record answers for an owner (owners.ts readOwnerIdentity). */
export type OwnerIdentityReader = (org: string) => { packagesCredentialId: string | null; repoCredentialId: string | null } | null;

/** The identity chosen for one repository: the App's installation token (minted now, for the reads
 *  the caller makes before any run exists) or the owner's repository PAT, opened now. */
export type RepoIdentity = { kind: "github-app"; token: string } | { kind: "pat"; token: string };

/** Whether the App reaches a repository named by its URL — the measurement behind the rule. */
export async function appReachesRepoURL(app: Pick<GitHubApp, "reachesRepository">, repoURL: string, signal?: AbortSignal): Promise<boolean> {
  const { owner, repo } = parseGitHubOwnerRepo(repoURL);
  return app.reachesRepository({ owner, repo, ...(signal ? { signal } : {}) });
}

export const ADD_APP_FORM = "the tenant's Add app form";
export const CONSUMER_WIZARD = "the consumer wizard";

/** The refusal a repository routing a scope to GitHub Packages gets where its owner records no
 *  packages reader — one sentence every caller uses; `where` names the place the token is given
 *  (a tenant's bundle: the Add app form, #233). */
export function packagesReaderMissing(owner: string, repo: string, scopes: readonly string[], where: string = CONSUMER_WIZARD): string {
  return `owner ${owner} records no packages reader, and ${owner}/${repo} installs private npm packages of ${scopes.map((s) => `@${s}`).join(", ")} from GitHub Packages (its .npmrc) — record a token that reads them in ${where} first`;
}

/** The scopes a repository's `.npmrc` routes to GitHub Packages — the one measurement that says
 *  whether its build needs the owner's packages reader. Empty for no `.npmrc`. */
export function npmrcPackageScopes(npmrc: string | null): string[] {
  return [...(npmrc ?? "").matchAll(/^@([^:\s]+):registry=https:\/\/npm\.pkg\.github\.com\/?\s*$/gm)].map((m) => m[1]!);
}

/** The rule, judged without minting or opening anything: what identity ${owner}/${repo} gets, or
 *  why it gets none. The plan-time half — the run's step resolves the same way and seals. */
export async function judgeRepoIdentity(input: { repoURL: string; githubApp?: Pick<GitHubApp, "reachesRepository" | "installationOrg"> | undefined; owners: OwnerIdentityReader; signal?: AbortSignal }): Promise<{ kind: "github-app" | "pat"; repoCredentialId?: string } | { refused: string; missing: "repository-pat"; owner: string }> {
  const { owner, repo } = parseGitHubOwnerRepo(input.repoURL);
  const org = input.owners(owner);
  if (input.githubApp && (await appReachesRepoURL(input.githubApp, input.repoURL, input.signal))) return { kind: "github-app" };
  if (org?.repoCredentialId) return { kind: "pat", repoCredentialId: org.repoCredentialId };
  const where = input.githubApp ? `is installed in the owner ${await input.githubApp.installationOrg(input.signal)} and does not reach ${owner}/${repo}` : "is not configured on this manager";
  return { refused: `the platform's GitHub App ${where}, and owner ${owner} records no repository PAT — install the App on the repository, or record the owner's repository PAT (repo + workflow + admin:repo_hook) in ${CONSUMER_WIZARD}`, missing: "repository-pat", owner };
}

/** The rule with the token in hand: the App's installation token minted now, or the owner's
 *  repository PAT opened from the store now. Throws the refusal. */
export async function resolveRepoIdentity(input: { repoURL: string; githubApp?: RepoIdentityApp | undefined; owners: OwnerIdentityReader; store: Pick<CredentialStore, "open">; signal?: AbortSignal }): Promise<RepoIdentity> {
  const judged = await judgeRepoIdentity(input);
  if ("refused" in judged) throw errValidation(judged.refused);
  if (judged.kind === "github-app") return { kind: "github-app", token: await input.githubApp!.installationToken(input.signal) };
  const pat = await input.store.open(judged.repoCredentialId!, { purpose: "repo-identity:owner-pat" });
  try {
    return { kind: "pat", token: pat.toString("utf8") };
  } finally {
    pat.fill(0);
  }
}

/** Why a PAT is refused on a repository's hooks, measured (#252): the account it acts as and its
 *  right there, and whose PAT to record instead. Null where that account IS admin — the refusal is
 *  then the token's own scope. */
export async function patHookRefusal(github: Pick<GitHubConsumer, "readTokenAccess">, input: { owner: string; repo: string; token: string; signal?: AbortSignal }): Promise<{ reading: string; hint: string } | null> {
  const access = await github.readTokenAccess(input);
  if (access.permission === "admin") return null;
  const right = access.permission === "none" || access.permission === undefined ? "no right" : `${access.permission} but not admin`;
  return {
    reading: `the PAT acts as ${access.login}, which holds ${right} on ${input.owner}/${input.repo}, and a build webhook needs admin`,
    hint: access.ownerKind === "User"
      ? `replace the repository PAT of ${input.owner} under Settings with one ${input.owner} created: ${input.owner} is a personal account, whose repositories have ${input.owner} alone as admin`
      : `replace the repository PAT of ${input.owner} under Settings with one of an account that is admin of ${input.owner}/${input.repo}`,
  };
}

/** THE CREDENTIAL ID A REPOSITORY IS REACHED WITH, RESOLVED NOW (#226): the App's one row where its
 *  installation reaches the repository, the owner's repository PAT row where it does not — never
 *  a row of the unit's. Throws the identity rule's refusal. What a run plans with, what the refresh
 *  writes, what an offboard's cleanup opens: every reader resolves it here, from the URL. */
export async function resolveRepoCredentialId(input: { repoURL: string; githubApp?: Pick<GitHubApp, "reachesRepository" | "installationOrg"> | undefined; owners: OwnerIdentityReader; store: Pick<CredentialStore, "list">; signal?: AbortSignal }): Promise<string> {
  const judged = await judgeRepoIdentity(input);
  if ("refused" in judged) throw errValidation(judged.refused);
  if (judged.kind === "pat") return judged.repoCredentialId!;
  const id = await appIdentityRowId(input.store);
  if (!id) throw errValidation("the platform's GitHub App reaches the repository, and this Manager holds no row for the App — boot seeds it (ensureAppIdentityRow)");
  return id;
}

/** The credential a STANDING unit's repository is reached with, for a cleanup that may find the
 *  unit without one (an adopted row with no URL, an owner whose identity was forgotten): undefined
 *  where none resolves, and the cleanup logs and skips the way it does for a row that never had a
 *  repository. Every other caller resolves through resolveRepoCredentialId and takes the refusal. */
export async function unitRepoCredentialId(input: { repoURL: string | null | undefined; githubApp?: Pick<GitHubApp, "reachesRepository" | "installationOrg"> | undefined; owners: OwnerIdentityReader; store: Pick<CredentialStore, "list">; signal?: AbortSignal }): Promise<string | undefined> {
  if (!input.repoURL) return undefined;
  try {
    return await resolveRepoCredentialId({ ...input, repoURL: input.repoURL });
  } catch {
    return undefined;
  }
}

/** The packages reader of a unit's owner, by the owner of its repository URL — what the
 *  build seed and the App-token refresh write beside the repository token; null where the
 *  owner records none. Whether that is a refusal depends on the repository's `.npmrc`:
 *  the seed step and the packages probe decide (npmrcPackageScopes). */
export function packagesReaderFor(owners: OwnerIdentityReader, repoURL: string): string | null {
  return owners(parseGitHubOwnerRepo(repoURL).owner)?.packagesCredentialId ?? null;
}
