// How the Releases panel WORDS an installation whose app versions cannot be listed. A pure module
// beside tailnetState.ts / passwordLoginState.ts, for the same reason those are: vitest runs with
// environment "node" and includes no .tsx, so wording left inside a page cannot be tested, and
// wording is the whole substance here.
//
// ONE rule governs every line. A VERSION appears only where an install branch pins one — there is
// nothing to fall back to, and the reason nothing could be read is the complete answer. Anything
// else printed in that slot would be a version somebody guessed, which is the one thing this
// surface must never show.
import type { ReleasesView } from "../../shared/api-types.ts";

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
