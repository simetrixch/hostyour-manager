// THE BUILD-ONLY CHAIN: how a unit is built without being deployed. Its build registration, the repo
// PAT its release pipeline clones with, its build namespace, the release kit in its repository, the
// build webhook, and one triggered release watched through the build plane. Both families run it: the
// onboarding of a build-only unit, and every build unit a tenant's product or its own apps repository
// needs.
//
// The params and the ports here are the part every form of an onboarding shares; the deployable form
// adds its own on top of them in the family that deploys.
import { z } from "zod";
import type { Step } from "#core/server/executor/types.ts";
import { STAGE } from "#core/shared/enums.ts";
import { RELEASE_CHANNEL, RELEASE_VERSION_RE } from "#core/shared/release.ts";
import { GateReportSchema, UngatedOnboardSchema } from "#core/shared/gates.ts";
import type { GitHubConsumer } from "./adapters/github-consumer/port.ts";
import type { BuildPlane } from "#core/server/adapters/build-plane/port.ts";
import type { MasterArgoReader, ClusterReader } from "#core/server/adapters/kube/port.ts";
import type { RepoReader, RepoWriter } from "#core/server/adapters/git/port.ts";
import type { VaultSeeder } from "./adapters/vault/seeder-port.ts";
import type { BuildPlaneFqdnResolver } from "#core/server/domains/inventory/cluster-marking.ts";
import type { ChannelStages } from "#core/server/domains/inventory/channel-stages.ts";
import type { Registrations } from "./registrations.ts";
import { preflightScopesStep } from "./preflight-scopes.ts";
import { writeBuildRegistrationStep, recordBuildOnlyStep } from "./build-registration.ts";
import { seedRepoPatStep } from "./seed-repo-pat.ts";
import { awaitBuildNamespaceStep } from "./await-build-namespace.ts";
import { injectReleaseKitStep } from "./inject-release-kit.ts";
import { setupWebhookStep } from "./build-webhook.ts";
import { triggerReleaseStep, watchReleaseBuildStep, type ReleaseCycleRuntime } from "./release-cycle.ts";

/** The ref cloned before the gates run, and before an ungated build reads its manifest — the
 *  remote's default branch head. A unit is judged by what its repository IS, not a pin: only the
 *  release cycle ever turns a commit into something deployable. */
export const DEFAULT_BRANCH_HEAD = "HEAD";

/** A unit's name: a DNS label of at most 40 characters, because it becomes `<name>-<stage>` and
 *  `<name>-build`. */
export const unitNameSchema = z.string().regex(/^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/);
export const repoURLSchema = z.string().regex(/^https:\/\/[^ ]+\.git$/);

/** The fields BOTH forms of the frozen onboard params share: the operator's identity fields, the
 *  release the trigger fires ({version, channel} — never a tag: the release script mints or reuses
 *  the tag repo-side), and what the streaming plan phase resolved (the checked default-branch head,
 *  the approved report, the attested build names). The steps read this via ctx.params; the
 *  executor's StepCtx exposes params but not plan_json, so the plan phase hands the steps their
 *  inputs here. */
export const BuildParamsBase = z.object({
  consumerName: unitNameSchema,
  repoURL: repoURLSchema,
  // The sealed repo read credential — REQUIRED: the API handler seals the operator's one repo PAT into
  // the store and threads only this reference (the raw PAT never reaches params_json). The clone,
  // the gate-runner sandbox clone, the kit commit, the workflow dispatch AND the build repo-pat seed
  // all open it by this id.
  repoCredentialId: z.string().min(1),
  owner: z.string().min(1),
  // What the trigger dispatches: the release script mints <version>-<channel>-<ts14> (or reuses the
  // existing tag of that version+channel) and pushes the deploy ref for `stage`.
  version: z.string().regex(RELEASE_VERSION_RE),
  channel: z.enum(RELEASE_CHANNEL),
  // The UNIT's own stage, the operator's input for both forms: the registration path
  // registrations/<name>/<stage>.yaml, the namespace <name>-<stage>, the host, the Vault path
  // <stage>/consumer/<name>/… and the deploy ref the triggered release pushes all follow it.
  stage: z.enum(STAGE),
  // deploy (absent) puts the release on `stage` and the pipeline writes the stage's pin; build only
  // builds it for `stage` and writes no pin — a tenant's own version (hostyour-manager#289).
  target: z.enum(["deploy", "build"]).optional(),
  // The default-branch head the gates checked at plan time. Display/audit only — there is no pin:
  // the check step re-runs the gates at the CURRENT head, and the release cycle builds whatever
  // the minted tag points at.
  resolvedSha: z.string().regex(/^[0-9a-f]{40}$/),
  // The cluster this run is ABOUT. Deployable: the target cluster's FQDN — its values-chain branch,
  // and the map whose `build-plane` field names where the build webhook points. Build-only: the
  // master's FQDN, since nothing of the unit deploys and the gates run without a values chain; its map
  // names the build plane the same way. Never the webhook host itself.
  domain: z.string().min(1),
  // The build NAMES the validated manifest declared — what write-registration commits into
  // build.yaml as the build fan-out's source. A name IS the image name, and the tag is the release
  // pipeline's to mint, so neither stands here. Never empty: the gates hard-fail a manifest
  // without builds.
  builds: z.array(z.string()),
});

