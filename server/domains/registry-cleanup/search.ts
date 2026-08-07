// THE search over the image pins of the platform — the same one the release bump performs when it
// asks "who pins the image I just built?", run here to answer the reaper's opposite question: "which
// tags does anything still pin?". One search, two readers, so a tag the bump would write can never be
// a tag the reaper thinks nobody references.
//
// The search space is three carrier classes, over EVERY stage:
//
//   (a) the deployable units. Their registrations stand on this installation's books branch in
//       hostyour-cloud (shared/branches.ts) as registrations/<unit>/<stage>.yaml; each one that carries a chartPath points at the unit's OWN
//       repo, where the chart's pins live on the delivery branch deploy/<stage> at
//       <chartPath>/values-<stage>.yaml. Suspended and quiesced units are read like any other: a
//       suspended unit is resumable and its image stays live. A build.yaml registration contributes
//       nothing here — it has no chartPath, and its images are pinned by whoever deploys them, in (b)
//       or (c).
//   (b) the tenant catalog: catalog, charts/* on EVERY branch, in the two files a catalog
//       chart pins in — values.yaml on the trunk (the product default a fresh installation renders)
//       and pins-<stage>.yaml on an installation's books branch (what that installation actually
//       runs). Both are floor: a tag either of them names is deployed somewhere and must not be
//       deleted.
//   (c) the platform apps: hostyour-cloud, apps/*/values-<stage>.yaml, on EVERY branch — master AND the
//       install branches. An install branch stands on the release a cluster actually runs, which can
//       be OLDER than master, so reading master alone would leave the tags of running clusters
//       unprotected.
//
// FAIL-CLOSED throughout. A carrier that cannot be read aborts the whole search: an incomplete result
// is indistinguishable from "nothing pins this", and acting on that difference is what deletes a live
// image. Class (a) is the strict case — a stage registration whose delivery branch or pin file is
// missing aborts, because the unit demonstrably deploys and the search cannot say from what. Classes
// (b) and (c) glob over directories, so a chart that carries no file for a stage is simply not a
// carrier at that stage.
import { ConsumerRegistrationSchema } from "../../../shared/consumer.ts";
import { STAGE, type Stage } from "../../../shared/enums.ts";
import { parseBuildPins, stagePinFile, catalogPinFiles, type BuildPin } from "../../../shared/pin.ts";
import { parse as parseYaml } from "yaml";
import type { BranchScope, RepoReader } from "../../adapters/git/port.ts";

/** A GitOps repo the search reads across ALL of its branches (hostyour-cloud, catalog). Narrower
 *  than the adapters it is composed from: the search only ever reads, and the adapters it is composed
 *  from are built with branch creation OFF (jobs/registry-reaper.ts) so that stays true of the
 *  concrete instances too — a floor built over a branch the reaper minted itself would be empty, and
 *  an empty floor calls every live image unreferenced. */
export interface CarrierRepo {
  /** The branch this installation's books stand on in this repo (adapters/git/port.ts). The
   *  registration index of class (a) is read there and nowhere else. */
  readonly booksBranch: string;
  /** Every branch of the repo. A truncated enumeration must THROW, not return a short list — a
   *  branch missed here is a pin missed, which is a live tag left unprotected. */
  listBranches(): Promise<readonly { name: string }[]>;
  /** One exclusive turn on a branch's worktree, exactly as PlatformRepo.withBranch gives it: the
   *  reaper walks every registration, and a walk that a concurrent write can slide through would
   *  build its protected-tag floor out of two different states of the books. */
  withBranch<T>(branch: string, fn: (scope: BranchScope) => Promise<T>): Promise<T>;
}

export interface SearchDeps {
  /** hostyour-cloud: the registrations on the books branch (class a's index) and apps/* on every
   *  branch (class c). */
  cloud: CarrierRepo;
  /** catalog: charts/* on every branch (class b). */
  deploy: CarrierRepo;
  /** A unit's OWN repo, opened per unit under that unit's own read credential (class a). */
  unit: Pick<RepoReader, "cloneAtRef" | "readFile" | "dispose">;
}

/** ONE pin found, with WHERE it stands — "<repo>@<branch>:<path>". The location travels with the pin
 *  so the run log and any refusal name the file an operator has to open. */
export interface PinHit {
  carrier: string;
  pin: BuildPin;
}

/** The directory of hostyour-cloud that holds one registration per unit. */
const REGISTRATIONS_DIR = "registrations";
/** The chart directories of the two glob classes. */
const DEPLOY_CHARTS_DIR = "charts";
const CLOUD_APPS_DIR = "apps";

