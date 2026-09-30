// A tenant's apps bundle is written against the engine's app contract, and a breaking change of that
// contract starts a new minor line of the engine (0.3, then 0.4). The bundle states the build it runs
// on and its line (apps.yaml `engine`, shared/apps-manifest.ts), and a tenant runs it only beside that
// build on that line. Every plan that pairs a bundle with engines asks this module: the Versions run,
// create-tenant, add-app and tenant-apps-repo. The release pipeline asks the same question in shell
// before it moves a tenant onto a bundle it just built (hostyour-cloud pipeline-release.yaml, class (d)).
//
// A plan answers early, from the bundle the run is going to build. The step that writes a pairing
// (a tenant's versions, or the bundle tag on its registration) judges again before it writes, from the
// bundle release that was built: a build unit of the same run may have moved a pin the plan could not
// judge, and a repository an earlier pass left standing keeps its own apps.yaml.
//
// A move to a new line needs the bundle and the engines to move together, and nothing here does that:
// a pairing across lines is refused, and the refusal says so.
import type { AppsEngine, AppsManifest } from "../../../shared/apps-manifest.ts";
import { parseAppsManifest, APPS_MANIFEST_PATH } from "../../../shared/apps-manifest.ts";
import { approvedImageTag } from "../../../shared/tenant.ts";
import type { RepoReader } from "../../adapters/git/port.ts";
import type { StepCtx } from "../../executor/types.ts";
import { errUpstream, errValidation } from "../../kernel/errors.ts";
import { DEFAULT_BRANCH_HEAD } from "#unit/server/build-chain.ts";

/** The versions a tenant's members run, member -> build -> image tag (tenant.approvedTags). */
type MemberVersions = Readonly<Record<string, Readonly<Record<string, string>>>>;

/** How a plan reads a tenant's own repository: with the reader and the credential it reads the
 *  apps catalog with. Both are the platform's GitHub App, which every tenant repository stands under. */
type RepositoryRead = { repo: Pick<RepoReader, "cloneAtRef" | "readFile" | "dispose">; deployCredentialId?: string | undefined };

type PlanLog = { log: (line: string) => void; signal: AbortSignal };

/** A step's log in the shape the readers here take: every line as meta. */
export const stepLog = (ctx: Pick<StepCtx, "log" | "signal">): PlanLog => ({ log: (line) => ctx.log("meta", line), signal: ctx.signal });

/** The version line of an image tag `<x.y.z>-<channel>-<ts14>-<sha7>`: its first two numbers. */
export function versionLine(tag: string): string {
  return tag.split("-")[0]!.split(".").slice(0, 2).join(".");
}

/** Why members on `versions` cannot run beside a bundle written for `engine`, or null where they can:
 *  every member whose versions hold the engine's build runs it on the bundle's line. A member without
 *  that build pairs with nothing and is passed over, and a bundle that declares no engine is judged by
 *  nobody, which the reader of its engine has logged. */
export function engineLineRefusal(engine: AppsEngine | undefined, versions: MemberVersions): string | null {
  if (engine === undefined) return null;
  const off = Object.entries(versions).flatMap(([member, builds]) => {
    const tag = builds[engine.build];
    return tag !== undefined && versionLine(tag) !== engine.line ? [`${member} would run ${engine.build} ${tag}`] : [];
  });
  if (off.length === 0) return null;
  return `the apps bundle is written for ${engine.build} ${engine.line}, and ${off.join(", ")}, of another line. A bundle and an engine on different lines are refused; moving a tenant to a new line needs its bundle and its engines to move together, which the Manager does not do`;
}

/** Whether `next` holds a version the tenant may not run today: a build moved to another line, or one
 *  `held` has no version of. Only such a version can make a bundle that fitted stop fitting. */
export function movesLine(held: MemberVersions, next: MemberVersions): boolean {
  return Object.entries(next).some(([member, builds]) => Object.entries(builds).some(([build, tag]) => {
    const was = held[member]?.[build];
    return was === undefined || versionLine(was) !== versionLine(tag);
  }));
}

/** Throws a refusal as the plan's answer, naming what was refused. */
export function throwEngineLineRefusal(refusal: string | null, what: string): void {
  if (refusal !== null) throw errValidation(`${what}: ${refusal}`);
}

/** The engine an apps.yaml declares, or undefined where it declares none; null text is a repository
 *  without an apps.yaml. A declaration that is not readable throws, naming the file. */
export function declaredEngine(appsYaml: string | null): AppsEngine | undefined {
  return appsYaml === null ? undefined : parseAppsManifest(appsYaml).engine;
}

/** What a plan logs where a bundle's fit is judged by nobody, so it is never read as a fit that passed. */
export const ENGINE_NOT_CHECKED = `the apps bundle's ${APPS_MANIFEST_PATH} declares no engine, so whether it fits the engine is not checked`;

