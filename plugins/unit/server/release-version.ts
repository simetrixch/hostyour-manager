// The version an onboarding RELEASES is read here and nowhere else: the next number after the
// repository's release tags (shared/release.ts nextReleaseVersion). Nobody types it. Before this the
// wizard prefilled the number a repository STATED (its package.json, which the release script stamps
// from the last tag) and the operator sent it back — the last release, not the next — and the kit,
// which never re-points a tag, then deployed that old tag's tree while the gates had validated HEAD
// (hostyour-manager#139).
//
// THE PLATFORM'S OWN LINE. Rules §17: every repository of the platform stands on ONE sequence, the
// highest third number used anywhere is read before a release is cut. So a unit from the platform's
// own GitHub owner reads its next number over the whole line — its own repository, the
// platform repository and the engine's (clusters/platform/versions.yaml names it) — and a customer's
// unit reads its own tags only.
import type { GitHubConsumer } from "#core/server/adapters/github-consumer/port.ts";
import type { PlatformRepo } from "#core/server/adapters/git/port.ts";
import { nextReleaseVersion } from "#core/shared/release.ts";
import { readAnsiwiseUpstreamProject } from "#core/server/domains/inventory/ansiwise-pin.ts";
import { parseGitHubOwnerRepo } from "./github-repo-url.ts";

export interface ReleaseVersionDeps {
  github: GitHubConsumer;
  /** The platform repository on GitHub — the owner that decides who stands on the platform's
   *  line. Absent when the platform repo is not configured: every unit then reads its own tags only. */
  platformGitHub?: { owner: string; repo: string };
  /** The platform repo reader, for the engine's repository named in versions.yaml. */
  platformRepo?: PlatformRepo;
}

export interface ResolvedReleaseVersion {
  version: string;
  /** The repositories whose release tags the number was read over, "owner/repo" each. */
  readFrom: string[];
}

export async function resolveNextVersion(
  deps: ReleaseVersionDeps,
  input: { repoURL: string; token: string; signal?: AbortSignal },
): Promise<ResolvedReleaseVersion> {
  const unit = parseGitHubOwnerRepo(input.repoURL);
  const repos = new Map<string, { owner: string; repo: string }>();
  const add = (r: { owner: string; repo: string }): void => {
    repos.set(`${r.owner}/${r.repo}`.toLowerCase(), r);
  };
  add(unit);
  if (deps.platformGitHub && unit.owner.toLowerCase() === deps.platformGitHub.owner.toLowerCase()) {
    add(deps.platformGitHub);
    const engine = deps.platformRepo ? await readAnsiwiseUpstreamProject(deps.platformRepo) : null;
    if (engine) add(parseGitHubOwnerRepo(`https://github.com/${engine}.git`));
  }
  const tags: string[] = [];
  for (const r of repos.values()) {
    tags.push(...(await deps.github.listReleaseTags({ owner: r.owner, repo: r.repo, token: input.token, ...(input.signal ? { signal: input.signal } : {}) })));
  }
  return { version: nextReleaseVersion(tags), readFrom: [...repos.values()].map((r) => `${r.owner}/${r.repo}`) };
}
