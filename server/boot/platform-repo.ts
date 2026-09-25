import { join } from "node:path";
import type { Config } from "../kernel/config.ts";
import type { Db } from "../db/client.ts";
import { GitPlatformRepo } from "../adapters/git/git.ts";
import type { PlatformRepo } from "../adapters/git/port.ts";
import { booksBranch } from "../domains/inventory/read.ts";

/** The ONE writer of the platform repo, or undefined without GitHub coordinates or a books branch. */
export function buildPlatformRepo(config: Config, db: Db): PlatformRepo | undefined {
  // THE branch this installation keeps its books on (shared/branches.ts), resolved ONCE, here, where
  // the ports are built — not looked up per run. The Manager runs ON the cluster holding the master
  // role and that cluster's FQDN IS the branch, so the value is already in its own inventory
  // (clusters.domain, which the schema states is the install branch) with MASTER_FQDN behind it: this
  // function runs BEFORE seedMaster writes that row, so on a first boot the configured value is the
  // only statement there is. Every registration writer and every cluster-map read stand on it, and
  // it is handed down bound to the repo port rather than threaded through the runs.
  const books = booksBranch(db, config.master?.fqdn);
  // The ONE writer of the platform repo: every registration commits through it, and deploy-slave
  // writes the slave part of a cluster map through it. Built once so all get the same instance (one
  // worktree, one lock) and so it survives a control host with no onboarding configured.
  // Without a books branch it is not built at all: every write through it would have to name a
  // branch, and the only name left would be the trunk — where a registration belongs to no
  // installation and to every future one at once.
  return config.github && books
    ? new GitPlatformRepo({
      platformRepoURL: `https://github.com/${config.github.owner}/${config.github.repo}.git`,
      booksBranch: books,
      // the deploy-branch program cuts this branch, stamps it and merges each release into it; a
      // missing one is a fault to raise, never a branch to mint from the trunk, and the product
      // reaches it there and not here (adapters/git/git.ts, carriesTrunkToBooksBranch).
      carriesTrunkToBooksBranch: false,
      workRoot: join(config.dataDir, "onboard-git"),
      credentialId: "platform-write-pat",
      openCredential: () => Promise.resolve(Buffer.from(config.github!.token, "utf8")),
    })
    : undefined;
}
