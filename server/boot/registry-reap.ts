// The registry reaper as this server runs it, on the server's own database, credential store and
// GitHub App: every unit repository the server reaches, the reaper reaches with the same identity.
// reap() decides; this file hands it the carriers, the credentials and the registry, and says what
// it did.
import { join } from "node:path";
import type { Db } from "../db/client.ts";
import type { Logger } from "../kernel/logger.ts";
import type { CredentialStore } from "../security/store.ts";
import type { GitHubApp } from "../adapters/github-app/port.ts";
import type { PinHit } from "../../shared/pin.ts";
import { resolveRepoCredentialId } from "#unit/server/repo-identity.ts";
import { readOwnerIdentity } from "#unit/server/owners.ts";
import { createGitHubPlatform, type GitHubPlatformConfig } from "../adapters/github-platform/github-platform-http.ts";
import { GitPlatformRepo, GitRepoReader } from "../adapters/git/git.ts";
import { HttpRegistryMaintenance, REGISTRY_PUSH_DOCKERCONFIG_PATH } from "../adapters/registry/registry-http.ts";
import { reap } from "../domains/registry-cleanup/reap.ts";
import type { CarrierRepo } from "../domains/registry-cleanup/search.ts";

export interface RegistryReapDeps {
  db: Db;
  store: CredentialStore;
  githubApp: GitHubApp;
  logger: Logger;
  /** hostyour-cloud, read with the platform's own token (GITHUB_REPO + GITHUB_WRITE_PAT). */
  cloud: GitHubPlatformConfig;
  /** The deploy repository as owner/repo, read with a token the App mints at every run. */
  deploy: { owner: string; repo: string };
  /** The branch this installation keeps its registrations and pins on. */
  books: string;
  dataDir: string;
  registryHost: string;
  dryRun: boolean;
  /** The pins beyond the carrier search: every active plugin's, and every image a tenant holds. */
  pins: (signal?: AbortSignal) => Promise<PinHit[]>;
}

/** One GitOps repo as a carrier: its branch list over the REST API, its files over a worktree of its
 *  own under the data directory, apart from the onboarding worktrees. The search READS, so neither
 *  carrier mints a branch or carries the trunk into one: a books branch missing here means the floor
 *  cannot be built, and the reaper fails closed rather than scan a ref it wrote itself. */
function carrierRepo(cfg: GitHubPlatformConfig, dataDir: string, workRootName: string, books: string): CarrierRepo {
  const github = createGitHubPlatform(cfg);
  const repo = new GitPlatformRepo({
    platformRepoURL: `https://github.com/${cfg.owner}/${cfg.repo}.git`,
    booksBranch: books,
    carriesTrunkToBooksBranch: false,
    workRoot: join(dataDir, workRootName),
    credentialId: `${workRootName}-pat`,
    openCredential: () => Promise.resolve(Buffer.from(cfg.token, "utf8")),
  });
  return {
    booksBranch: repo.booksBranch,
    listBranches: () => github.listBranches(),
    withBranch: (branch, fn) => repo.withBranch(branch, fn),
  };
}

/** The credential a unit's chart repository is read with: the server's own rule, on the server's own
 *  database and store — the App's row where the App reaches the repository, the owner's repository
 *  PAT where it does not. */
export function reaperUnitCredential(deps: Pick<RegistryReapDeps, "db" | "store" | "githubApp">): (repoURL: string, signal?: AbortSignal) => Promise<string> {
  return (repoURL, signal) =>
    resolveRepoCredentialId({ repoURL, githubApp: deps.githubApp, owners: (org) => readOwnerIdentity(deps.db, org), store: deps.store, ...(signal ? { signal } : {}) });
}

/** One prune of the central registry. NEVER rejects: every failure is logged, and reap() reads
 *  everything before its first delete, so a failed read deletes nothing. */
export async function reapRegistry(deps: RegistryReapDeps): Promise<void> {
  try {
    const cloud = carrierRepo(deps.cloud, deps.dataDir, "reaper-cloud", deps.books);
    const deployToken = await deps.githubApp.installationToken();
    const deploy = carrierRepo({ ...deps.deploy, token: deployToken }, deps.dataDir, "reaper-deploy", deps.books);
    const unit = new GitRepoReader({ openCredential: (id) => deps.store.open(id, { purpose: "registry-reaper:read-unit-chart" }) });
    const unitCredential = reaperUnitCredential(deps);
    const registry = new HttpRegistryMaintenance({ registryHost: deps.registryHost, dockerConfigPath: REGISTRY_PUSH_DOCKERCONFIG_PATH });
    deps.logger.info({ registryHost: deps.registryHost, dryRun: deps.dryRun }, "registry-reaper: starting");
    const result = await reap({ cloud, deploy, unit, unitCredential, registry, logger: deps.logger, dryRun: deps.dryRun, pluginPins: deps.pins });
    deps.logger.info(
      { dryRun: result.dryRun, referencedCount: result.referencedCount, reposScanned: result.repos.length, manifestsDeleted: result.deleted.length },
      "registry-reaper: done",
    );
  } catch (err) {
    deps.logger.error({ err: err instanceof Error ? err.message : String(err) }, "registry-reaper: failed — a read failure deletes nothing, because every read runs before the first delete");
  }
}
