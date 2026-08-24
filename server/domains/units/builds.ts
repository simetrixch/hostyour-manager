// The chart side of the build declaration check (gate G18, chart half): which of the builds a unit
// DECLARES in deploy/platform.yaml its chart actually pins in `<chartPath>/values-<stage>.yaml`.
//
// The pin grammar is shared/pin.ts — the same `builds[]` entries the release pipeline's bump task
// rewrites the tag of and the registry reaper's floor reads. An image name is FLAT (no registry host,
// no unit segment), so a pin's `image` IS the build name: the mapping is a name lookup, nothing is
// composed. The gate checks the STRUCTURE — that the key the bump will later write into exists — not
// a concrete tag, because a unit that has never released carries a placeholder tag there.
//
// Pure: no IO. The caller passes the values file's text (read via the git port from the clone) so
// this module stays unit-testable without a repo.
import { parseBuildPins } from "../../../shared/pin.ts";

export interface ChartPinMapping {
  /** The declared build names with no `builds[]` entry whose `image` is that name. */
  missing: string[];
  /** The `image` of every pin the file states, for the gate's `found` sentence. */
  pinnedImages: string[];
  /** Why the file could not be read as the pin grammar (unparseable YAML, a `builds` that is not a
   *  list, an entry that is not {name, image, tag} with a flat image), or null when it read fine. An
   *  absent file is NOT an error here — it simply pins nothing, which the gate reports as missing. */
  error: string | null;
}

/** Map a unit's declared build names onto the pins its per-stage values file states. `source` names
 *  the file (repo-relative) so a grammar refusal points at the one to fix. */
export function mapBuildsToChartPins(input: {
  declaredBuilds: readonly string[];
  source: string;
  valuesStageYaml: string | null;
}): ChartPinMapping {
  if (input.valuesStageYaml === null) {
    return { missing: [...input.declaredBuilds], pinnedImages: [], error: null };
  }
  let pinnedImages: string[];
  try {
    pinnedImages = parseBuildPins(input.source, input.valuesStageYaml).map((p) => p.image);
  } catch (e) {
    // A file that does not obey the pin grammar pins nothing we can trust — reported as the gate's
    // found text rather than thrown, so the operator reads the refusal off the gate card.
    return { missing: [...input.declaredBuilds], pinnedImages: [], error: e instanceof Error ? e.message : String(e) };
  }
  const pinned = new Set(pinnedImages);
  return { missing: input.declaredBuilds.filter((name) => !pinned.has(name)), pinnedImages, error: null };
}
