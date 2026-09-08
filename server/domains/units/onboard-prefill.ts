// The onboard wizard's PREFILL: the version and the channel read off the consumer's repository
// before any run exists, so the operator confirms a number the repository states instead of typing
// one. package.json's `version` first — the release script of a unit stamps that file — then the
// chart's `appVersion`, then `0.1.0` for a repository that states neither. The channel is `stable`
// for every prefill: the ceiling is the operator's call and the table is on the wizard. Both values
// stay editable there, and the view names where each came from.
//
// THE PAT DOES NOT OUTLIVE THE READ. The reader opens a credential by id, so the PAT is sealed for
// the clone and PURGED in `finally` — hard-deleted, not revoked — because nothing else will ever
// open it: the onboard POST seals its own. A prefill the operator abandons therefore leaves no
// credential row behind. Sealing once and reusing the id on the onboard POST would change the
// onboard contract and leave a sealed PAT behind whenever the wizard is abandoned.
import { z } from "zod";
import { parse as parseYaml } from "yaml";
import { RELEASE_VERSION_RE } from "../../../shared/release.ts";
import type { OnboardPrefillView } from "../../../shared/api-types.ts";
import type { RepoReader } from "../../adapters/git/port.ts";
import type { CredentialStore } from "../../security/store.ts";
import { fingerprintSecret } from "../../security/fingerprint.ts";
import { DEFAULT_BRANCH_HEAD } from "./onboard-check.ts";

/** What the prefill is asked: the repository, the ONE PAT that reads it, and the chart directory
 *  whose Chart.yaml answers where package.json does not — the same default the onboard takes. */
export const OnboardPrefillRequest = z.object({
  repoURL: z.string().regex(/^https:\/\/[^ ]+\.git$/),
  repoPat: z.string().min(1),
  chartPath: z.string().regex(/^[^/].*$/).default("deploy/chart"),
});
export type OnboardPrefillRequest = z.infer<typeof OnboardPrefillRequest>;

/** A version string is offered only when the release grammar takes it (RELEASE_VERSION_RE): a
 *  pre-release suffix or a leading zero is not a version the release script mints from, so it is
 *  passed over rather than handed to the operator as a number the run would refuse. */
function inReleaseGrammar(value: unknown): string | null {
  return typeof value === "string" && RELEASE_VERSION_RE.test(value) ? value : null;
}

/** The `version` of a package.json, or null when the file is absent, does not parse, or states none. */
function packageJsonVersion(text: string | null): string | null {
  if (text === null) return null;
  try {
    return inReleaseGrammar((JSON.parse(text) as { version?: unknown } | null)?.version);
  } catch {
    return null;
  }
}

/** The `appVersion` of a Chart.yaml, under the same grammar. */
function chartAppVersion(text: string | null): string | null {
  if (text === null) return null;
  try {
    return inReleaseGrammar((parseYaml(text) as { appVersion?: unknown } | null)?.appVersion);
  } catch {
    return null;
  }
}

/** Clone the repository at its default-branch head with the PAT sealed for exactly that clone, read
 *  the version, and purge the PAT again whatever happened in between. */
export async function readOnboardPrefill(
  deps: { repo: RepoReader; store: CredentialStore },
  input: OnboardPrefillRequest,
  signal: AbortSignal,
): Promise<OnboardPrefillView> {
  const { repo, store } = deps;
  const plaintext = Buffer.from(input.repoPat, "utf8");
  const fingerprint = fingerprintSecret(plaintext); // before seal() zeroes the buffer
  const ref = await store.seal({ kind: "pat", label: `consumer repo PAT (prefill of ${input.repoURL})`, plaintext, fingerprint });
  try {
    const cloned = await repo.cloneAtRef({ repoURL: input.repoURL, ref: DEFAULT_BRANCH_HEAD, credentialId: ref.id, signal });
    try {
      const fromPackage = packageJsonVersion(await repo.readFile(cloned.workdir, "package.json"));
      if (fromPackage !== null) {
        return { version: fromPackage, versionSource: "package.json version", channel: "stable", channelSource: "default" };
      }
      const chartFile = `${input.chartPath}/Chart.yaml`;
      const fromChart = chartAppVersion(await repo.readFile(cloned.workdir, chartFile));
      if (fromChart !== null) {
        return { version: fromChart, versionSource: `${chartFile} appVersion`, channel: "stable", channelSource: "default" };
      }
      return {
        version: "0.1.0",
        versionSource: `default — neither package.json version nor ${chartFile} appVersion states a version in the release grammar`,
        channel: "stable",
        channelSource: "default",
      };
    } finally {
      await repo.dispose(cloned.workdir);
    }
  } finally {
    await store.purge(ref.id);
  }
}