/** What every build step reads of a run's params, whichever form the run has. */
export type BuildParams = z.infer<typeof BuildParamsBase> & { form: "deployable" | "build-only" };

/** The BUILD-ONLY form: no cluster and no chart, and the only form that can carry `ungated`
 *  instead of a report — the platform's own unit at the first installation in the master role
 *  (the consumer family's first-master.ts states every condition that admits it). */
export const BuildOnlyParams = BuildParamsBase.extend({
  form: z.literal("build-only"),
  // EXACTLY ONE of these two stands here, and the onboarding's union refines that. They are
  // separate fields rather than one field of two shapes because a reader asking "was this gated?"
  // must not have to inspect a value to find out, and because an ungated record is NOT a report and
  // must never be read as one (shared/gates.ts UngatedOnboardSchema).
  report: GateReportSchema.optional(),
  ungated: UngatedOnboardSchema.optional(),
});
export type BuildOnlyParams = z.infer<typeof BuildOnlyParams>;

/** The Manager-side clients the build steps drive (master-local; no SSH): the build namespace, the
 *  build webhook and the release pipeline all stand on the cluster this Manager runs on, whatever
 *  cluster the unit is deployed to. */
export interface BuildPorts {
  repo: RepoReader;
  registrations: Registrations;
  seeder: VaultSeeder;
  argoWatchTimeoutMs: number;
  /** How long the release PipelineRun may take to APPEAR on the build plane after the deploy ref was
   *  pushed (a webhook delivery of seconds); the build itself is followed without a clock. */
  releaseBuildAppearMs: number;
  /** Poll tick of the release watches; overridable for tests. */
  releasePollIntervalMs?: number;
  /** How long the unit's three build Secrets may take to stand again after refresh-repo-pat deleted
   *  them; the release is dispatched only once they do, or the clone would race the materialization.
   *  Defaults to two minutes (ESO materializes an OnChange ExternalSecret whose target is gone within
   *  seconds; two minutes outlasts a controller that is restarting); overridable for tests. */
  buildSecretsMaterializeMs?: number;
  /** The BUILD PLANE's cluster reader — this Manager's own cluster, where every unit's `<name>-build`
   *  namespace stands (refresh-repo-pat deletes the unit's build Secrets there and reads their
   *  ExternalSecrets' return). Injected directly, exactly as buildArgo is and for the same reason: the
   *  build namespace is master-local whatever cluster the unit targets, and a build-only unit has no
   *  clusterId to resolve one from. Optional but UNCONDITIONALLY needed by the release re-run —
   *  absent ⇒ the step fails loud, because a rewrite whose Secrets are not deleted is a release that
   *  clones with the old token. */
  buildClusterReader?: ClusterReader;
  /** The trigger's 404 retry window (a just-committed workflow indexes with a lag); overridable for
   *  tests. Defaults to 60s at 5s ticks. */
  dispatchRetry?: { budgetMs: number; intervalMs: number };
  /** Reads the MASTER's own ArgoCD Applications (await-build-namespace). Injected directly rather
   *  than resolved, and for two reasons that both matter: the per-unit build Application is
   *  master-local whatever cluster the unit targets, and a BUILD-ONLY unit carries no `clusterId`
   *  at all — it has no cluster, so there is nothing to resolve a reader from. Optional but
   *  UNCONDITIONALLY needed by onboard: absent ⇒ the step fails loud, because the alternative is
   *  writing grants into a namespace nobody has confirmed exists. */
  buildArgo?: MasterArgoReader;
  /** The per-call consumer-PAT GitHub client: the PAT scope preflight, the build webhook
   *  (setup-webhook / remove-webhook), the release workflow dispatch (trigger-release) and the
   *  workflow watch. Optional but UNCONDITIONALLY needed by onboard — absent ⇒ those steps fail loud
   *  (no hook → no build; no dispatch → no cycle), never a silent skip. */
  github?: GitHubConsumer;
  /** Watches the unit's release PipelineRun in its own `<name>-build` namespace
   *  (watch-release-build). Optional but UNCONDITIONALLY needed — absent ⇒ the step fails loud. */
  buildPlane?: BuildPlane;
  /** The shared HMAC secret (GITHUB_WEBHOOK_SECRET) the image-builder EventListener validates each
   *  delivery's X-Hub-Signature-256 against. The seeder is write-only, so the manager reads it from
   *  its own config/env; absent ⇒ setup-webhook fails loud (a hook without the matching secret never
   *  triggers a build). */
  webhookSecret?: string;
  /** The image-builder EventListener ingress subdomain (default "build") the hook targets at
   *  build.<build-plane-fqdn>/github; threaded so a non-standard cluster can override it. */
  webhookSubdomain?: string;
  /** WHERE the build webhook points: the FQDN in the map of the cluster this run is about
   *  (`build-plane`, clusters/active/<fqdn>.yaml). The EventListener stands on the build plane alone,
   *  so the host is read from the map instead of being taken from the target cluster. Required — a
   *  consumer without a placeable hook can never build, and both forms of the run go through it. */
  resolveBuildPlaneFqdn: BuildPlaneFqdnResolver;
  /** The CONSUMER's OWN repo writer (inject-release-kit step): commits the release-kit — release/
   *  scripts + .github/workflows/release.yml — into the consumer repo at onboard, and offboard/purge
   *  remove it. Optional but UNCONDITIONALLY needed by onboard — absent ⇒ inject-release-kit fails
   *  loud (no release kit → no release cycle), never a silent skip (setup-webhook precedent). */
  consumerRepo?: RepoWriter;
  /** The channel ceiling — `global.channelStages` read off the platform repo's trunk
   *  (domains/inventory/channel-stages.ts readChannelStages). The plan holds the requested stage
   *  against it for BOTH forms before anything else is read: a stage the channel does not reach is
   *  a release the pipeline refuses to pin, so the refusal belongs at the wizard, not three watches
   *  later. Read per plan, never cached — the table changes without a Manager release. */
  channelStages: () => Promise<ChannelStages>;
}

