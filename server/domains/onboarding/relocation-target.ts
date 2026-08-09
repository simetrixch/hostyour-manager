// The TARGET side of a relocation: which cluster a unit is restored into or moved onto, and the
// rule that admits one. Read from the clusters inventory, with the short name derived the ONE way
// the platform derives it (cluster-marking.ts) — the same name the registration's cluster field and
// the AppProject destination pin carry.
import { eq } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { clusters } from "../../db/schema/inventory.ts";
import { errNotFound, errValidation } from "../../kernel/errors.ts";
import type { Stage } from "../../../shared/enums.ts";
import { clusterShortName } from "../inventory/cluster-marking.ts";

export interface TargetCluster {
  clusterId: string;
  domain: string;
  stage: Stage;
  /** The cluster's SHORT name — what the repointed registration's cluster field carries. */
  cluster: string;
}

/** Resolve a relocation target: the cluster must exist, be ACTIVE (a unit cannot land on a cluster
 *  that is not serving) and carry the unit's own stage — a move never crosses a stage (the same
 *  boundary the registration writers enforce again at the commit). */
export function loadActiveTargetCluster(db: Db, clusterId: string, stage: Stage): TargetCluster {
  const row = db.select({ id: clusters.id, domain: clusters.domain, stage: clusters.stage, status: clusters.status }).from(clusters).where(eq(clusters.id, clusterId)).get();
  if (!row) throw errNotFound(`cluster ${clusterId}`);
  if (row.status !== "active") throw errValidation(`cluster ${row.domain} is not active (status "${row.status}") — a unit cannot be relocated onto it`);
  if (row.stage !== stage) {
    throw errValidation(`stage boundary: the unit is ${stage} but cluster ${row.domain} is marked ${row.stage} — stages never share a cluster, a unit moves within its stage`);
  }
  return { clusterId: row.id, domain: row.domain, stage: row.stage, cluster: clusterShortName(row.domain) };
}

/** The migrate admission: same stage, target active, source ≠ target. A move onto the unit's own
 *  cluster would dump and restore in place while switching nothing — an operator mistake, refused. */
export function assertMovableTo(db: Db, sourceClusterId: string, targetClusterId: string, stage: Stage): TargetCluster {
  if (sourceClusterId === targetClusterId) {
    throw errValidation(`the unit already runs on cluster ${targetClusterId} — a move needs a DIFFERENT target (use backup for a copy that stays)`);
  }
  return loadActiveTargetCluster(db, targetClusterId, stage);
}