/** The apps.yaml of a tenant's own repository at `ref`, or null where it carries none. A repository
 *  that cannot be read fails naming it and `purpose`, which the reader's own error does not say. */
async function repositoryAppsYaml(ports: RepositoryRead, source: { repoURL: string; ref: string }, purpose: string, signal?: AbortSignal): Promise<string | null> {
  let cloned: { workdir: string };
  try {
    cloned = await ports.repo.cloneAtRef({ ...source, ...(ports.deployCredentialId ? { credentialId: ports.deployCredentialId } : {}), ...(signal ? { signal } : {}) });
  } catch (err) {
    throw errUpstream(`${source.repoURL} could not be read at ${source.ref}, so ${purpose}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
  try {
    return await ports.repo.readFile(cloned.workdir, APPS_MANIFEST_PATH);
  } finally {
    await ports.repo.dispose(cloned.workdir);
  }
}

/** The engine of a tenant's own repository at `ref`, logging where it declares none. */
export async function repositoryEngine(ports: RepositoryRead, source: { repoURL: string; ref: string }, ctx: PlanLog): Promise<AppsEngine | undefined> {
  const engine = declaredEngine(await repositoryAppsYaml(ports, source, "the engine the apps bundle there is written for cannot be judged", ctx.signal));
  if (engine === undefined) ctx.log(`${source.repoURL} at ${source.ref}: ${ENGINE_NOT_CHECKED}`);
  return engine;
}

/** The apps manifest of a tenant's own bundle at the release its image tag was built from: what the
 *  tenant runs, which may name apps and sites the template never offered. Null where the tenant runs
 *  no bundle. THROWS where its tag is no image tag, or its repository or manifest cannot be read. */
export async function tenantBundleManifest(ports: RepositoryRead, bundle: { appsRepo?: string | undefined; appsImageTag?: string | undefined }, signal?: AbortSignal): Promise<AppsManifest | null> {
  if (!bundle.appsRepo || !bundle.appsImageTag) return null;
  if (!approvedImageTag.safeParse(bundle.appsImageTag).success) {
    throw errValidation(`the apps bundle stands at "${bundle.appsImageTag}", which is no image tag <x.y.z>-<channel>-<ts14>-<sha7>, so the release it was built from cannot be read`);
  }
  const ref = bundleReleaseTag(bundle.appsImageTag);
  const text = await repositoryAppsYaml(ports, { repoURL: bundle.appsRepo, ref }, "the apps the tenant runs cannot be read", signal);
  if (text === null) throw errValidation(`${bundle.appsRepo} carries no ${APPS_MANIFEST_PATH} at ${ref}, so the apps the tenant runs cannot be read`);
  return parseAppsManifest(text);
}

/** The engine of the bundle a run builds: the tenant's own repository at its head where one stands,
 *  and the catalog's where none does. */
export async function builtBundleEngine(ports: RepositoryRead, standingRepoURL: string | undefined, catalog: AppsEngine | undefined, ctx: PlanLog): Promise<AppsEngine | undefined> {
  if (standingRepoURL !== undefined) return repositoryEngine(ports, { repoURL: standingRepoURL, ref: DEFAULT_BRANCH_HEAD }, ctx);
  if (catalog === undefined) ctx.log(ENGINE_NOT_CHECKED);
  return catalog;
}

/** Why members on `next` cannot run beside a bundle release, or null. The bundle is read off the tenant's
 *  own repository at the release its image tag was built from, and only where `next` holds a version
 *  `held` does not (movesLine): within the lines a tenant runs its pairing stays what it was, so a run
 *  that keeps every line never depends on that repository being readable. */
export async function bundleReleaseRefusal(ports: RepositoryRead, bundle: { appsRepo?: string | undefined; appsImageTag?: string | undefined }, held: MemberVersions, next: MemberVersions, ctx: PlanLog): Promise<string | null> {
  if (!bundle.appsRepo || !bundle.appsImageTag || !movesLine(held, next)) return null;
  if (!approvedImageTag.safeParse(bundle.appsImageTag).success) {
    return `the apps bundle stands at "${bundle.appsImageTag}", which is no image tag <x.y.z>-<channel>-<ts14>-<sha7>, so the release it was built from, and the engine it is written for, cannot be read`;
  }
  return engineLineRefusal(await repositoryEngine(ports, { repoURL: bundle.appsRepo, ref: bundleReleaseTag(bundle.appsImageTag) }, ctx), next);
}

/** The release tag a bundle's image tag was built from: `<release tag>-<sha7>`. */
export function bundleReleaseTag(appsImageTag: string): string {
  return appsImageTag.replace(/-[0-9a-f]{7}$/, "");
}
