// The onboard wizard's two read views, apart from api-types.ts the way the wizard's routes stand
// apart from api.ts (api-onboard-prefill.ts): what it fills its fields with before any run exists.
import type { Stage } from "./enums.ts";
import type { ReleaseChannel } from "./release.ts";
import type { PackagesReaderView } from "./apps-manifest.ts";
import type { ConsumerSecretSpec } from "./consumer.ts";

/** One key a standing consumer's manifest declares, as its Secrets dialog shows it. Names, sentences,
 *  kinds and dates only; no value is read or shown. */
export interface ConsumerSecretKeyView {
  key: string;
  description?: string;
  /** The kind the Manager mints the key as; absent where the operator supplies the value. */
  kind?: NonNullable<ConsumerSecretSpec["generate"]>;
  /** Why a generated key cannot be minted again by the dialog, where it cannot. */
  mintRefused?: string;
  /** The other half of a keypair: the two are minted together or not at all. */
  pairWith?: string;
  /** What the book of secret writes knows: written by this Manager (`set`, at `writtenAt`), never
   *  written since the onboarding (`never`), or `unknown` for a consumer onboarded before the book. */
  state: "set" | "never" | "unknown";
  writtenAt?: number;
}

/** GET /api/consumers/:appId/secrets — what the Secrets dialog of a standing consumer offers: every
 *  key its manifest declares, read as the set-secrets plan reads it. */
export interface ConsumerSecretOfferView {
  keys: ConsumerSecretKeyView[];
}

/** A credential of an owner the wizard asks for where the measurement demands it: recorded
 *  (fingerprint and date) or not. */
export interface OwnerCredentialView {
  owner: string;
  recorded: { fingerprint: string; recordedAt: string } | null;
}

/** GET /api/consumers/channels — the channel table the onboard wizard reads: WHICH stages a release
 *  channel may reach. Served LITERALLY from the platform repo's clusters/platform/values-common.yaml
 *  (global.channelStages) — the ONE table, enforced in the release pipeline at the point that
 *  writes; the manager keeps no copy. Keys are the channels the file states (normally all
 *  three), each value the stages that channel admits, in the file's own order. */
export interface ChannelStagesView {
  channelStages: Partial<Record<ReleaseChannel, Stage[]>>;
}

/** POST /api/consumers/prefill — the release the onboarding will put on the stage, as the wizard shows
 *  it before the operator plans: the one another stage of the unit runs, put on the new stage as it
 *  stands, else the next number after the repository's release tags on stable. Each value names its
 *  SOURCE in a sentence the wizard prints as the field's hint. Neither is typed by the operator. */
export interface OnboardPrefillView {
  /** The version the onboarding will release — null while no identity reads the repository (#238). */
  version: string | null;
  versionSource: string;
  channel: ReleaseChannel;
  channelSource: string;
  /** The identity the onboarding will run with: the PAT the wizard was given, else the platform's
   *  GitHub App where its installation reaches the repository (measured, no PAT asked). */
  identity: "github-app" | "pat" | "none"; // the App, the owner's repository PAT (#220), or none yet (#238)
  /** Present where the App does not reach the repository: the owner whose repository PAT the
   *  onboarding runs with, and whether one is recorded. The wizard asks for the token while
   *  `recorded` is null — once per owner (#238). */
  repositoryPat?: OwnerCredentialView;
  /** Present where the repository's `.npmrc` routes scopes to GitHub Packages: whose packages
   *  reader the build installs them with, and whether one is recorded. The wizard asks for the
   *  token while `recorded` is null — once per owner (#237). */
  packagesReader?: PackagesReaderView;
}
