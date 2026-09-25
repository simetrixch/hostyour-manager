// The fake template and catalog a tenant-apps-repo test reads: a catalog naming the template by
// appsBundle + appsRepo, the template's apps.yaml with two apps, its build-only manifest, and the
// tree the reader lists — root files, the release kit (never copied) and the two app folders. And
// what every create-tenant test of a tenant WITH apps folds into its ports (withAppsTemplate).
import { PLATFORM_VALUES_COMMON } from "../../../shared/cluster-values.ts";
import { FakeRepoReader } from "../../adapters/git/testing/fake.ts";
import type { Db } from "../../db/client.ts";
import { seedAppIdentityRow, seedCredentialRow } from "../../security/store.fixture.ts";
import { FakeGitHubApp } from "../../adapters/github-app/testing/fake.ts";
import type { TenantOnboardPorts } from "./create-tenant.run.ts";
import { tenantAppsRepoURL, tenantAppsUnit } from "./tenant-apps-tree.ts";

export const SHA = "a".repeat(40);
export const GUID = "zsjs023ctne0";
export const ORG = "acme-org";
export const SUBDOMAIN = "acme";
export const BUNDLE = "example-apps"; // the template's name, tenant.appsBundle
export const UNIT = tenantAppsUnit(BUNDLE, SUBDOMAIN); // example-apps-acme
export const TENANT_URL = tenantAppsRepoURL(ORG, BUNDLE, SUBDOMAIN);
export const CATALOG_URL = "https://github.com/acme/acme-catalog.git";
export const TEMPLATE_URL = `https://github.com/${ORG}/example-apps.git`;
export const IMAGE_TAG = "0.1.0-stable-20260101000000-abc1234";

export const catalogManifest = (over: { appsOrg?: string; appsBundle?: string } = { appsOrg: ORG, appsBundle: "example-apps" }): string => `
apiVersion: hostyour.cloud/v1
kind: ConsumerManifest
name: acme-catalog
owner: platform
envs: [dev, prod]
tenant:
  ${over.appsOrg ? `appsOrg: ${over.appsOrg}` : ""}
  ${over.appsBundle ? `appsBundle: ${over.appsBundle}\n  appsRepo: ${TEMPLATE_URL}` : ""}
  members:
    - { name: auth, chart: charts/example-auth, identityProvider: true }
    - { name: jobs, chart: charts/example-jobs }
    - { name: report, chart: charts/example-report }
  perApp:
    engine: { chart: charts/example-engine }
    front: { chart: charts/example-ui }
`;

export const TEMPLATE_APPS_YAML = `# The app catalog of this bundle.
apps:
  - name: erp
    title: ERP
    description: >-
      Enterprise resource planning,
      split per domain.
    selections:
      seedReference: { title: "Reference data", default: true }
    databases: [core, sales]
  - name: web
    title: Website content
    selections:
      seedDemo: { title: "Demo data", default: false }
`;
export const TEMPLATE_MANIFEST = `
apiVersion: hostyour.cloud/v1
kind: ConsumerManifest
name: example-apps
owner: platform
envs: [dev, test, prod]
builds:
  - name: example-apps
    containerfile: docker/Dockerfile
`;
/** The template as the reader lists it: root files, the kit (never copied), two app folders. */
export const TEMPLATE_FILES: Record<string, string> = {
  "apps.yaml": TEMPLATE_APPS_YAML,
  "deploy/platform.yaml": TEMPLATE_MANIFEST,
  "package.json": '{ "name": "example-apps" }\n',
  ".dockerignore": ".git\n",
  "docker/Dockerfile": "FROM busybox\n",
  ".github/CODEOWNERS": "* @acme\n",
  ".github/workflows/release.yml": "name: an old kit\n",
  "release/release.sh": "#!/bin/sh\necho old kit\n",
  "erp/package.json": '{ "name": "erp" }\n',
  "erp/seeds/roles.json": "[]\n",
  "web/site.json": "{}\n",
};

/** The three lines a test catalog's `tenant:` block carries so a tenant WITH apps can be planned:
 *  the owner the App is installed in, the template's build name and its repository. */
export const TEMPLATE_SPEC = `  appsOrg: ${ORG}\n  appsBundle: example-apps\n  appsRepo: ${TEMPLATE_URL}\n`;

/** The tag the plan renders the unbuilt bundle at — `global.placeholderTag` off the chain. */
export const PLACEHOLDER_TAG = "0.0.0-placeholder";

/** What a create-tenant test of a tenant WITH apps needs beside its own ports: the GitHub App the
 *  repository is created with (installed in ORG), the template scripted on the catalog's reader, and
 *  the placeholder tag on the chain. The catalog manifest itself carries TEMPLATE_SPEC. */
export function withAppsTemplate(ports: TenantOnboardPorts, files: Record<string, string> = {}): TenantOnboardPorts & { githubApp: FakeGitHubApp } {
  if (!(ports.repo instanceof FakeRepoReader)) throw new Error("withAppsTemplate scripts the template on a FakeRepoReader");
  ports.repo.scriptFor(TEMPLATE_URL, { resolvedSha: SHA, files: { ...TEMPLATE_FILES, ...files } });
  const githubApp = new FakeGitHubApp();
  githubApp.org = ORG;
  const chain = ports.resolveClusterValueFiles;
  return {
    ...ports,
    githubApp,
    resolveClusterValueFiles: async (domain, stage) => [{ path: PLATFORM_VALUES_COMMON, content: `global:\n  placeholderTag: "${PLACEHOLDER_TAG}"\n` }, ...(await chain(domain, stage))],
  };
}

/** The owner identities a tenant test stands on (#220, #225): the App's owner ORG
 *  records its packages reader (the App reaches every repository of it); `acme` — the owner of the
 *  test catalog's build repositories, which the App does not reach — and `x`, the owner of the
 *  consumer tests' repository, record a packages reader and a repository PAT. Rows of the store
 *  with stable ids, opening to `token-of-<id>` under a real store. */
export function recordTestOwners(db: Db): void {
  const pat = (id: string, org: string, purpose: "packages-reader" | "repository-pat"): void =>
    seedCredentialRow(db, { id, kind: "pat", label: `${purpose === "packages-reader" ? "packages reader" : "repository PAT"} (${org})`, subject: { kind: "owner", id: org }, purpose });
  pat("cred_pkg_org", ORG, "packages-reader");
  pat("cred_pkg_acme", "acme", "packages-reader");
  pat("cred_pat_acme", "acme", "repository-pat");
  pat("cred_pkg_x", "x", "packages-reader");
  pat("cred_pat_x", "x", "repository-pat");
  // The App's one row, as boot seeds it: the identity of every repository the App reaches (#226).
  seedAppIdentityRow(db, ORG);
}
