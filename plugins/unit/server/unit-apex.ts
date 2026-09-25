// The public apex a cluster's units serve under, read off the cluster's layered values chain.
import { parse as parseYaml } from "yaml";
import type { ClusterValueFile } from "#core/shared/cluster-values.ts";
import { errValidation } from "#core/server/kernel/errors.ts";

/** The ONE `global.unitApex` the layered cluster values chain resolves to — the public apex a unit's
 *  address is composed under (`<label>.<stage apex>`). The chain is read in LAYERING order and the last
 *  file that states the key wins, exactly as helm layers it, so a cluster's own `installation/profile.yaml`
 *  overrides the platform defaults. A chain that states it nowhere is a VALIDATION error naming the
 *  files that were read: rendering the host rule against a guessed apex would fence the unit off its
 *  own ingress. */
export function unitApexFromChain(files: readonly ClusterValueFile[]): string {
  let found: string | null = null;
  for (const file of files) {
    const parsed: unknown = parseYaml(file.content);
    const apex = (parsed as { global?: { unitApex?: unknown } } | null)?.global?.unitApex;
    if (typeof apex === "string" && apex.length > 0) found = apex;
  }
  if (found === null) {
    throw errValidation(
      `no global.unitApex in the cluster values chain (${files.map((f) => f.path).join(", ")}) — a unit's public host is <label>.<stage apex>, so the admission policy cannot be rendered without it`,
    );
  }
  return found;
}
