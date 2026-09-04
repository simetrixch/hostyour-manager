// THE reader of a cluster's Helm values chain off its install branch. One function, so the consumer
// family and the tenant family cannot answer the same question differently — they did, and the two
// disagreed about the one thing that matters here: whether a missing file is fatal.
//
// A MISSING FILE THROWS. The chain is the cluster's whole value surface, so a render assembled
// without one of its files would silently drop the Vault URL, the registry host and the unit apex
// and approve a chart nobody could deploy. The consumers ApplicationSet does not set
// `ignoreMissingValueFiles`, so at deploy a missing file is a sync error there too, and the two
// sides agree. The tenants ApplicationSet does set it, so for a tenant this reader is STRICTER than
// the deploy: it can refuse a chain ArgoCD would have tolerated, and it can never approve one ArgoCD
// would reject. Refusing more than the deploy is the safe direction; approving more is the one that
// breaks the promise the chain exists to keep.
//
// Boundary: domain layer — shared/ and the git PlatformRepo port only, like channel-stages beside it.
import { AppError } from "../../kernel/errors.ts";
import { clusterValueChainPaths, type ClusterValueFile } from "../../../shared/cluster-values.ts";
import type { Stage } from "../../../shared/enums.ts";
import type { PlatformRepo } from "../../adapters/git/port.ts";

/** Read `domain`'s values chain off the installation's books branch, in layering order.
 *
 *  THE BRANCH IS THE BOOKS AND NOT THE DOMAIN. An installation has exactly one install branch — the
 *  one named after the cluster carrying the master part — and every cluster map of the installation
 *  stands on it, a pure slave's included, because a pure slave has no branch of its own. Reading a
 *  cluster's chain off a branch named after that cluster therefore answered for the master and threw
 *  for every other cluster, which is every tenant and every app onboarded onto a slave. */
export async function readClusterValueChain(repo: PlatformRepo, domain: string, stage: Stage): Promise<ClusterValueFile[]> {
  return repo.withBranch(repo.booksBranch, async (cluster) => {
    const files: ClusterValueFile[] = [];
    for (const path of clusterValueChainPaths(domain, stage)) {
      const content = await cluster.readFile(path);
      if (content === null) {
        throw new AppError("UPSTREAM", `${repo.booksBranch} carries no ${path} — the cluster values chain for ${domain} is incomplete`);
      }
      files.push({ path, content });
    }
    return files;
  });
}
