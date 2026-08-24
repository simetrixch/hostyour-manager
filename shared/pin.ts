// The image pin grammar — the ONE form in which every carrier states a built image, written by the
// release bump and read by the registry reaper's referenced floor. A pin is an entry of `builds[]`
// in a chart's `values-<stage>.yaml`:
//
//   builds:
//     - name: manager
//       image: manager
//       tag: 0.1.0-stable-20260728000000-abc1234
//
// `image` is the FLAT build name: no registry host, no unit segment, nothing to compose. That is
// what makes `<image>:<tag>` the registry key directly — the repository name the catalog returns
// IS `builds[].image`. A host- or path-qualified image would key the floor on a name the catalog
// never returns, so the tag it was meant to protect would fall to the delete plan unnoticed; the
// schema therefore REFUSES such a pin rather than normalizing it, and the reader that hits one
// aborts instead of continuing with a floor it cannot trust.
import { z } from "zod";
import { parse } from "yaml";
import { STAGE, type Stage } from "./enums.ts";

/** One pinned image as a carrier states it. `name` keys the image inside the chart; `image` is the
 *  registry repository; `tag` is the minted release image tag. */
const BuildPinSchema = z.object({
  name: z.string().regex(/^[a-z0-9-]+$/),
  // Single-segment by construction: a "/" would make this a path rather than a flat build name.
  image: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
  tag: z.string().min(1),
});
export type BuildPin = z.infer<typeof BuildPinSchema>;

/** The registry key of a pin — `<image>:<tag>`, the same string the catalog + tag list yield. */
export function pinKey(pin: BuildPin): string {
  return `${pin.image}:${pin.tag}`;
}

/** ONE pin found by the carrier search, with WHERE it stands — "<repo>@<branch>:<path>". The location
 *  travels with the pin so a run log and any refusal name the file an operator has to open. */
export interface PinHit {
  carrier: string;
  pin: BuildPin;
}

/** ONE pin of a GLOB carrier class, with its location already apart: the branch it stands on, the
 *  chart directory it stands in and the stage its file states pins for. The walk holds all three
 *  while it reads, so a reader that groups pins — which version does app X run on installation Y —
 *  takes them from the hit instead of parsing them back out of `carrier`. */
export interface GlobPinHit extends PinHit {
  branch: string;
  chart: string;
  /** null for the tenant catalog's values.yaml, the one pin file that names no stage. */
  stage: Stage | null;
}

/** What ONE glob class's walk produced: every branch it READ, and every pin it found on them.
 *  The branch list travels with the hits, and is the same listing the walk itself used: "this branch
 *  pins nothing" and "there is no such branch" are different answers, the hits alone cannot tell them
 *  apart, and a second listing taken to tell them apart could disagree with the first. */
export interface GlobSearch {
  branches: string[];
  hits: GlobPinHit[];
}

/** The per-stage values file of a chart directory — where a unit's own pins and the platform pins
 *  stand. A pin outside the files named here is invisible to both the bump and the floor. */
export function stagePinFile(stage: Stage): string {
  return `values-${stage}.yaml`;
}

/** One pin FILE a glob carrier class reads, and the stage that file states pins for. The stage
 *  travels WITH the file name rather than being recovered from it afterwards: the reader that groups
 *  pins per installation needs to know which stage a pin is deployed at, and a second parser of the
 *  `values-<stage>.yaml` convention is a second place the convention can be got wrong. */
export interface PinFile {
  file: string;
  /** null where the file states no stage — the tenant catalog's values.yaml, the product default a
   *  fresh installation renders whatever stage it is at. */
  stage: Stage | null;
}

/** The per-stage values file of a chart directory as a PinFile — what class (c) reads. */
export function stagePinFiles(): PinFile[] {
  return STAGE.map((stage) => ({ file: stagePinFile(stage), stage }));
}

/** A tenant catalog chart pins in TWO files, and both are live.
 *
 *  `values.yaml` is the product default on the trunk: the version an installation renders until it
 *  has built one of its own, byte-identical for every installation. `pins-<stage>.yaml` stands on
 *  ONE installation's books branch and says what that installation actually runs — it cannot live on
 *  the trunk, or one installation's build would decide another's version.
 *
 *  Both are floor: the default is what a fresh installation deploys, the per-stage file what a
 *  running one does, and retention may delete neither. */
export function catalogPinFiles(): PinFile[] {
  return [{ file: "values.yaml", stage: null }, ...STAGE.map((stage) => ({ file: `pins-${stage}.yaml`, stage }))];
}

/**
 * The `builds[]` pins of one values file. A file that states no `builds` key yields [] — most
 * values files pin nothing and that is not an error. Everything else fails LOUD: unparseable YAML,
 * a `builds` that is not a list, or an entry that does not match the grammar. `source` names the
 * file (repo, branch and path) so the refusal points at the one to fix.
 */
export function parseBuildPins(source: string, text: string): BuildPin[] {
  let doc: unknown;
  try {
    doc = parse(text);
  } catch (e) {
    throw new Error(`${source} is not parseable YAML: ${e instanceof Error ? e.message : String(e)}`);
  }
  const builds = (doc as { builds?: unknown } | null | undefined)?.builds;
  if (builds === undefined || builds === null) return [];
  if (!Array.isArray(builds)) throw new Error(`${source} states a builds key that is not a list — the pin grammar is a list of {name, image, tag}`);
  return builds.map((raw, i) => {
    const parsed = BuildPinSchema.safeParse(raw);
    if (!parsed.success) {
      const why = parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"} ${issue.message}`).join("; ");
      throw new Error(`${source} builds[${i}] does not match the pin grammar {name, image, tag} with a flat image: ${why}`);
    }
    return parsed.data;
  });
}
