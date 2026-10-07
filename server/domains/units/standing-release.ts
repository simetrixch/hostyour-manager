import { parseReleaseTag, type ReleaseChannel } from "../../../shared/release.ts";
import { STAGE, type Stage } from "../../../shared/enums.ts";
import type { BranchCommit, GitHubConsumer } from "#unit/server/adapters/github-consumer/port.ts";

// WHAT A STAGE RUNS IS READ, NEVER STORED: the head of `deploy/<stage>` is the release commit or the
// pin commit on top of it, and the release tag that names that commit is the release that runs.

type RepositoryRead = { owner: string; repo: string; token: string; signal?: AbortSignal };
type ReleaseReads = Pick<GitHubConsumer, "listReleaseTags" | "readBranchCommit">;

/** The stages a new stage of an app takes its release from, the most production-near first. */
const SOURCE_STAGES: readonly Stage[] = [...STAGE].reverse();

/** The repository's releases, newest first. */
export async function listReleases(github: ReleaseReads, read: RepositoryRead): Promise<{ tag: string; commit: string }[]> {
  return (await github.listReleaseTags(read))
    .filter((t) => parseReleaseTag(t.name) !== null)
    .map((t) => ({ tag: t.name, commit: t.commit }))
    .sort((a, b) => parseReleaseTag(b.tag)!.ts14.localeCompare(parseReleaseTag(a.tag)!.ts14));
}

/** The release a delivery branch head carries: the release tag naming the head itself, or naming the
 *  commit the pin commit was made on top of. */
function releaseAt(head: BranchCommit | null, releases: readonly { tag: string; commit: string }[]): string | null {
  if (!head) return null;
  return releases.find((r) => r.commit === head.sha)?.tag ?? releases.find((r) => head.parents.includes(r.commit))?.tag ?? null;
}

/** The release `stage` runs now, among `releases`, or null where it runs none. */
export async function runningRelease(github: ReleaseReads, read: RepositoryRead, stage: string, releases: readonly { tag: string; commit: string }[]): Promise<string | null> {
  return releaseAt(await github.readBranchCommit({ ...read, branch: `deploy/${stage}` }), releases);
}

/** The release a new stage of the app is put on without a new build: the one the most
 *  production-near of the `registered` stages runs. A stage counts only where the unit's registration
 *  stands at it: an offboarded stage leaves its delivery branch behind until its next onboarding
 *  deletes it, and that branch runs nothing. Null for an app no registered stage of which runs a
 *  release: its first onboarding mints one. */
export async function standingRelease(github: ReleaseReads, read: RepositoryRead, registered: readonly Stage[]): Promise<{ tag: string; version: string; channel: ReleaseChannel; from: Stage } | null> {
  // The tags are listed only once a delivery branch stands: a first onboarding reads none.
  let releases: { tag: string; commit: string }[] | undefined;
  for (const from of SOURCE_STAGES.filter((stage) => registered.includes(stage))) {
    const head = await github.readBranchCommit({ ...read, branch: `deploy/${from}` });
    if (!head) continue;
    releases ??= await listReleases(github, read);
    const tag = releaseAt(head, releases);
    if (tag !== null) {
      const { version, channel } = parseReleaseTag(tag)!;
      return { tag, version, channel, from };
    }
  }
  return null;
}

/** The release an onboarding puts on its stage: the standing one, put on the stage as it stands,
 *  else the next version, which `nextVersion` reads, on stable. Every release is stable. */
export async function onboardRelease<N extends { version: string }>(github: ReleaseReads, read: RepositoryRead, registered: readonly Stage[], nextVersion: () => Promise<N>): Promise<{ version: string; channel: ReleaseChannel; existing: true; standing: { tag: string; from: Stage } } | { version: string; channel: "stable"; existing: false; next: N }> {
  const standing = await standingRelease(github, read, registered);
  if (standing) return { version: standing.version, channel: standing.channel, existing: true, standing: { tag: standing.tag, from: standing.from } };
  const next = await nextVersion();
  return { version: next.version, channel: "stable", existing: false, next };
}
