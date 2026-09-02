// The cluster's Helm values chain — the files a unit's Application layers off the install branch
// through the `$values` source. The Manager reads them off the target cluster's install branch and
// hands them to the gate sandbox VERBATIM: the gate renders the chart with the same bytes ArgoCD
// layers at deploy, so an approved render and a deployed render cannot diverge. A derived summary
// would reintroduce exactly that second source of truth.
//
// WHICH files, and where the list comes from. An ApplicationSet's `valueFiles` mixes two kinds of
// entry: names resolved against the `$values` source, which is the install branch, and names
// resolved against the chart's own directory. Only the first kind is the CLUSTER's value surface and
// only that kind can be read here. The consumers ApplicationSet lists, in order:
//
//     $values/clusters/platform/values-common.yaml
//     $values/clusters/platform/values-<stage>.yaml
//     values.yaml                                   the chart's own
//     values-<stage>.yaml                           the chart's own
//     $values/clusters/active/<fqdn>.yaml
//
// The tenants ApplicationSet lists the same three `$values` entries around its own catalog files,
// and so does the ApplicationSet that carries the platform's own inventory apps. So one chain serves
// every unit this Manager gates, and the chart's own files always sit BETWEEN the platform pair and
// the cluster's own map — which is why the order below is not a flat list but a split one.
//
// `clusters/active/<fqdn>.yaml` is the cluster's own map, and it carries the installation's own
// answers outright rather than leaving them to a second file in a second spelling. It layers LAST
// and therefore wins, which is what makes a per-cluster answer able to override a platform default.
import { z } from "zod";
import type { Stage } from "./enums.ts";

/** The install-branch directory carrying the platform's own values — the product's defaults, the
 *  same on every installation. */
export const PLATFORM_VALUES_DIR = "clusters/platform";

/** The first file of every chain. It is also the file the channel ceiling
 *  (global.channelStages) and the build plane's copy of the release grammar
 *  (global.releaseTagFilter) are read from, on the trunk rather than on an install branch — one
 *  spelling of this path in the process, so a rename cannot move one reader and leave the others. */
export const PLATFORM_VALUES_COMMON = `${PLATFORM_VALUES_DIR}/values-common.yaml`;

/** The install-branch directory carrying one map per installed cluster. */
export const CLUSTER_MAP_DIR = "clusters/active";

/** The cluster's own map, named after the cluster's FQDN — which is also the name of its install
 *  branch. The last file of the chain and therefore the highest precedence at deploy. */
export function clusterMapPath(domain: string): string {
  return `${CLUSTER_MAP_DIR}/${domain}.yaml`;
}

export const ClusterValueFileSchema = z.object({
  /** The file's path on the install branch, e.g. "clusters/platform/values-common.yaml". */
  path: z.string().min(1),
  content: z.string(),
});
export type ClusterValueFile = z.infer<typeof ClusterValueFileSchema>;

export const ClusterValueFilesSchema = z.array(ClusterValueFileSchema);

/** The chain's paths in LAYERING order for one cluster and stage — the order the files must be
 *  passed to helm, later winning. */
export function clusterValueChainPaths(domain: string, stage: Stage): readonly string[] {
  return [PLATFORM_VALUES_COMMON, `${PLATFORM_VALUES_DIR}/values-${stage}.yaml`, clusterMapPath(domain)];
}

/** The chain cut where the chart's OWN values files stand, because that is where ArgoCD puts them:
 *  the platform pair layers before the chart can speak, the cluster's own map after it. A render
 *  that layered the whole chain on one side of the chart's files would let the chart override a
 *  platform default the deploy does not let it override, or refuse it one the deploy grants — the
 *  divergence this chain exists to make impossible.
 *
 *  The cut is by the cluster-map DIRECTORY rather than by position, so adding a platform file to the
 *  chain cannot silently move a file across the boundary. */
export function splitAtChartValues<T extends { path: string }>(chain: readonly T[]): { beforeChart: T[]; afterChart: T[] } {
  const beforeChart: T[] = [];
  const afterChart: T[] = [];
  for (const entry of chain) (entry.path.startsWith(`${CLUSTER_MAP_DIR}/`) ? afterChart : beforeChart).push(entry);
  return { beforeChart, afterChart };
}