/** The delivery branch a unit's chart pins stand on for one stage. */
function deliveryBranch(stage: Stage): string {
  return `deploy/${stage}`;
}

const at = (repo: string, branch: string, path: string): string => `${repo}@${branch}:${path}`;

/**
 * Run the search. Returns EVERY pin of EVERY carrier, each with its location. Throws on any
 * unreadable carrier — the caller gets a complete answer or none.
 */
export async function searchCarriers(deps: SearchDeps, signal?: AbortSignal): Promise<PinHit[]> {
  return [
    ...(await searchUnitCharts(deps, signal)),
    ...(await searchGlob(deps.deploy, "catalog", DEPLOY_CHARTS_DIR, catalogPinFiles())),
    ...(await searchGlob(deps.cloud, "hostyour-cloud", CLOUD_APPS_DIR, STAGE.map(stagePinFile))),
  ];
}

/** Class (a): every stage registration with a chartPath, read out of its unit's own delivery branch. */
async function searchUnitCharts(deps: SearchDeps, signal?: AbortSignal): Promise<PinHit[]> {
  return deps.cloud.withBranch(deps.cloud.booksBranch, async (books) => {
  const hits: PinHit[] = [];
  for (const unit of await books.listDir(REGISTRATIONS_DIR)) {
    for (const stage of STAGE) {
      const path = `${REGISTRATIONS_DIR}/${unit}/${stage}.yaml`;
      const raw = await books.readFile(path);
      if (raw === null) continue; // the unit is not deployed at this stage
      // A registration is flat `key: <json>`, which a real YAML parser reads as-is; the schema then
      // decides whether this is the stage form. An unparseable or invalid one THROWS — the unit is
      // registered, so its pins are not optional to know.
      const entry = ConsumerRegistrationSchema.parse(parseYaml(raw));
      if (entry.chartPath === undefined) continue; // build-only: its images are pinned in (b) or (c)
      hits.push(...(await readUnitChart(deps, entry.name, entry.repoURL, entry.repoCredentialId, entry.chartPath, stage, signal)));
    }
  }
  return hits;
  });
}

/** Read ONE unit's pin file off its delivery branch. Both the branch and the file are required: the
 *  registration states this unit deploys at this stage, so a missing carrier is a broken unit, not an
 *  empty one, and continuing would drop its tags out of the floor without a word. */
async function readUnitChart(
  deps: SearchDeps,
  name: string,
  repoURL: string,
  credentialId: string | undefined,
  chartPath: string,
  stage: Stage,
  signal?: AbortSignal,
): Promise<PinHit[]> {
  const branch = deliveryBranch(stage);
  const path = `${chartPath}/${stagePinFile(stage)}`;
  let workdir: string | null = null;
  try {
    ({ workdir } = await deps.unit.cloneAtRef({
      repoURL,
      ref: branch,
      ...(credentialId ? { credentialId } : {}),
      ...(signal ? { signal } : {}),
    }));
  } catch (e) {
    throw new Error(
      `unit "${name}" is registered at ${stage} but its delivery branch ${branch} of ${repoURL} could not be read (${e instanceof Error ? e.message : String(e)}) — refusing to prune with a floor that cannot see this unit's images`,
    );
  }
  try {
    const text = await deps.unit.readFile(workdir, path);
    if (text === null) {
      throw new Error(
        `unit "${name}" is registered at ${stage} but ${at(repoURL, branch, path)} does not exist — that file is where its image pins stand, so the floor cannot see them`,
      );
    }
    return parseBuildPins(at(repoURL, branch, path), text).map((pin) => ({ carrier: at(repoURL, branch, path), pin }));
  } finally {
    await deps.unit.dispose(workdir);
  }
}

/** Classes (b) and (c): the pin files of every immediate child of `dir`, on every branch
 *  of one GitOps repo, in the pin files that class names. A chart without one of them is not a
 *  carrier through it — unlike class (a), nothing claimed it was. */
async function searchGlob(repo: CarrierRepo, label: string, dir: string, files: string[]): Promise<PinHit[]> {
  const hits: PinHit[] = [];
  for (const branch of await repo.listBranches()) {
    await repo.withBranch(branch.name, async (scope) => {
      for (const chart of await scope.listDir(dir)) {
        for (const file of files) {
          const path = `${dir}/${chart}/${file}`;
          const text = await scope.readFile(path);
          if (text === null) continue;
          const carrier = at(label, branch.name, path);
          hits.push(...parseBuildPins(carrier, text).map((pin) => ({ carrier, pin })));
        }
      }
    });
  }
  return hits;
}