/** The build-only chain, whoever builds the unit. `release` is the in-run memory the watch fills; a
 *  caller that reads what the release built hands its own in. `check` is the gate re-run a gated
 *  onboarding places after the scope preflight — an ungated build has none, and a step named "check"
 *  that checks nothing would be a green light for a measurement that never happened. */
export function buildOnlySteps(ports: BuildPorts, p: BuildOnlyParams, release: ReleaseCycleRuntime = {}, check?: Step): Step[] {
  return [
    // No attest-target: there is no target cluster whose deploy-state could be attested — the run kind
    // touches git, the local Vault and the build plane's own namespaces, all on the cluster the
    // manager itself runs on.
    preflightScopesStep(ports, p),
    ...(check ? [check] : []),
    writeBuildRegistrationStep(ports, p),
    seedRepoPatStep(ports, p),
    // The build Application carries the two build-namespace grants now (hostyour-cloud#174), so this
    // wait is what puts them there: without them the EventListener cannot create the release
    // PipelineRun and the manager cannot watch it, and the trigger below would fire into nothing. A
    // build-only unit gets nothing else — it has no Applications to sync, no namespace to run a
    // dashboard in and no stage registration to claim a service on.
    awaitBuildNamespaceStep(ports, p),
    injectReleaseKitStep(ports, p),
    setupWebhookStep(ports, p),
    triggerReleaseStep(ports, p),
    watchReleaseBuildStep(ports, p, release),
    recordBuildOnlyStep(ports, p, release),
  ];
}
