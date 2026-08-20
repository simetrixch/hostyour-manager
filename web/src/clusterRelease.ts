// How "which platform release does this cluster stand on" is WORDED — on a server's card and in the
// Releases panel. A pure module beside tailnetState.ts / passwordLoginState.ts, for the same reason
// those are: vitest runs with environment "node" and includes no .tsx, so wording left inside a page
// cannot be tested, and wording is the whole substance here.
//
// ONE rule governs every line. A VERSION appears only where a cluster map states one. The map's
// `release` key is the sole statement of a cluster's release — the install branch is regenerated from
// exactly that tag — so there is nothing to fall back to, and "unknown" plus the reason is the
// complete answer. Anything else printed in that slot would be a version somebody guessed, which is
// the one thing this surface must never show.
import type { ClusterReleaseRead, ReleasesView } from "../../shared/api-types.ts";

export interface ReleaseChip {
  /** The chip text, self-describing beside the role and reading chips it sits with. */
  label: string;
  /** The chip's class list — neutral or warn, both already in the design system. */
  className: string;
  /** One sentence: what stands in the map, or why nothing does. */
  detail: string;
}

/** The one place a release becomes words, or null where there is no release question to answer: a
 *  machine that carries no cluster row is not a cluster, has never stood on a release, and gets no
 *  chip at all — a warn pill on every freshly added server would be noise, and the state it would be
 *  warning about is the normal one. */
export function releaseChip(release: ClusterReleaseRead): ReleaseChip | null {
  switch (release.kind) {
    case "no-cluster":
      return null;
    case "pinned":
      // Neutral, not green: a pin is a declaration, not a verdict on it. The tag is printed whole
      // because it IS the identity — the version, the channel and the mint stamp are one string, and
      // a shortened form would name a state nothing can be regenerated from.
      return {
        label: `release: ${release.tag}`,
        className: "chip",
        detail: `The cluster map pins ${release.tag} — what the last release run wrote. set-pin runs before the branch is regenerated, so a run that stopped between the two leaves this ahead of the cluster.`,
      };
    case "unknown":
      return {
        label: "release: unknown",
        className: "chip chip--warn",
        detail: `Nothing states which platform release this cluster stands on — ${release.reason}. A release run is what writes that statement.`,
      };
  }
}

/** WHY an installation shows no app versions at all (`apps: null`). THREE different causes and the
 *  surface may not word them alike: the platform repo is unconfigured so nothing was read, the pin
 *  search itself could not run so nothing is known anywhere, or the repository carries no branch of
 *  that name so this one installation had nothing to read. Only the last is about this installation,
 *  and none of the three is "it pins nothing" — that is the sentence below, and it is the answer to a
 *  branch that WAS read. */
export function appsUnavailable(envelope: Pick<ReleasesView, "error" | "reason">, branch: string): string {
  if (envelope.reason === "onboarding-not-configured") {
    return "The platform repo is not configured, so no pin file was read for any installation and no app version here is known.";
  }
  if (envelope.error !== undefined) {
    return `The pin search could not run, so no app version is known for any installation: ${envelope.error}`;
  }
  return `The repository carries no branch ${branch}, so this installation has no pin file to read — which is not the same as an installation that pins nothing.`;
}

/** The branch WAS read and states no image at all. Its own sentence for the reason above. */
export function appsEmpty(branch: string): string {
  return `The branch ${branch} was read and pins no platform app image.`;
}
