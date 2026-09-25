import type { Config } from "../kernel/config.ts";
import type { Logger } from "../kernel/logger.ts";
import type { Db } from "../db/client.ts";
import type { Core } from "../plugin.ts";
import { CredentialStore } from "../security/store.ts";
import { storeBackend } from "./store-backend.ts";
import { masterKubeClients, masterKubeInput } from "./master-kube.ts";
import { KubeClusterReader } from "../adapters/kube/kube.ts";
import { makeClusterKubeResolver } from "../domains/inventory/cluster-kube.ts";
import { HttpGitHubApp } from "../adapters/github-app/github-app-http.ts";
import { buildPlatformRepo } from "./platform-repo.ts";

/** What every process of the product builds the same way over its opened database, and hands each
 *  plugin it activates: the credential store, the platform's GitHub App identity, the master's kube
 *  access with the one resolver over it, and the platform repo. Built by the server (wire.ts) and
 *  by the registry reaper (jobs/registry-reaper.ts). */
export function buildCore(config: Config, logger: Logger, db: Db): Omit<Core, "plugins"> {
  // THE PLATFORM'S GITHUB APP IDENTITY — one client, one token cache: the credential store mints a
  // `github-app` credential through it at every open, and the readiness checks name the owner it is
  // installed with. Every installation has it (config.ts githubApp).
  const githubApp = new HttpGitHubApp(config.githubApp);
  // Secrets backend: Vault when configured (prod), else a local keyfile-encrypted store (dev). Either
  // way the store API is identical to every caller, and one of the two is always supplied
  // (boot/store-backend.ts).
  const store = new CredentialStore({ db, logger, ...storeBackend(config), githubApp });
  // THE MASTER-LOCAL KUBE CLIENTS AND THE ONE RESOLVER OVER THEM, built here and handed to everything
  // that needs them. A family building its own trio and its own resolver from the same input puts
  // both behind that family's configuration guard, and a cluster run kind can then reach neither.
  const master = masterKubeClients(config);
  const resolver = makeClusterKubeResolver({
    db,
    master,
    openCredential: (id) => store.open(id, { purpose: "cluster-kube:resolve" }),
    buildClusterReader: (input) => new KubeClusterReader(input),
  });
  const platformRepo = buildPlatformRepo(config, db);
  return {
    config,
    db,
    store,
    logger,
    kube: { input: masterKubeInput(config), master, resolver },
    ...(platformRepo ? { platformRepo } : {}),
    githubApp,
  };
}
