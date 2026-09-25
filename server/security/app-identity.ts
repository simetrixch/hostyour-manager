import type { GitHubApp } from "../adapters/github-app/port.ts";
import type { CredentialStore } from "./store.ts";

/** THE APP'S ONE ROW: a `github-app` credential storing nothing — the store mints an installation
 *  token from the App at every open (store.ts) — whose subject is the owner the App is installed
 *  with. ONE per installation, seeded at boot; every clone and every hook call the App reaches is
 *  handed this row's id. */
export async function ensureAppIdentityRow(store: Pick<CredentialStore, "list" | "seal">, githubApp: Pick<GitHubApp, "installationOrg" | "identityFingerprint">): Promise<string> {
  const owner = await githubApp.installationOrg();
  const standing = await appIdentityRowId(store);
  if (standing) return standing;
  return (await store.seal({ kind: "github-app", label: `GitHub App (${owner})`, plaintext: Buffer.alloc(0), fingerprint: githubApp.identityFingerprint(), subject: { kind: "owner", id: owner }, purpose: "repository-identity" })).id;
}

/** The App's one row, or null where boot has not seeded it. */
export async function appIdentityRowId(store: Pick<CredentialStore, "list">): Promise<string | null> {
  return (await store.list({ kind: "github-app", purpose: "repository-identity", excludeRotated: true })).find((r) => r.subject.kind === "owner")?.id ?? null;
}
