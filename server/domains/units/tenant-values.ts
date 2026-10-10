// tenant-values.ts — the plan-time resolvers that turn INVENTORY (and the cluster values chain)
// into the facts a tenant run needs, extracted from create-tenant.run.ts the way onboard.run.ts
// extracted plugins/unit/server/seed-repo-pat.ts. The manager DB is the sole authority for cluster
// coordinates — never a hardcoded name:
//   - resolveTenantCluster:     the cluster a tenant stage is placed on, which must serve that stage.
//   - registryHostFromChain:    the registry host a cluster pulls its first-party images from, read
//                               off the cluster's OWN values chain (global.endpoints.registry.host).
//
// Boundary: domain layer — db schema + shared/ only, no adapters, no IO beyond the db reads.
import { eq } from "drizzle-orm";
import { parse as parseYaml } from "yaml";
import type { Db } from "../../db/client.ts";
import { clusters } from "../../db/schema/inventory.ts";
import { errNotFound, errValidation } from "../../kernel/errors.ts";
import type { Stage } from "../../../shared/enums.ts";
import { clusterServesStage } from "../../../shared/cluster-stage.ts";
import type { ClusterValueFile } from "../../../shared/cluster-values.ts";

/** Resolve the active machine a tenant stage is placed on. Every placement of a tenant stage (create, add
 *  stage, move, restore) passes here, so a machine of another stage is refused in this one place. */
export function resolveTenantCluster(db: Db, clusterId: string, stage: Stage): ResolvedTenantCluster {
  const row = db
    .select({ id: clusters.id, domain: clusters.domain, name: clusters.name, status: clusters.status, stage: clusters.stage })
    .from(clusters)
    .where(eq(clusters.id, clusterId))
    .get();
  if (!row) throw errNotFound(`cluster ${clusterId}`);
  if (row.status !== "active") throw errValidation(`cluster ${clusterId} is not active (status "${row.status}")`);
  if (!clusterServesStage(row.stage, stage)) throw errValidation(`machine ${row.name} (${row.domain}) serves ${row.stage} environments only and cannot take a ${stage} environment`);
  return { clusterId: row.id, domain: row.domain, cluster: row.name, stage: row.stage };
}

export interface ResolvedTenantCluster {
  clusterId: string;
  domain: string;
  /** The cluster's stored name (`clusters.name`, e.g. "s1"). */
  cluster: string;
  stage: Stage;
}

/** The registry host a cluster pulls its first-party images from: `global.endpoints.registry.host`
 *  off the cluster's OWN values chain, read in LAYERING order with the last file that states it
 *  winning — exactly as helm layers the chain, so the cluster's own map (which the run that
 *  generates an install branch writes as zot.<build-plane>) overrides the platform defaults.
 *  Reading the configured value instead of composing a host from an inventory row keeps this answer
 *  identical to the host the deployed charts compose image refs from; the two diverge the moment a
 *  cluster's build plane is not its master. A chain that states it nowhere is a VALIDATION error
 *  naming the files that were read.
 *
 *  `registry`, not `registrations`. The charts read `global.endpoints.registry.host` and nothing on
 *  an install branch carries the other spelling, so a fold looking for it finds nothing and
 *  refuses every tenant plan. `registrations` in this platform is the directory of unit registration
 *  files, which is a different thing entirely. */
export function registryHostFromChain(files: readonly ClusterValueFile[]): string {
  let found: string | null = null;
  for (const file of files) {
    const parsed: unknown = parseYaml(file.content);
    const host = (parsed as { global?: { endpoints?: { registry?: { host?: unknown } } } } | null)?.global?.endpoints?.registry?.host;
    if (typeof host === "string" && host.length > 0) found = host;
  }
  if (found === null) {
    throw errValidation(
      `no global.endpoints.registry.host in the cluster values chain (${files.map((f) => f.path).join(", ")}) — the fan-out's images are pulled from that registry, so there is no host to probe them in`,
    );
  }
  return found;
}

/** The tag a pin carries before its first release: `global.placeholderTag` off the cluster's values
 *  chain, read in layering order like the registry host above. The platform's own word for "no
 *  release has built this yet" — the pipeline seeds every unbuilt pin with it and the common chart
 *  refuses to render it. The tenant plan renders the tenant's own apps bundle at it, because the run
 *  builds that bundle and its tag is known only then; refresh-images renders again at the built
 *  tag, and nothing is ever deployed at the placeholder. A chain that states it nowhere is a
 *  VALIDATION error naming the files. */
export function placeholderTagFromChain(files: readonly ClusterValueFile[]): string {
  let found: string | null = null;
  for (const file of files) {
    const parsed: unknown = parseYaml(file.content);
    const tag = (parsed as { global?: { placeholderTag?: unknown } } | null)?.global?.placeholderTag;
    if (typeof tag === "string" && tag.length > 0) found = tag;
  }
  if (found === null) {
    throw errValidation(
      `no global.placeholderTag in the cluster values chain (${files.map((f) => f.path).join(", ")}) — the tenant's apps bundle is built by the run, and there is no tag to render it at until then`,
    );
  }
  return found;
}
