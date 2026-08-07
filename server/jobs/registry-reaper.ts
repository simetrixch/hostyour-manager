// The registry-reaper entrypoint — a run-once job that wires the real adapters and calls reap()
// exactly once, then exits 0 (clean) / 1 (any failure). The GitOps deploy invokes this on the
// controller image with the controller's own env; this file is the composition root, kept out of
// boot/wire.ts because the reaper is its OWN process, not part of the server.
//
// FAIL-CLOSED on config, too. The floor is a search over three carrier classes, and every one of them
// needs a credential of its own: hostyour-cloud for the registrations and the platform apps,
// catalog for the tenant catalog, and each unit's own sealed repo credential for its chart. A
// missing one would not shrink the floor quietly — the search would abort — but there is no reason to
// start a run that cannot finish, so the job refuses at wiring time and names what is unset.
import { join } from "node:path";
import { loadConfig } from "../kernel/config.ts";
import { createLogger } from "../kernel/logger.ts";
import { openDb } from "../db/client.ts";
import { booksBranch } from "../domains/inventory/read.ts";
import { CredentialStore } from "../security/store.ts";
import { loadOrCreateDataKey } from "../kernel/datakey.ts";
import { VaultKvClient } from "../adapters/vault/vault-kv.ts";
import { createGitHubClient, type GitHubConfig } from "../adapters/github/github.ts";
import { GitPlatformRepo, GitRepoReader } from "../adapters/git/git.ts";
import { HttpRegistryMaintenance } from "../adapters/registry/registry-http.ts";
import { reap } from "../domains/registry-cleanup/reap.ts";
import type { CarrierRepo } from "../domains/registry-cleanup/search.ts";

/** Where the reaper's PUSH credential dockerconfigjson is mounted by the CronJob. The push-user has
 *  delete rights; distinct from the controller-registry-pull path the probe uses. */
const DEFAULT_PUSH_DOCKERCONFIG_PATH = "/etc/controller/registry-push/.dockerconfigjson";

/** One GitOps repo as a carrier: its branch list over the REST API, its files over a persistent
 *  worktree. `workRoot` is its own so the reaper never collides with the onboarding worktrees, and the
 *  two carrier repos never collide with each other. The search READS (search.ts, CarrierRepo), so
 *  neither carrier mints a branch: a books branch missing here means the floor cannot be built, and
 *  the reaper must fail closed on that rather than scan a ref it created itself. */
function carrierRepo(cfg: GitHubConfig, dataDir: string, workRootName: string, books: string): CarrierRepo {
  const github = createGitHubClient(cfg);
  const repo = new GitPlatformRepo({
    platformRepoURL: `https://github.com/${cfg.owner}/${cfg.repo}.git`,
    booksBranch: books,
    createsBooksBranch: false,
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

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config);

  const githubCfg = config.github;
  if (!githubCfg) {
    logger.error({}, "registry-reaper: GITHUB_REPO/GITHUB_WRITE_PAT unset — the registrations and the platform app pins cannot be read, so the referenced floor cannot be built (fail-closed, nothing deleted)");
    process.exit(1);
  }
  const deployCfg = config.catalog;
  if (!deployCfg) {
    logger.error({}, "registry-reaper: CATALOG_WRITE_PAT unset — the tenant catalog's pins cannot be read, so the referenced floor would miss every tenant image (fail-closed, nothing deleted)");
    process.exit(1);
  }

  const registryHost = process.env.REGISTRY_HOST?.trim();
  if (!registryHost) {
    logger.error({}, "registry-reaper: REGISTRY_HOST unset — no registry to prune (fail-closed, nothing deleted)");
    process.exit(1);
  }
  const dockerConfigPath = process.env.REGISTRY_PUSH_DOCKERCONFIG?.trim() || DEFAULT_PUSH_DOCKERCONFIG_PATH;

  // Fail-safe default: DELETE only on an EXPLICIT DRY_RUN=false. Unset, "", "true", "1", or any other
  // value ⇒ a dry run. A missing/garbled flag can therefore never delete by accident.
  const dryRun = process.env.DRY_RUN !== "false";

  // The unit charts are read under each unit's OWN sealed repo credential, so the reaper needs the
  // same credential store the server runs on — same backend selection, same keystore.
  const db = openDb(config.dbFile);
  const store = new CredentialStore({
    db: db.db,
    logger,
    ...(config.vault ? { vault: new VaultKvClient(config.vault) } : { dataKey: loadOrCreateDataKey(config.dataDir) }),
  });

  // WHERE the registrations of class (a) stand: this installation's books branch. The reaper runs
  // with an emptyDir DATA_DIR, so its database is empty on every run and MASTER_FQDN is the only
  // statement of it there is — without it the search would read a branch that carries no
  // registrations, find no unit charts, and call every unit's live image tag unreferenced.
  const books = booksBranch(db.db, config.master?.fqdn);
  if (!books) {
    logger.error({}, "registry-reaper: MASTER_FQDN unset — the branch this installation keeps its registrations on cannot be derived, so class (a) of the floor would be empty and every deployed unit's image would look unreferenced (fail-closed, nothing deleted)");
    process.exit(1);
  }
  const cloud = carrierRepo(githubCfg, config.dataDir, "reaper-cloud", books);
  const deployRepoPath = deployCfg.repoURL.replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "");
  const [deployOwner, deployRepo] = deployRepoPath.split("/");
  if (!deployOwner || !deployRepo) {
    logger.error({ repoURL: deployCfg.repoURL }, "registry-reaper: CATALOG_REPO is not owner/repo — the tenant catalog's branches cannot be enumerated (fail-closed, nothing deleted)");
    process.exit(1);
  }
  const deploy = carrierRepo({ owner: deployOwner, repo: deployRepo, token: deployCfg.token }, config.dataDir, "reaper-deploy", books);
  const unit = new GitRepoReader({ openCredential: (id) => store.open(id, { purpose: "registry-reaper:read-unit-chart" }) });
  const registry = new HttpRegistryMaintenance({ registryHost, dockerConfigPath });

  logger.info({ registryHost, dockerConfigPath, dryRun }, "registry-reaper: starting");
  const result = await reap({ cloud, deploy, unit, registry, logger, dryRun });
  logger.info(
    {
      dryRun: result.dryRun,
      referencedCount: result.referencedCount,
      reposScanned: result.repos.length,
      manifestsDeleted: result.deleted.length,
    },
    "registry-reaper: done",
  );
}

main().catch((err: unknown) => {
  process.stderr.write(`registry-reaper fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
