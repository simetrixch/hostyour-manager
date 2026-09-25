// The sweep the App-token refresh timer runs over every live unit: a repository the owner's GitHub App
// reaches carries no repository Secret (repo-credential-keep.ts), so one standing is taken away. Its
// own module because it reads the live statuses from onboard-abort.ts, which imports the onboarding
// steps that import repo-credential-keep.ts.
import { inArray } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { apps } from "../../db/schema/inventory.ts";
import type { ClusterKubeResolver, RepoCredentialWriter } from "../../adapters/kube/port.ts";
import type { GitHubApp } from "../../adapters/github-app/port.ts";
import type { Logger } from "../../kernel/logger.ts";
import { consumerRepoCredentialName } from "./repo-credential.ts";
import { appReachesRepoURL } from "./repo-identity.ts";
import { CONSUMER_LIVE_STATUS } from "./onboard-abort.ts";

export interface SweepRepoCredentialsDeps {
  db: Db;
  githubApp: Pick<GitHubApp, "reachesRepository">;
  resolver: Pick<ClusterKubeResolver, "resolve">;
  repoCredential: Pick<RepoCredentialWriter, "deleteRepoCredential">;
  logger: Pick<Logger, "info" | "error">;
}

/** Every live unit (active or suspended) whose repository the App reaches loses a repository Secret
 *  standing for it — a token an earlier onboarding wrote, which dies within the hour and shadows the
 *  App's credential template. A PAT unit's Secret is not touched: the offboard, the purge and the
 *  relocation delete it while the unit's row still reads live, and a write from here would put it
 *  back behind them. One unit's failure is that unit's, logged by name; the others go on. */
export async function sweepRepoCredentials(deps: SweepRepoCredentialsDeps): Promise<{ removed: string[]; failed: string[] }> {
  const removed: string[] = [];
  const failed: string[] = [];
  const rows = deps.db
    .select({ name: apps.name, stage: apps.stage, clusterId: apps.clusterId, repoUrl: apps.repoUrl })
    .from(apps)
    .where(inArray(apps.status, [...CONSUMER_LIVE_STATUS]))
    .all();
  for (const r of rows) {
    if (!r.repoUrl) continue;
    const unit = `${r.name}-${r.stage}`;
    try {
      if (!(await appReachesRepoURL(deps.githubApp, r.repoUrl))) continue;
      const { argoNamespace } = await deps.resolver.resolve(r.clusterId);
      const { deleted } = await deps.repoCredential.deleteRepoCredential(argoNamespace, consumerRepoCredentialName(r.name, r.stage));
      if (deleted) {
        removed.push(unit);
        deps.logger.info({ unit, argoNamespace }, "the token repository Secret of this unit is removed — ArgoCD reads its repository through the App's credential template");
      }
    } catch (err) {
      failed.push(unit);
      deps.logger.error({ unit, err: err instanceof Error ? err.message : String(err) }, "this unit's repository Secret could not be checked on this tick — the next tick tries again");
    }
  }
  return { removed, failed };
}
