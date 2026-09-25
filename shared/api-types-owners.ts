/** GET /api/owners — the identity recorded for each owner (server
 *  plugins/unit/server/owners.ts, hostyour-manager#219): its two credentials as fingerprints and
 *  dates, never values, and whether the platform's GitHub App is installed in it. */
export interface OwnerCredentialView {
  fingerprint: string;
  recordedAt: string; // ISO
}

export interface OwnerIdentityView {
  org: string;
  /** The platform's GitHub App is installed in this owner: its repositories need no
   *  repository PAT — the App is their identity. */
  appInstalled: boolean;
  /** The owner's packages reader — what every build of its units installs private npm
   *  packages with. Required for every onboarding of a unit of the owner. */
  packagesReader: OwnerCredentialView | null;
  /** The owner's repository PAT — the repository identity where the App is not installed. */
  repositoryPat: OwnerCredentialView | null;
}

export interface OwnersListView {
  owners: OwnerIdentityView[];
}

/** PUT /api/owners/:org/packages-reader and /repository-pat — the one field, sent once
 *  over TLS, measured and sealed on the server, never echoed. */
export interface OwnerCredentialInput {
  token: string;
}
