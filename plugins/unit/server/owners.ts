import type { Db } from "#core/server/db/client.ts";
import { writeAudit } from "#core/server/db/audit-writer.ts";
import { ownerIdentity, ownersWithIdentity } from "#core/server/security/store.ts";
import { errNotFound, errValidation } from "#core/server/kernel/errors.ts";
import { fingerprintSecret } from "#core/server/security/fingerprint.ts";
import type { CredentialStore } from "#core/server/security/store.ts";
import type { GitHubApp } from "#core/server/adapters/github-app/port.ts";
import type { GitHubConsumer } from "./adapters/github-consumer/port.ts";
import type { OwnerIdentityView, OwnerCredentialView } from "#core/shared/api-types-owners.ts";
import { missingConsumerPatScopes } from "./pat-scopes.ts";

// THE IDENTITY OF AN OWNER (hostyour-manager#218, #219, #225): recorded once, measured
// before it is sealed, derived per unit from the owner of its repository URL by the identity rule
// (repo-identity.ts). Two credentials per owner, each a row of the store whose subject is
// the owner and whose purpose says which (there is no table of ids beside the store):
//  - the PACKAGES READER: what a build's `.npmrc` carries. GitHub grants an App installation token
//    no access to a private npm package whatever the App's permissions say, so this is a PAT —
//    classic with read:packages or fine-grained with Packages: Read — and the measurement is the
//    one thing that proves it: the token reads the owner's packages, or it is refused;
//  - the REPOSITORY PAT: the repository identity where the platform's App is not installed in the
//    owner (repo + workflow + admin:repo_hook). Absent where the App reaches, the ordinary case.
// A token is measured, sealed with its fingerprint, and zeroed; it is never logged and never
// persisted raw. Replacing a credential revokes the row it replaces; the newest unrevoked row of a
// purpose is the owner's (store.ts ownerIdentity).

export interface OwnerDeps {
  db: Db;
  store: Pick<CredentialStore, "seal" | "revoke" | "list">;
  github: Pick<GitHubConsumer, "readOrgToken" | "readTokenAccess">;
  githubApp?: Pick<GitHubApp, "installationOrg"> | undefined;
  actor: () => string;
}

/** The three scopes the owner's repository PAT carries — the consumer contract without
 *  read:packages, which the packages reader carries instead. */
export const REPOSITORY_PAT_SCOPES = ["repo", "workflow", "admin:repo_hook"] as const;

const ORG_RE = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/i;

export function assertOrgLogin(org: string): string {
  if (!ORG_RE.test(org)) throw errValidation(`"${org}" is not a GitHub owner login`);
  return org;
}

/** Every owner with an identity recorded, and which of them the App is installed in. */
export async function listOwnerIdentities(deps: Pick<OwnerDeps, "db" | "store" | "githubApp">, signal?: AbortSignal): Promise<OwnerIdentityView[]> {
  const appOrg = deps.githubApp ? await deps.githubApp.installationOrg(signal) : null;
  const orgs = ownersWithIdentity(deps.db);
  // The App's own owner is listed even before anything is recorded for it: it is the one
  // the operator most likely needs to complete.
  if (appOrg && !orgs.includes(appOrg)) orgs.push(appOrg);
  const rows = await deps.store.list({ kind: "pat" });
  const view = (id: string | null): OwnerCredentialView | null => {
    const row = id ? rows.find((r) => r.id === id) : undefined;
    return row ? { fingerprint: row.fingerprint, recordedAt: row.recordedAt } : null;
  };
  return orgs.sort().map((org) => {
    const ids = ownerIdentity(deps.db, org);
    return { org, appInstalled: org === appOrg, packagesReader: view(ids?.packagesCredentialId ?? null), repositoryPat: view(ids?.repoCredentialId ?? null) };
  });
}

/** ONE owner's recorded packages reader as the wizard shows it — fingerprint and date — or null. */
export async function packagesReaderView(deps: { db: Db; store: Pick<CredentialStore, "list"> }, org: string): Promise<OwnerCredentialView | null> {
  const id = ownerIdentity(deps.db, org)?.packagesCredentialId ?? null;
  if (!id) return null;
  const row = (await deps.store.list({ subject: { kind: "owner", id: org }, purpose: "packages-reader" })).find((r) => r.id === id);
  return row ? { fingerprint: row.fingerprint, recordedAt: row.recordedAt } : null;
}

/** The credential ids an onboarding derives a unit's identity from — the identity rule's read. */
export function readOwnerIdentity(db: Db, org: string): { packagesCredentialId: string | null; repoCredentialId: string | null } | null {
  return ownerIdentity(db, org);
}

