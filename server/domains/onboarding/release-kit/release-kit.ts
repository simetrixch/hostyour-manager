// The consumer "release-kit" — the three files onboard commits into a consumer repo and
// offboard/purge removes again: the two release scripts (release/release.ps1 + release/release.sh)
// and the GitHub Actions release workflow (.github/workflows/release.yml). They are the DUMB,
// untrusted release client: an operator runs release.sh / release.ps1 (or dispatches the
// workflow), which mints + pushes the release tag whose deploy ref fires the platform build. This is
// the ONE source of truth for the write side (onboard: which files to commit + their bytes), for the
// stale-file delete the replace derives (everything under the kit's own directory that the current
// asset set no longer carries), and for the remove side (offboard/purge: which paths to git-rm).
//
// The bytes are loaded VERBATIM from ./assets via readFileSync(new URL(..., import.meta.url)), NOT
// inlined as template literals: the scripts contain backticks, $(), and the workflow's ${{ }} GitHub
// expressions — a template literal would need fragile escaping and could silently corrupt them.
// The server runs under tsx (no JS emit) and the Containerfile
// COPYs the whole server/ tree, so import.meta.url resolves to this source dir at run time and the
// assets travel next to it.
import { readFileSync } from "node:fs";

const releasePs1 = readFileSync(new URL("./assets/release.ps1", import.meta.url), "utf8");
const releaseSh = readFileSync(new URL("./assets/release.sh", import.meta.url), "utf8");
const workflowReleaseYml = readFileSync(new URL("./assets/workflow-release.yml", import.meta.url), "utf8");

/** One release-kit file: the CONSUMER-repo-relative target path + its verbatim content. */
export interface ReleaseKitFile {
  path: string;
  content: string;
}

/** The directory the kit owns WHOLLY. Everything under it was written by an onboarding, so a file
 *  there that the current asset set no longer carries is a stale leftover of an older kit and the
 *  replace removes it. The workflow file is different: .github/workflows/ is shared with the
 *  consumer's own workflows, so only the one named kit file is owned there — never the directory. */
export const RELEASE_KIT_DIR = "release";

/** The three files the release-kit places in a consumer repo, at their consumer-repo target paths.
 *  onboard's inject-release-kit REPLACES them: each file is written to exactly this content
 *  whenever the repo's copy differs — the kit is platform-owned tooling, and an onboarding must
 *  leave the repo in the state a fresh one would. */
export const RELEASE_KIT_FILES: readonly ReleaseKitFile[] = [
  { path: `${RELEASE_KIT_DIR}/release.ps1`, content: releasePs1 },
  { path: `${RELEASE_KIT_DIR}/release.sh`, content: releaseSh },
  { path: ".github/workflows/release.yml", content: workflowReleaseYml },
];

/** The three consumer-repo target paths — the write side's file set, derived from RELEASE_KIT_FILES
 *  so the bytes and the paths can never drift. The replace's stale-file delete is derived from the
 *  SAME source: an entry of RELEASE_KIT_DIR that is not one of these paths is removed. */
export const RELEASE_KIT_PATHS: readonly string[] = RELEASE_KIT_FILES.map((f) => f.path);

/** The remove side (offboard/purge git-rm): the kit's whole directory plus every owned file outside
 *  it. git-rm's -r takes stale files of older kits out with the directory, so the remove side and
 *  the replace's delete list agree by construction. */
export const RELEASE_KIT_REMOVE_PATHS: readonly string[] = [
  RELEASE_KIT_DIR,
  ...RELEASE_KIT_PATHS.filter((p) => !p.startsWith(`${RELEASE_KIT_DIR}/`)),
];
