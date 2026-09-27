// Release identity. The single home of the release-tag grammar: the registry reaper's retention
// classes and the web wizard read it from here. The build plane carries a copy of RELEASE_TAG_RE —
// `global.releaseTagFilter` in the platform repo's clusters/platform/values-common.yaml, the inner pattern
// without anchors. No test can compare them: the two literals live in two repositories and this one
// cannot see the other. What compares them is the `release.grammar_mirror` boot self-check
// (server/boot/selfchecks.ts), on a running Manager, where both sides are present.
//
// The channel CEILING (alpha->dev, beta->test, stable->prod) is deliberately NOT here: it is read
// from the tag and enforced in the release pipeline, at the point that writes, and nowhere else.

/** Release channels, ordered by maturity (index = maturity rank). */
export const RELEASE_CHANNEL = ["alpha", "beta", "stable"] as const;
export type ReleaseChannel = (typeof RELEASE_CHANNEL)[number];

/**
 * The release-tag grammar: `<major>.<minor>.<patch>-<channel>-<ts14>`, ts14 = UTC yyyyMMddHHmmss.
 * Valid as a git ref AND as an OCI tag. The IMAGE tag the release pipeline pushes appends `-<sha7>`,
 * which is what the retention classifier strips before parsing.
 * The major and the minor reject leading zeros (a lone 0 excepted), so `01.2.3` cannot alias `1.2.3`.
 * The third position is written with three digits, leading zeros included (`0.3.000`, `0.3.001`): the
 * form the owner set for every version line. A number without leading zeros is accepted beside it,
 * because the tags written before that form (`0.1.16`) stand.
 */
export const RELEASE_TAG_RE =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.([0-9]{3}|0|[1-9][0-9]*)-(alpha|beta|stable)-([0-9]{14})$/;

export interface ParsedRelease {
  /** "x.y.z" */
  version: string;
  channel: ReleaseChannel;
  /** "yyyyMMddHHmmss" (UTC), the mint-uniqueness stamp. */
  ts14: string;
}

/** Parse a release tag into its parts, or null when it does not match the grammar. */
export function parseReleaseTag(tag: string): ParsedRelease | null {
  const m = RELEASE_TAG_RE.exec(tag);
  if (!m) return null;
  const [, major, minor, patch, channel, ts14] = m;
  // A successful match guarantees all five groups; this guard only satisfies TS strict indexed
  // access (noUncheckedIndexedAccess) and is unreachable in practice.
  if (major === undefined || minor === undefined || patch === undefined || channel === undefined || ts14 === undefined) {
    return null;
  }
  return { version: `${major}.${minor}.${patch}`, channel: channel as ReleaseChannel, ts14 };
}

/** The version the NEXT release of a repository takes: the highest x.y.z among its release tags,
 *  patch + 1 — whatever channel the tags were cut on, because a version number is used once per
 *  repository (and once per platform line, rules §17). A third position written with three digits
 *  keeps them (`0.3.007` is followed by `0.3.008`). `first` is what a repository with no release
 *  tag starts at. Tags outside the grammar (a `v` prefix, an image tag with its sha7) are not
 *  releases and are passed over. */
export function nextReleaseVersion(tags: readonly string[], first = "0.1.0"): string {
  let best: { v: [number, number, number]; width: number } | null = null;
  for (const tag of tags) {
    const parsed = parseReleaseTag(tag);
    if (!parsed) continue;
    const parts = parsed.version.split(".");
    const v = parts.map(Number) as [number, number, number];
    const b = best?.v;
    if (b === undefined || v[0] > b[0] || (v[0] === b[0] && (v[1] > b[1] || (v[1] === b[1] && v[2] > b[2])))) best = { v, width: parts[2]!.length === 3 ? 3 : 0 };
  }
  return best === null ? first : `${best.v[0]}.${best.v[1]}.${String(best.v[2] + 1).padStart(best.width, "0")}`;
}

/** The bare version half of the grammar — `x.y.z`, the third position as in RELEASE_TAG_RE. What every release surface takes
 *  from the operator: version + channel, never a whole tag. Who turns the pair into a tag differs by
 *  what is being released — see composeReleaseTag. */
export const RELEASE_VERSION_RE = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.([0-9]{3}|0|[1-9][0-9]*)$/;

/** Compose a tag from its parts, stamping `at` as the UTC ts14.
 *
 *  A UNIT release does NOT come through here: its own repo carries the release script, which mints
 *  (or reuses) the tag repo-side, and the manager only reads back what that script minted. Nothing
 *  calls this today — the cluster-release run kind that minted through it was removed. */
export function composeReleaseTag(version: string, channel: ReleaseChannel, at: Date): string {
  const ts14 = at.toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const tag = `${version}-${channel}-${ts14}`;
  if (!RELEASE_TAG_RE.test(tag)) throw new Error(`composed tag does not match the release grammar: "${tag}"`);
  return tag;
}