async function record(deps: OwnerDeps, org: string, purpose: "packages-reader" | "repository-pat", token: string, label: string): Promise<OwnerCredentialView> {
  const plaintext = Buffer.from(token, "utf8");
  const fingerprint = fingerprintSecret(plaintext); // before seal() zeroes the buffer
  const standing = ownerIdentity(deps.db, org);
  const replaced = purpose === "packages-reader" ? standing?.packagesCredentialId ?? null : standing?.repoCredentialId ?? null;
  const ref = await deps.store.seal({ kind: "pat", label, plaintext, fingerprint, subject: { kind: "owner", id: org }, purpose });
  if (replaced) await deps.store.revoke(replaced, `replaced by ${ref.id} (${label})`);
  writeAudit(deps.db, { actor: deps.actor(), action: "owner.credential_recorded", targetKind: "owner", targetId: org, detail: { purpose, credentialId: ref.id, fingerprint, replaced } });
  return { fingerprint, recordedAt: ref.recordedAt };
}

/** Records the owner's packages reader after measuring that it reads the owner's
 *  packages. Refused by name otherwise: an invalid token, one without read:packages, an
 *  owner the token cannot see. */
export async function recordPackagesReader(deps: OwnerDeps, org: string, token: string, signal?: AbortSignal): Promise<OwnerCredentialView> {
  assertOrgLogin(org);
  const reading = await deps.github.readOrgToken({ org, token, ...(signal ? { signal } : {}) });
  if (reading.packages === "invalid") throw errValidation(`the token is invalid or expired — GitHub answered 401 for the packages of ${org}`);
  if (reading.packages === "absent") throw errValidation(`GitHub knows no owner "${org}" this token can see (404 on its packages)`);
  if (reading.packages === "unreadable") {
    throw errValidation(reading.classic
      ? `the token does not read the packages of ${org} — a classic PAT needs the read:packages scope (granted: ${reading.scopes.join(", ") || "none"})`
      : `the token does not read the packages of ${org} — a fine-grained PAT needs the "Packages: Read" permission for this owner`);
  }
  return record(deps, org, "packages-reader", token, `packages reader (${org})`);
}

/** Records the owner's repository PAT after measuring its scopes: a classic PAT carrying
 *  repo + workflow + admin:repo_hook. A fine-grained token reports no scopes and is refused. And the
 *  account it acts as (#252): a personal account's repositories have their owner alone as admin, and
 *  the build webhook needs admin, so a personal owner's PAT is one that owner created. An
 *  organisation grants admin per repository, which the onboarding's webhook probe measures. */
export async function recordRepositoryPat(deps: OwnerDeps, org: string, token: string, signal?: AbortSignal): Promise<OwnerCredentialView> {
  assertOrgLogin(org);
  const reading = await deps.github.readOrgToken({ org, token, ...(signal ? { signal } : {}) });
  if (reading.packages === "invalid") throw errValidation(`the token is invalid or expired — GitHub answered 401 for ${org}`);
  if (!reading.classic) throw errValidation(`the token is fine-grained, which reports no scopes — the repository PAT of an owner is a CLASSIC PAT with ${REPOSITORY_PAT_SCOPES.join(" + ")}`);
  const missing = missingConsumerPatScopes(reading.scopes);
  if (missing.length > 0) throw errValidation(`the token lacks ${missing.join(", ")} (granted: ${reading.scopes.join(", ") || "none"}) — the repository PAT of an owner carries ${REPOSITORY_PAT_SCOPES.join(" + ")}`);
  const access = await deps.github.readTokenAccess({ owner: org, token, ...(signal ? { signal } : {}) });
  if (access.ownerKind === "User" && access.login.toLowerCase() !== org.toLowerCase()) {
    throw errValidation(`the token acts as ${access.login}, and ${org} is a personal account, whose repositories have ${org} alone as admin — the build webhook needs admin, so the repository PAT of ${org} is one ${org} created`);
  }
  return record(deps, org, "repository-pat", token, `repository PAT (${org})`);
}

/** Forgets one credential of the owner: its newest row of that purpose is revoked. */
export async function forgetOwnerCredential(deps: OwnerDeps, org: string, which: "packages-reader" | "repository-pat"): Promise<void> {
  const standing = ownerIdentity(deps.db, org);
  const id = which === "packages-reader" ? standing?.packagesCredentialId : standing?.repoCredentialId;
  if (!id) throw errNotFound(`owner ${org} records no ${which}`);
  await deps.store.revoke(id, `forgotten: ${which} of ${org}`);
  writeAudit(deps.db, { actor: deps.actor(), action: "owner.credential_forgotten", targetKind: "owner", targetId: org, detail: { purpose: which, credentialId: id } });
}
