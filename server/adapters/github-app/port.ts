// The platform's GitHub App — the identity a run creates a tenant's repository with. Neither of the
// two GitHub ports beside it can do that: github-consumer carries a customer's own PAT per call and
// github-platform the operator's write PAT for the platform repository, and a person's PAT inside an
// operator run is the wrong identity for a repository the platform owns. The App is installed ONCE
// in the owner the tenant repositories live in, and its three-part identity (GITHUB_APP_ID,
// GITHUB_APP_INSTALLATION_ID, GITHUB_APP_PRIVATE_KEY) enters the installation like every platform
// secret (kernel/config.ts githubApp). Kept a PORT so the run steps and the boot self-check depend on
// the abstraction; the fetch impl is github-app-http.ts, the fake is testing/fake.ts.
//
// Two credentials, and only one of them leaves this adapter. The App's JWT, signed with the private
// key, authenticates the App itself and reaches only the /app/* endpoints. The INSTALLATION TOKEN,
// minted through that JWT and short-lived, is what acts inside the owner — and it is the one
// the existing consumer port takes per call, so a run hands it on to ensureHook or dispatchWorkflow
// on a repository the App created.

export interface CreateRepositoryInput {
  /** The owner the repository is created in — the one the App is installed in
   *  (installationOrg), or GitHub refuses the create. */
  org: string;
  name: string;
  description: string;
  private: boolean;
  signal?: AbortSignal;
}

export interface GitHubApp {
  /** The installation access token (POST /app/installations/{id}/access_tokens), cached only while it
   *  has at least TOKEN_MIN_VALIDITY_MS of life left and minted afresh after that. The value is a credential:
   *  it is handed to the consumer port's per-call `token` and never logged. The credential store
   *  opens a `github-app` credential through this, so a token is never stored past its hour. */
  installationToken(signal?: AbortSignal): Promise<string>;
  /** A stable, non-secret fingerprint of this identity — the App id and the installation id —
   *  which a sealed `github-app` credential carries in place of a token's fingerprint, so an audit
   *  row names WHICH App acted. */
  identityFingerprint(): string;
  /** The owner this installation is bound to (GET /app/installations/{id} → account.login),
   *  read once and kept — an installation does not move between owners. What the readiness
   *  row names, and what a plan holds the catalog's own `appsOrg` against. */
  installationOrg(signal?: AbortSignal): Promise<string>;
  /** IDEMPOTENT create (POST /orgs/{org}/repos): {created:true} for a new repository, {created:false}
   *  when one of that name already stands — GitHub answers that with a 422 naming the field, and a
   *  run re-planned after a crash must find the repository rather than fail on it. Any other refusal
   *  throws GitHubAppError carrying GitHub's own message. */
  createRepository(input: CreateRepositoryInput): Promise<{ created: boolean }>;
  /** MEASURED, never inferred from an owner string: whether THIS installation reaches the repository
   *  (GET /repos/{owner}/{repo}/installation with the App's JWT answers the installation that covers
   *  it, or 404). True only when that installation is this one — the App installed in a second
   *  owner reaches that owner's repositories with a token this Manager never mints.
   *  The rule every repository credential follows (#194): reached ⇒ the App is its identity and no
   *  PAT is asked; not reached ⇒ the repository's own PAT, exactly as before the App existed. */
  reachesRepository(input: { owner: string; repo: string; signal?: AbortSignal }): Promise<boolean>;
  // NO deleteRepository, on purpose (#241): no run of this Manager deletes a repository on GitHub.
  // The App's installation owner is the customer's owner, so a repository name reached through it
  // is one of the customer's — the first purge of #241 deleted three of them. A repository the
  // platform created is the owner's to delete by hand once it is to go.
}

/** Any GitHub App API failure — a transport error, or a non-2xx that is not the idempotent
 *  already-exists answer. Carries GitHub's own message verbatim and the status, the shape the two
 *  GitHub ports beside this one use, kept a DISTINCT type so a step catches it through this port
 *  alone. */
export class GitHubAppError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "GitHubAppError";
    this.status = status;
  }
}
