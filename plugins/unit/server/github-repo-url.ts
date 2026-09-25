// The GitHub owner and repository a unit's repository URL names. One parse, because the build
// webhook, the release dispatch, the owner identity and the version read all address the repository
// through it.
import { errValidation } from "#core/server/kernel/errors.ts";

/** Non-throwing split of a repoURL (https://github.com/<owner>/<repo>.git) into its GitHub ORG owner +
 *  repo (the URL path), NEVER the unit's human or team owner. Returns null on any URL that is not a
 *  github.com/<owner>/<repo>.git — a webhook target is meaningless without both. */
export function splitGitHubRepoURL(repoURL: string): { owner: string; repo: string } | null {
  let u: URL;
  try {
    u = new URL(repoURL);
  } catch {
    return null;
  }
  const segments = u.pathname.replace(/^\/+/, "").replace(/\.git$/, "").split("/");
  if (u.hostname !== "github.com" || segments.length !== 2 || !segments[0] || !segments[1]) return null;
  return { owner: segments[0], repo: segments[1] };
}

/** The fail-loud variant: a repoURL that names no GitHub repository is a hard error, because nothing
 *  can set up a hook on, release from or read the owner of a repository without a real owner/repo. */
export function parseGitHubOwnerRepo(repoURL: string): { owner: string; repo: string } {
  const parsed = splitGitHubRepoURL(repoURL);
  if (!parsed) throw errValidation(`cannot derive the GitHub owner/repo from "${repoURL}" — expected https://github.com/<owner>/<repo>.git`);
  return parsed;
}
