// The onboard wizard's PREFILL: the release the onboarding will put on the stage, read before any run
// exists, so the operator sees it and types none: the one another stage of the unit runs, put on the
// new stage as it stands, else the next number after the repository's release tags
// (release-version.ts). Every release is stable.
//
// THE TOKEN DOES NOT OUTLIVE THE READ: it rides the tag listing as the Bearer header and nothing
// else — no clone, no credential row, nothing an abandoned wizard leaves behind. Which token: the
// owner's identity for this repository (repo-identity.ts, #220) — the App's where its
// installation reaches the repository, the owner's repository PAT else — the same choice
// the onboard POST makes, so the check answers for the identity the onboarding will run with, and
// refuses by name where the owner records no packages reader.
import { z } from "zod";
import type { OnboardPrefillView } from "../../../shared/api-types-onboard.ts";
import type { CredentialStore } from "../../security/store.ts";
import { resolveNextVersion, type ReleaseVersionDeps } from "#unit/server/release-version.ts";
import { onboardRelease } from "./standing-release.ts";
import { judgeRepoIdentity, npmrcPackageScopes, resolveRepoIdentity, type OwnerIdentityReader, type RepoIdentityApp } from "#unit/server/repo-identity.ts";
import { parseGitHubOwnerRepo } from "#unit/server/github-repo-url.ts";
import type { Registrations } from "#unit/server/registrations.ts";

/** What the prefill is asked: the repository. */
export const OnboardPrefillRequest = z.object({
  repoURL: z.string().regex(/^https:\/\/[^ ]+\.git$/),
});
export type OnboardPrefillRequest = z.infer<typeof OnboardPrefillRequest>;

export async function readOnboardPrefill(deps: ReleaseVersionDeps & { githubApp?: RepoIdentityApp; owners: OwnerIdentityReader; store: Pick<CredentialStore, "open" | "list">; registrations: Pick<Registrations, "readUnitStages"> }, input: OnboardPrefillRequest, signal: AbortSignal): Promise<OnboardPrefillView> {
  const { owner, repo } = parseGitHubOwnerRepo(input.repoURL);
  // THE REPOSITORY PAT IS ASKED FOR WHERE THE APP DOES NOT REACH (#238): no identity reads the
  // repository yet, so nothing is read — the wizard shows the step and reads again once recorded.
  const judged = await judgeRepoIdentity({ repoURL: input.repoURL, githubApp: deps.githubApp, owners: deps.owners, signal });
  if ("refused" in judged) {
    return { version: null, versionSource: judged.refused, channel: "stable", channelSource: "every release is stable", identity: "none", repositoryPat: { owner: judged.owner, recorded: null } };
  }
  const identity = await resolveRepoIdentity({ repoURL: input.repoURL, githubApp: deps.githubApp, owners: deps.owners, store: deps.store, signal });
  // The release the onboarding will put on the stage, as it reads it.
  // Only a stage the unit stands at runs a release; the unit is named as its repository is (G1).
  const read = await onboardRelease(deps.github, { owner, repo, token: identity.token, signal }, await deps.registrations.readUnitStages(repo), () => resolveNextVersion(deps, { repoURL: input.repoURL, token: identity.token, signal }));
  const release = read.existing
    ? { version: read.version, versionSource: `the release ${read.standing.from} runs, ${read.standing.tag}, put on the new stage as it stands: nothing is built`, channel: read.channel, channelSource: `the release ${read.standing.from} runs` }
    : { version: read.version, versionSource: `the next number after the release tags of ${read.next.readFrom.join(", ")}`, channel: read.channel, channelSource: "every release is stable" };
  // THE PACKAGES READER IS ASKED FOR WHERE IT IS NEEDED (#237): the repository's `.npmrc`, read
  // through the API with the same identity, says which scopes its build installs from GitHub
  // Packages; the owner's recorded reader says whether the wizard has to ask.
  const scopes = npmrcPackageScopes(await deps.github.readFile({ owner, repo, path: ".npmrc", token: identity.token, signal }));
  const readerId = deps.owners(owner)?.packagesCredentialId ?? null;
  const row = readerId ? (await deps.store.list({ subject: { kind: "owner", id: owner }, purpose: "packages-reader" })).find((r) => r.id === readerId) : undefined;
  return {
    ...release,
    identity: identity.kind,
    ...(scopes.length > 0 ? { packagesReader: { owner, scopes, recorded: row ? { fingerprint: row.fingerprint, recordedAt: row.recordedAt } : null } } : {}),
  };
}
