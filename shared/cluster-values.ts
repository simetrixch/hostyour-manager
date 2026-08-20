// The cluster's Helm values chain. Every unit's Application layers the same three files through the
// `$values` source — platform/values-common.yaml, then platform/values-<stage>.yaml, then
// installation/profile.yaml, later wins — and that chain is where a cluster's own values (Vault URL and
// auth mount, registry host, unit apex) live. The Controller reads the three files off the target
// cluster's install branch and hands them to the gate sandbox VERBATIM: the gate renders the chart
// with the same bytes ArgoCD layers at deploy, so an approved render and a deployed render cannot
// diverge. A derived summary would reintroduce exactly that second source of truth.
import { z } from "zod";
import type { Stage } from "./enums.ts";

export const ClusterValueFileSchema = z.object({
  /** The file's path in the platform repo, e.g. "platform/values-common.yaml". */
  path: z.string().min(1),
  content: z.string(),
});
export type ClusterValueFile = z.infer<typeof ClusterValueFileSchema>;

export const ClusterValueFilesSchema = z.array(ClusterValueFileSchema);

/** The chain's paths in LAYERING order for one stage — the order the files must be passed to helm. */
export function clusterValueChainPaths(stage: Stage): readonly string[] {
  return ["platform/values-common.yaml", `platform/values-${stage}.yaml`, "installation/profile.yaml"];
}
