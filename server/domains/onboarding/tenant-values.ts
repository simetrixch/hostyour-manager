// tenant-values.ts — the plan-time resolvers that turn INVENTORY (and the cluster values chain)
// into the facts a tenant run needs, extracted from create-tenant.run.ts the way onboard.run.ts
// extracted onboard-seed-repo-pat.ts. The controller DB is the sole authority for cluster
// coordinates — never a hardcoded name:
//   - the two name resolvers:   a cluster's SHORT NAME both ways — from a clusterId, and back to a
//                               clusterId. Both go through clusterShortName(clusters.domain)
//                               (inventory/cluster-marking.ts), the one derivation in this repo.
//   - resolveMasterCluster:     the master self-cluster's row — the build-only onboard's target.
//   - registryHostFromChain:    the registry host a cluster pulls its first-party images from, read
//                               off the cluster's OWN values chain (global.endpoints.registry.host).
//
// Boundary: domain layer — db schema + shared/ only, no adapters, no IO beyond the db reads.
import { eq, inArray } from "drizzle-orm";
import { parse as parseYaml } from "yaml";
import type { Db } from "../../db/client.ts";
import { clusters, servers } from "../../db/schema/inventory.ts";
import { errValidation } from "../../kernel/errors.ts";
import { MASTER_ROLES, type Stage } from "../../../shared/enums.ts";
import type { ClusterValueFile } from "../../../shared/cluster-values.ts";
import { clusterShortName } from "../inventory/cluster-marking.ts";

/** The cluster SHORT NAME of ONE cluster row — the FORWARD direction of resolveClusterIdByName
 *  below. The teardown resolver (tenant-replace.ts) needs it whenever a tenant's target must be
 *  named WITHOUT its pointer: the pointer's own `cluster` field is the primary source, but a tenant
 *  whose tenant.yaml is already gone (a tenant-offboard that removed the pointer and then failed) can
 *  only be named from its inventory row, which carries a cls_-prefixed clusterId and no name at all.
 *  null when no such cluster row exists — a caller that requires the name says so itself rather than
 *  substituting an id. */
export function resolveClusterNameById(db: Db, clusterId: string): string | null {
  const row = db.select({ domain: clusters.domain }).from(clusters).where(eq(clusters.id, clusterId)).get();
  return row ? clusterShortName(row.domain) : null;
}

/** The inverse, for the create-tenant replace lookup: find the cluster row whose short name matches
 *  `cluster` at `stage`, returning its id + domain. Resolves an ORPHAN tenant's target cluster from
 *  its pointer's `cluster` field alone (no tenants row to read a clusterId from). null when no such
 *  cluster is registered. */
export function resolveClusterIdByName(db: Db, cluster: string, stage: Stage): { clusterId: string; domain: string } | null {
  const rows = db
    .select({ id: clusters.id, domain: clusters.domain })
    .from(clusters)
    .where(eq(clusters.stage, stage))
    .all();
  for (const r of rows) {
    if (clusterShortName(r.domain) === cluster) return { clusterId: r.id, domain: r.domain };
  }
  return null;
}

/** The master self-cluster's row (e.g. m1.example.com) — resolved from inventory via the
 *  ONE server row carrying the master part (servers_one_master_uq; seeded by boot/seed-master.ts).
 *  The build-only onboard acts on it — the gates run against it, and its map then names the build
 *  plane the webhook goes to — so a missing master row fails that plan loud. */
export function resolveMasterCluster(db: Db): { clusterId: string; domain: string } {
  const row = db
    .select({ id: clusters.id, domain: clusters.domain })
    .from(clusters)
    .innerJoin(servers, eq(clusters.serverId, servers.id))
    .where(inArray(servers.role, [...MASTER_ROLES]))
    .get();
  if (!row) {
    throw errValidation(
      "no master control cluster is registered in inventory — the build-only onboard runs against the master; seed the master first (MASTER_FQDN)",
    );
  }
  return { clusterId: row.id, domain: row.domain };
}

/** The registry host a cluster pulls its first-party images from: `global.endpoints.registry.host`
 *  off the cluster's OWN values chain, read in LAYERING order with the last file that states it
 *  winning — exactly as helm layers the chain, so the cluster's profile (which set-role.sh writes as
 *  zot.<build-plane>) overrides the platform defaults. Reading the configured value instead of
 *  composing a host from an inventory row keeps this answer identical to the host the deployed
 *  charts compose image refs from; the two diverge the moment a cluster's build plane is not its
 *  master. A chain that states it nowhere is a VALIDATION error naming the files that were read. */
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
