import { z } from "zod";
import { MongodbModeSchema } from "../../../shared/unit-size.ts";
import { UnitSizeSchema, DEFAULT_UNIT_SIZE } from "../../../shared/unit-size.ts";
import { eq } from "drizzle-orm";
import type { RunDefinition, Step, Plan } from "../../executor/types.ts";
import type { Db } from "../../db/client.ts";
import { clusters } from "../../db/schema/inventory.ts";
import { STAGE } from "../../../shared/enums.ts";
import { RELEASE_CHANNEL, RELEASE_VERSION_RE } from "../../../shared/release.ts";
import { GateReportSchema, UngatedOnboardSchema } from "../../../shared/gates.ts";
import { ConsumerSecretSpecSchema, ConsumerServiceSchema, ConsumerActivationSchema, consumerArgoAppName } from "../../../shared/consumer.ts";
import type { Activator } from "../../adapters/activation/port.ts";
import type { GitHubConsumer } from "../../adapters/github-consumer/port.ts";
import type { BuildPlane } from "../../adapters/build-plane/port.ts";
import type { DnsProvider } from "../../adapters/dns/port.ts";
import { activateStep } from "./onboard-activate.ts";
import { preflightScopesStep } from "./onboard-preflight-scopes.ts";
import { setupWebhookStep } from "./onboard-webhook.ts";
import { injectReleaseKitStep } from "./onboard-release-kit.ts";
import { awaitBuildNamespaceStep } from "./onboard-await-build-namespace.ts";
import { seedRepoPatStep } from "./onboard-seed-repo-pat.ts";
import { seedPostgresSuperuserStep } from "./onboard-seed-postgres.ts";
import { seedMongodbInstanceStep } from "./onboard-seed-mongodb.ts";
import {
  attestTargetStep, seedSecretsStep, provisionRepoCredentialStep,
  provisionSmtpOpsGrantStep, provisionDnsStep, smokeStep, recordProvisionalStep, recordInventoryStep, removeCeremonySecretsCleanup,
} from "./onboard-steps.ts";
import { deployableOnboardCleanups, buildOnlyOnboardCleanups, assertOnboardAbortable } from "./onboard-abort.ts";
import {
  triggerReleaseStep, watchReleaseWorkflowStep, watchReleaseBuildStep, watchDeploymentStep, type ReleaseCycleRuntime,
} from "./onboard-release-cycle.ts";
import { checkStep, DEFAULT_BRANCH_HEAD } from "./onboard-check.ts";
import { admitFirstMasterUngated, planUngatedFirstMaster } from "./first-master.ts";
import { resolveUnitQuota } from "./unit-size.ts";
import { writeRegistrationStep, writeBuildRegistrationStep, recordBuildOnlyStep } from "./onboard-registration.ts";
import type { BuildRbacWriter, RepoCredentialWriter, MasterArgoReader } from "../../adapters/kube/port.ts";
import { AppError, errNotFound } from "../../kernel/errors.ts";
import { validateOnboard, type OnboardTarget, type TenantSubdomainReader, type ValidationOutcome } from "./validate.ts";
import { unitApexFromChain } from "./admission-policy.ts";
import { clusterShortName, type BuildPlaneFqdnResolver } from "../inventory/cluster-marking.ts";
import { resolveMasterCluster } from "./tenant-values.ts";
import type { Registrations } from "./registrations.ts";
import type { VaultSeeder } from "./vault-seeder.ts";
import type { RepoReader, ConsumerRepo } from "../../adapters/git/port.ts";
import type { GateRunner } from "../../adapters/gate-runner/port.ts";
import type { ClusterKubeResolver } from "../../adapters/kube/port.ts";

// The "consumer-onboard" Run: check → registration → provision → inject → trigger → watch. The run kind
// knows TWO forms of ONE step chain:
//
//  - DEPLOYABLE (the manifest declares a chart): the full chain, ending in the deployment the
//    triggered release cycle produced. The operator names a target cluster.
//  - BUILD-ONLY (the manifest declares no chart): the subset — nothing of the unit deploys, so
//    attest-target, the target-cluster provisioning, provision-dns, watch-deployment and smoke are
//    absent. The operator names the stage the ONE triggered release run puts the release on. The
//    seven platform units go through this form, which is what makes the manager the writer of
//    their registrations instead of a hand commit.
//
// The onboarding TRIGGERS the release cycle instead of pinning a revision: OnboardRequest carries
// {version, channel}, the run injects the kit + the webhook and then starts the cycle ONCE through
// the injected workflow — which is simultaneously the test of the injection. The first deployment
// comes OUT of that external cycle; the manager reads its results (the minted tag, the bump
// commit) and never computes them.
//
// mutating: true ⇒ the attest-target law (guards.assertGuardsArmed) requires steps({})[0] to be
// "attest-target" — steps({}) carries no form and builds the deployable chain, so the law holds; the
// build-only chain has no target cluster to attest and starts at preflight-scopes. The plan phase is
// the executor's streaming onboard entrypoint, which records the run "planning", streams the gate
// lines, and freezes the composed report into these params. plan() therefore refuses (it must never
// be reached via the synchronous POST /runs path); onboard is registered opt-in, with its ports, in
// wire.ts.

const consumerNameSchema = z.string().regex(/^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/);
const repoURLSchema = z.string().regex(/^https:\/\/[^ ]+\.git$/);

/** The fields BOTH forms of the frozen onboard params share: the operator's identity fields, the
 *  release the trigger fires ({version, channel} — never a tag: the release script mints or reuses
 *  the tag repo-side), and what the streaming plan phase resolved (the checked default-branch head,
 *  the approved report, the attested build names). The steps read this via ctx.params; the
 *  executor's StepCtx exposes params but not plan_json, so the plan phase hands the steps their
 *  inputs here. */
const OnboardParamsBase = z.object({
  consumerName: consumerNameSchema,
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
  // Deployable: the target cluster's stage (derived from its row). Build-only: the stage the one
  // triggered release run puts the release on (the operator's own pick).
  stage: z.enum(STAGE),
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

/** The DEPLOYABLE form: everything the target cluster adds — its identity, the chart, and the
 *  manifest facts the registration carries. */
export const DeployableOnboardParams = OnboardParamsBase.extend({
  form: z.literal("deployable"),
  // The composed, approved gate report — kept in the run record, never committed. REQUIRED on this
  // form and with no counterpart beside it: a deployable unit is the one a gate renders a chart
  // for, and there is no path on which one is onboarded without a gate run.
  report: GateReportSchema,
  clusterId: z.string().startsWith("cls_"),
  // The target cluster's SHORT NAME (clusterShortName of its domain, e.g. "m1") — the stage
  // registration's own `cluster` field, which the consumers ApplicationSet selects on.
  cluster: z.string().min(1),
  namespace: z.string().min(1), // == consumerName by the identity law (G1)
  // The cluster's public apex, read out of its own values chain at plan time (global.unitApex). The
  // unit's ONE host is <consumerName>.<unitApex> — the admission policy pins it and provision-dns
  // creates exactly that record.
  unitApex: z.string().min(1),
  chartPath: z.string().regex(/^[^/].*$/),
  argoAppName: z.string().min(1),
  // The LITERAL Mongo database name(s) frozen from the validated manifest (report.manifest.databases)
  // at plan — write-registration copies them VERBATIM into the registration's databases field, the
  // routing source the consumers ApplicationSet reads for mongodb.databases. Empty [] ⇒ the consumer
  // requests none.
  databases: z.array(z.string()).default([]),
  // The claimed services frozen from the validated manifest — copied VERBATIM into the registration's
  // `services` field, the switch the consumers ApplicationSet gates its conditional per-consumer
  // PostgreSQL source on, AND the switch seed-postgres-superuser keys its Vault write on.
  services: z.array(ConsumerServiceSchema).default([]),
  // HOW this consumer runs MongoDB, frozen from its manifest at plan. The registration carries it
  // for the appset's conditional source, and the quota was summed from it. Defaulted rather than
  // optional so the registration always states a literal, which the appset reads bare under
  // missingkey=error; a manifest expressing no preference lands on the cluster's shared replica set
  // and costs the consumer nothing.
  mongodb: MongodbModeSchema.default("shared"),
  // The SIZE of the unit — the namespace ceiling it is sold, and the size its databases are rendered
  // at, because a unit has exactly one. Frozen at plan as a NAME; write-registration resolves it to
  // figures against the size table as it commits, so a plan that waited for approval across a table
  // edit lands on the figures standing at that moment rather than the ones that stood when it was
  // planned. Defaulted rather than optional: an unattended path must land on the frugal preset, never
  // the generous one.
  size: UnitSizeSchema.default(DEFAULT_UNIT_SIZE),
  // The manifest's declared extra public FQDN, frozen at plan AFTER G19 proved the platform serves
  // no such name yet. write-registration copies it into the stage registration — the ATTEST — and
  // apply-admission-policy admits it beside `<name>.<unitApex>`. Absent ⇒ the unit serves only its
  // platform address.
  fqdn: z.string().optional(),
  // The manifest-declared secrets (seed-secrets): full specs, not bare keys — the step must know
  // per key whether the Manager MINTS it (generate) or the operator supplied it (required).
  secretSpecs: z.array(ConsumerSecretSpecSchema).default([]),
  // The manifest-declared post-onboard activation, frozen from report.manifest.activation at plan.
  // Present ⇒ the run gains a final `activate` step that calls the declared endpoint over the
  // consumer's ingress; absent ⇒ no such step (backward-compatible). Carries only the call SHAPE
  // (path/method/tokenSecret name/header/prompt) — never the token or the operator inputs (the token
  // is seed-minted in-run memory; the inputs ride the approve ceremony, not params).
  activation: ConsumerActivationSchema.optional(),
});
export type DeployableOnboardParams = z.infer<typeof DeployableOnboardParams>;

/** The BUILD-ONLY form: no cluster and no chart, and the only form that can carry `ungated`
 *  instead of a report — the platform's own unit at the first installation in the master role
 *  (first-master.ts states every condition that admits it). */
export const BuildOnlyOnboardParams = OnboardParamsBase.extend({
  form: z.literal("build-only"),
  // EXACTLY ONE of these two stands here, and the union's refine below is what says so. They are
  // separate fields rather than one field of two shapes because a reader asking "was this gated?"
  // must not have to inspect a value to find out, and because an ungated record is NOT a report and
  // must never be read as one (shared/gates.ts UngatedOnboardSchema).
  report: GateReportSchema.optional(),
  ungated: UngatedOnboardSchema.optional(),
});
export type BuildOnlyOnboardParams = z.infer<typeof BuildOnlyOnboardParams>;

export const OnboardParams = z.discriminatedUnion("form", [DeployableOnboardParams, BuildOnlyOnboardParams])
  .superRefine((p, ctx) => {
    if (p.form !== "build-only") return;
    if ((p.report === undefined) === (p.ungated === undefined)) {
      ctx.addIssue({
        code: "custom",
        path: ["report"],
        message: "a build-only onboarding carries exactly one of report (a gate run produced it) and ungated (no gate ran at all)",
      });
    }
  });
export type OnboardParams = z.infer<typeof OnboardParams>;

/** The Manager-side clients the steps drive (master-local; no SSH). The kube clients are no
 *  longer injected directly: the steps resolve the RIGHT clusterReader/argoReader/projectWriter +
 *  ArgoCD namespace for the target cluster (p.clusterId) at run time via the resolver, so a consumer
 *  onboarding to a slave reaches that slave while the master stays master-local. */
export interface OnboardPorts {
  repo: RepoReader;
  runner: GateRunner;
  registrations: Registrations;
  /** Every subdomain a TENANT stands at (TenantRegistrations over catalog — a second repo, hence a
   *  port of its own). G23 refuses a unit name that is one of them: the consumer would serve exactly
   *  the host that tenant's IdP scopes its session cookies to (unit-dns.ts). */
  tenantSubdomains: TenantSubdomainReader;
  seeder: VaultSeeder;
  resolver: ClusterKubeResolver;
  declareListening: boolean;
  /** Bound of the whole validation poll (validate.ts pollBudgetMs). The wiring sets it a margin
   *  above the gate-runner's sandbox job budget, so the in-pod budget fires first on a healthy run
   *  and this bound only catches a PipelineRun that never settles. */
  validationBudgetMs?: number;
  argoWatchTimeoutMs: number;
  /** How long the workflow correlation + follow may take (trigger → the run completes) — the
   *  workflow only mints the tag and pushes the deploy ref, so this is minutes, not the build
   *  budget. watch-deployment's bump-commit read shares it (the same order of magnitude). */
  releaseWorkflowTimeoutMs: number;
  /** How long the build-plane release run may take (clone + install + buildah + bump + sync). */
  releaseBuildTimeoutMs: number;
  /** Poll tick of the release watches; overridable for tests. */
  releasePollIntervalMs?: number;
  /** The trigger's 404 retry window (a just-committed workflow indexes with a lag); overridable for
   *  tests. Defaults to 60s at 5s ticks. */
  dispatchRetry?: { budgetMs: number; intervalMs: number };
  /** Writes the unit's build grants (provision-build-rbac). Optional but UNCONDITIONALLY needed by
   *  onboard — absent ⇒ the step fails loud (no grants → the webhook creates no PipelineRun and the
   *  manager cannot watch the release run), never a silent skip (setup-webhook precedent). */
  buildRbac?: BuildRbacWriter;
  /** Reads the MASTER's own ArgoCD Applications (await-build-namespace). Injected directly rather
   *  than resolved, and for two reasons that both matter: the per-unit build Application is
   *  master-local whatever cluster the unit targets, and a BUILD-ONLY unit carries no `clusterId`
   *  at all — it has no cluster, so there is nothing to resolve a reader from. Optional but
   *  UNCONDITIONALLY needed by onboard: absent ⇒ the step fails loud, because the alternative is
   *  writing grants into a namespace nobody has confirmed exists. */
  buildArgo?: MasterArgoReader;
  /** Writes the per-unit ArgoCD repository Secret (provision-repo-credential). Optional but
   *  UNCONDITIONALLY needed by the deployable form — absent ⇒ the step fails loud (ArgoCD could
   *  never fetch the private consumer repo), never a silent skip. */
  repoCredential?: RepoCredentialWriter;
  /** Makes the manifest-declared post-onboard activation call. Optional: only the `activate` step
   *  needs it, and that step is present ONLY when a consumer declares an `activation:` block — a
   *  consumer without one never touches this port. Absent while a consumer DOES declare activation
   *  ⇒ the step fails loud (a wiring gap, never a silent skip). */
  activator?: Activator;
  /** The per-call consumer-PAT GitHub client: the PAT scope preflight, the build webhook
   *  (setup-webhook / remove-webhook), the release workflow dispatch (trigger-release) and the
   *  workflow watch. Optional but UNCONDITIONALLY needed by onboard — absent ⇒ those steps fail loud
   *  (no hook → no build; no dispatch → no cycle), never a silent skip. */
  github?: GitHubConsumer;
  /** Watches the unit's release PipelineRun in its own `<name>-build` namespace
   *  (watch-release-build). Optional but UNCONDITIONALLY needed — absent ⇒ the step fails loud. */
  buildPlane?: BuildPlane;
  /** The unit's ONE public DNS record (provision-dns / remove-dns). Optional but
   *  UNCONDITIONALLY needed by the deployable form — absent ⇒ the step fails loud (DNS is a
   *  mandatory part of the run kind), never a silent skip. */
  dns?: DnsProvider;
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
  consumerRepo?: ConsumerRepo;
  /** The consumer name of the PLATFORM'S OWN unit (config.ts PLATFORM_UNIT_NAME). The one unit that
   *  may be onboarded without a gate run, and only at the first installation in the master role —
   *  first-master.ts states the other three conditions. Absent ⇒ no onboarding on this Manager may
   *  skip the gate, which is where every Manager that does not install first masters stands. */
  platformUnitName?: string;
}

function deployableSteps(ports: OnboardPorts, p: DeployableOnboardParams): Step[] {
  // In-run memory shared across steps within ONE execute() pass (the executor calls def.steps() once
  // and iterates the array). seed-secrets (writer) and activate (reader) share the minted bootstrap
  // token; the release-cycle steps share the trigger time + the minted tag (onboard-release-cycle.ts).
  const runtime: { bootstrapToken?: string | undefined } = {};
  const release: ReleaseCycleRuntime = {};
  const steps: Step[] = [
    attestTargetStep(ports, p),
    // preflight-scopes RIGHT AFTER attest-target and BEFORE every mutation: verify the consumer PAT
    // carries repo + workflow + admin:repo_hook in ONE check, so a missing right is reported
    // COMPLETELY and rejects the run before anything is written — no more discovering scopes one
    // step at a time.
    preflightScopesStep(ports, p),
    checkStep(ports, p),
    // record-provisional BEFORE the first mutation: from here on every leftover this run can create —
    // the registration, the Vault entries, the AppProject, the admission policy, the DNS record, the
    // webhook — is accounted for by an inventory row. Recording only at the end left a failed onboard
    // with all of that and no row at all, findable solely by an explicit detected-scan.
    recordProvisionalStep(ports, p),
    // the registration comes FIRST — it is what makes the unit's release pipeline exist.
    writeRegistrationStep(ports, p),
    seedSecretsStep(ports, p, runtime),
    // seed-postgres-superuser: the per-consumer PostgreSQL instance-superuser Vault write, a no-op
    // for a consumer that does not claim postgresql. Positioned before the release trigger so the
    // leaf exists before ArgoCD ever syncs the instance.
    seedPostgresSuperuserStep(ports, p),
    // seed-mongodb-instance: the same, for a consumer whose manifest asks for a MongoDB of its own
    // instead of the cluster's shared replica set. A no-op for every consumer on `shared`, and
    // positioned here for the same reason — the leaf must exist before ArgoCD syncs the instance,
    // because the mongo image creates its root user from it at first init and never again.
    seedMongodbInstanceStep(ports, p),
    seedRepoPatStep(ports, p),
    // The provisioning block: the TWO per-unit objects the Manager still writes outside any chart.
    // The ArgoCD repository credential, because its value is a PAT and no chart may carry one; and
    // the mail-ops grant, because it lands in the relay's namespace on the MASTER, which the
    // reconciler of a slave-hosted unit cannot reach. The other five — the isolation AppProject, the
    // admission boundary, the argo-sync grant and the two build-namespace grants — are rendered from
    // the registration write-registration commits above (hostyour-cloud#174).
    //
    // WHAT ORDERS THEM NOW. The two build grants stand inside the Application await-build-namespace
    // waits for, so they are ordered by a wait that was already here. The AppProject, the policy and
    // the argo-sync grant come from a second ApplicationSet nothing waits on — and what holds that is
    // watch-deployment below, which cannot read Synced+Healthy for a unit whose AppProject is absent:
    // ArgoCD refuses an Application whose project does not exist and retries until it does.
    provisionRepoCredentialStep(ports, p),
    awaitBuildNamespaceStep(ports, p),
    provisionSmtpOpsGrantStep(ports, p),
    // The unit's public address, before the release cycle: the deployment the cycle
    // produces must come up resolvable — cert issuance (HTTP-01) needs the host to resolve.
    provisionDnsStep(ports, p),
    // The injection: the release kit, then the webhook that fires on the ref the kit's
    // script pushes. Both fail-closed — a repo that cannot mint or deliver a release must not pass.
    injectReleaseKitStep(ports, p),
    setupWebhookStep(ports, p),
    // The trigger + the watches: start the cycle ONCE through the injected workflow
    // — the proof of the injection — and read its results back stage by stage.
    triggerReleaseStep(ports, p, release),
    watchReleaseWorkflowStep(ports, p, release),
    watchReleaseBuildStep(ports, p, release),
    watchDeploymentStep(ports, p),
    smokeStep(ports, p),
    recordInventoryStep(ports, p),
  ];

  // The manifest-declared post-onboard activation — a FINAL step, present ONLY when the consumer
  // declares an `activation:` block. It runs LAST, after smoke + record-inventory: the app is
  // serving and the consumer is already recorded, so a failed activation never rolls back a live
  // deployment — the operator retries via a fresh onboard or skips (the first-admin invite is a
  // one-time action). It calls the declared endpoint over the consumer's OWN ingress with the seed-
  // minted token (in-run memory) + the operator's approve-time inputs, and surfaces the activate_url.
  return p.activation ? [...steps, activateStep(ports, p, runtime)] : steps;
}

function buildOnlySteps(ports: OnboardPorts, p: BuildOnlyOnboardParams): Step[] {
  const release: ReleaseCycleRuntime = {};
  return [
    // No attest-target: there is no target cluster whose deploy-state could be attested — the run kind
    // touches git, the local Vault and the build plane's own namespaces, all on the cluster the
    // manager itself runs on.
    preflightScopesStep(ports, p),
    // The check step RE-RUNS the gates at the current head, so the one onboarding that was admitted
    // without a gate has no check to run: leaving it in would dispatch at execute time the very
    // sandbox the plan established there is no point waiting for. Omitted rather than turned into a
    // step that logs and passes — a step named "check" that checks nothing is a green light for a
    // measurement that never happened.
    ...(p.ungated ? [] : [checkStep(ports, p)]),
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
    triggerReleaseStep(ports, p, release),
    watchReleaseBuildStep(ports, p, release),
    recordBuildOnlyStep(ports, p, release),
  ];
}

function onboardSteps(ports: OnboardPorts, p: OnboardParams): Step[] {
  return p.form === "build-only" ? buildOnlySteps(ports, p) : deployableSteps(ports, p as DeployableOnboardParams);
}

/** The raw operator request from the onboard wizard. Carries {version, channel} — never a ref or a
 *  tag: the release script mints (or reuses) the tag repo-side, and the run only triggers it.
 *  EXACTLY ONE of `clusterId` (deployable — the stage is the cluster's) and `stage` (build-only —
 *  where the one triggered release run puts the release) is given; the manifest's own shape (chart
 *  present or not) is checked against that choice at plan time. Carries the ONE per-consumer GitHub
 *  PAT as a raw value — REQUIRED (owner rule: every consumer is private and onboards with exactly
 *  one PAT). The API handler seals it into the credential store BEFORE any run exists and threads
 *  only the sealed reference onward (OnboardPlanRequest): planStreamed persists its raw params
 *  verbatim (params_json), so the raw PAT must never enter the executor. */
const OnboardRequestFields = z.object({
  consumerName: consumerNameSchema,
  repoURL: repoURLSchema,
  version: z.string().regex(RELEASE_VERSION_RE, { message: "must be x.y.z with no leading zeros — the release script mints the full tag from it" }),
  channel: z.enum(RELEASE_CHANNEL),
  owner: z.string().min(1),
  // The chart subpath of a DEPLOYABLE unit; the contract's conventional default. A build-only
  // manifest declares no chart, so its form never reads this.
  chartPath: z.string().regex(/^[^/].*$/).default("deploy/chart"),
  // The namespace ceiling this consumer is sold. It comes from the OPERATOR onboarding the unit, never
  // from the consumer's manifest: the manifest is written by the customer, and a customer choosing
  // their own ceiling is not a ceiling. Defaulted to the frugal preset, so an onboard that names none
  // lands there and is raised deliberately afterwards rather than sold generously by omission.
  size: UnitSizeSchema.default(DEFAULT_UNIT_SIZE),
  repoPat: z.string().min(1), // the raw GitHub PAT — sealed by the API handler, never persisted/logged
  clusterId: z.string().startsWith("cls_").optional(),
  stage: z.enum(STAGE).optional(),
});

function refineFormChoice(r: { clusterId?: string | undefined; stage?: string | undefined }, ctx: z.RefinementCtx): void {
  if ((r.clusterId === undefined) === (r.stage === undefined)) {
    ctx.addIssue({
      code: "custom",
      path: ["clusterId"],
      message: "exactly one of clusterId (deployable — the stage is the cluster's) or stage (build-only — where the triggered release run puts the release) must be given",
    });
  }
}

export const OnboardRequest = OnboardRequestFields.superRefine(refineFormChoice);
export type OnboardRequest = z.infer<typeof OnboardRequest>;

/** What actually enters the executor (planStream's raw params): the operator request with the raw
 *  PAT REPLACED by the sealed credential reference. Split from OnboardRequest so the raw value is
 *  structurally unable to reach params_json. */
export const OnboardPlanRequest = OnboardRequestFields.omit({ repoPat: true })
  .extend({
    repoCredentialId: z.string().min(1), // the sealed repo PAT (the run's read credential)
  })
  .superRefine(refineFormChoice);
export type OnboardPlanRequest = z.infer<typeof OnboardPlanRequest>;

export interface ResolvedTarget {
  /** The gate target, minus the cluster values chain — the caller reads that off the install branch
   *  (Registrations.readClusterValueFiles) and completes the OnboardTarget. */
  target: Omit<OnboardTarget, "clusterValueFiles">;
  clusterId: string;
  /** The cluster's SHORT NAME — the registration's `cluster` field and the appset's selector. */
  cluster: string;
  namespace: string;
  argoAppName: string;
}

/** Resolve the target cluster's context from its inventory row. Exported + structurally typed
 *  (clusterId/consumerName/chartPath) so a caller resolving the TARGET stage can reuse it without
 *  copying this logic. The cluster's own VALUES are not resolved here at all: they live once per
 *  cluster in the values chain on its install branch and reach every chart from there. */
export function resolveTarget(db: Db, req: { clusterId: string; consumerName: string; chartPath: string }): ResolvedTarget {
  const cluster = db.select().from(clusters).where(eq(clusters.id, req.clusterId)).get();
  if (!cluster) throw errNotFound(`cluster ${req.clusterId}`);
  return {
    target: { domain: cluster.domain, stage: cluster.stage, chartPath: req.chartPath },
    clusterId: cluster.id,
    cluster: clusterShortName(cluster.domain),
    namespace: req.consumerName, // identity law: name == namespace
    // The GENERATED Application's name: the consumers appset stamps `{{ .name }}-<stage>`
    // (e.g. example-auth-prod) — never the bare consumer name (that stays the AppProject/ns name).
    argoAppName: consumerArgoAppName(req.consumerName, cluster.stage),
  };
}

/** Reject the plan when the manifest's shape (chart present = deployable, absent = build-only)
 *  disagrees with the form the operator picked — the request's cluster-or-stage choice. Returning
 *  the rejection instead of throwing keeps the full report frozen for the operator. */
function formMismatch(outcome: ValidationOutcome, wantsChart: boolean, consumerName: string): { outcome: "rejected"; summary: string; planJson: unknown } | null {
  const hasChart = outcome.report.manifest?.chart !== undefined;
  if (hasChart === wantsChart) return null;
  return {
    outcome: "rejected",
    summary: hasChart
      ? `Onboarding "${consumerName}" was rejected — the manifest declares a chart (a self-contained, deployable unit), so a target cluster must be picked instead of a bare stage`
      : `Onboarding "${consumerName}" was rejected — the manifest declares NO chart (a build-only unit), so onboard it build-only: a stage for the triggered release run instead of a target cluster`,
    planJson: outcome.report,
  };
}

export function makeOnboardDef(ports: OnboardPorts): RunDefinition<OnboardParams> {
  return {
    kind: "consumer-onboard",
    paramsSchema: OnboardParams,
    mutating: true, // mutating ⇒ steps({}) builds the deployable chain, whose step 0 is attest-target
    plan: () => {
      // onboard is planned by the executor's streaming onboard entrypoint (planStream below), which
      // runs the gate-runner and freezes the report into params — never the synchronous plan() path.
      throw new AppError("INTERNAL", "onboard is planned via planStream (the streaming entrypoint), not plan()");
    },
    // The streaming planner: clone -> gate-runner -> compose (validate.ts), streamed as it runs.
    // A pass resolves the augmented params + the plan; a rejection freezes the full report so the
    // failed run shows every expected/found/reason and stays soft-deletable.
    planStream: async (rawParams, ctx) => {
      // The API handler already swapped the raw PAT for a sealed reference (OnboardPlanRequest) —
      // a raw repoPat here would mean it reached params_json, so the schema simply has no such field.
      const req = OnboardPlanRequest.parse(rawParams);
      // Echo every received parameter up front so the operator can confirm the request arrived intact
      // (the raw PAT is already sealed to repoCredentialId before this point — never logged).
      ctx.log(
        `onboard parameters — consumer="${req.consumerName}" repo="${req.repoURL}" ` +
          `version=${req.version} channel=${req.channel} ` +
          (req.clusterId !== undefined ? `cluster=${req.clusterId} chartPath="${req.chartPath}" ` : `build-only stage=${req.stage} `) +
          `owner="${req.owner}" repoCredential=${req.repoCredentialId} (raw PAT sealed, never logged)`,
      );

      if (req.clusterId === undefined) {
        // ---- BUILD-ONLY: no target cluster; the gates run without a chart or a values chain ----
        const stage = req.stage!;
        const master = resolveMasterCluster(ctx.db);
        // THE ONE ONBOARDING THAT SKIPS THE GATE, and only when every condition in first-master.ts
        // holds. The verdict is computed here, in the open, and the refusal reason is logged even
        // when it refuses — an operator wondering why the gate ran reads the answer off the run.
        const exemption = admitFirstMasterUngated({
          platformUnitName: ports.platformUnitName,
          consumerName: req.consumerName,
          buildOnly: true,
          registeredUnits: await ports.registrations.listUnitNames(),
          masterDomain: master.domain,
        });
        if (exemption.admitted) {
          const planned = await planUngatedFirstMaster(
            { repo: ports.repo, log: ctx.log, signal: ctx.signal, registrationBranch: ports.registrations.branch },
            { ...req, stage },
            { clusterId: master.clusterId, domain: master.domain, admittedBy: exemption.admittedBy },
            (p) => onboardSteps(ports, p),
          );
          return planned;
        }
        ctx.log(`the gate applies to this onboarding — ${exemption.refusedBecause}`);
        const outcome = await validateOnboard(
          { repoURL: req.repoURL, ref: DEFAULT_BRANCH_HEAD, consumerName: req.consumerName, repoCredentialId: req.repoCredentialId, size: req.size },
          { domain: master.domain, stage, clusterValueFiles: [] },
          { repo: ports.repo, runner: ports.runner, registrations: ports.registrations, tenantSubdomains: ports.tenantSubdomains, log: ctx.log, signal: ctx.signal, declareListening: ports.declareListening, resolveQuota: (size, brings) => resolveUnitQuota(ctx.db, size, brings), ...(ports.validationBudgetMs !== undefined ? { pollBudgetMs: ports.validationBudgetMs } : {}) },
        );
        if (outcome.verdict !== "pass" || outcome.builds === null) {
          const failed = outcome.report.gates.filter((g) => g.status !== "pass");
          return {
            outcome: "rejected",
            summary: `Onboarding "${req.consumerName}" (build-only) was rejected — ${failed.length} gate(s) did not pass: ${failed.map((g) => g.id).join(", ")}`,
            planJson: outcome.report,
          };
        }
        const mismatch = formMismatch(outcome, false, req.consumerName);
        if (mismatch) return mismatch;
        const params: OnboardParams = {
          form: "build-only",
          consumerName: req.consumerName,
          repoURL: req.repoURL,
          repoCredentialId: req.repoCredentialId,
          owner: req.owner,
          version: req.version,
          channel: req.channel,
          stage,
          resolvedSha: outcome.resolvedSha,
          // Nothing of a build-only unit deploys, so the run is about the master alone — the gates run
          // against it, and its map names the build plane the webhook goes to.
          domain: master.domain,
          builds: outcome.builds,
          report: outcome.report,
        };
        const stepDefs = onboardSteps(ports, params);
        const plan: Plan = {
          kind: "consumer-onboard",
          targetKind: "cluster",
          targetId: master.clusterId, // the build plane — the one cluster this form touches
          summary: `Onboard build-only unit "${req.consumerName}" (version ${req.version}, channel ${req.channel}, release run on ${stage}): ${stepDefs.length} steps — attest the registration, inject the release kit, trigger the cycle once and watch its build.`,
          steps: stepDefs.map((s) => ({ name: s.name, title: s.title })),
          targets: [], // no host owned — the Manager acts master-locally
          locks: [
            { resource: "git-branch", key: ports.registrations.branch }, // the registration commit's branch
            { resource: "master-kube", key: "m" },
          ],
          warnings: [],
          requiredSecrets: [],
        };
        return { outcome: "planned", params, plan };
      }

      // ---- DEPLOYABLE: resolve the target cluster and run all the gates ----
      const r = resolveTarget(ctx.db, { clusterId: req.clusterId, consumerName: req.consumerName, chartPath: req.chartPath });
      // The cluster's own values come from its install branch, not from here — the gate renders the
      // chart with exactly the files the Application layers at sync.
      const clusterValueFiles = await ports.registrations.readClusterValueFiles(r.target.domain, r.target.stage);
      // ...and the facts the target cluster resolved to, so a wrong stage or branch is visible here
      // rather than three gates later.
      ctx.log(
        `resolved target — domain=${r.target.domain} stage=${r.target.stage} namespace=${r.namespace} ` +
          `argoApp=${r.argoAppName} ` +
          `clusterValues=${clusterValueFiles.map((f) => f.path).join(", ")}`,
      );
      const outcome = await validateOnboard(
        { repoURL: req.repoURL, ref: DEFAULT_BRANCH_HEAD, consumerName: req.consumerName, repoCredentialId: req.repoCredentialId, size: req.size },
        { ...r.target, clusterValueFiles },
        { repo: ports.repo, runner: ports.runner, registrations: ports.registrations, tenantSubdomains: ports.tenantSubdomains, log: ctx.log, signal: ctx.signal, declareListening: ports.declareListening, resolveQuota: (size, brings) => resolveUnitQuota(ctx.db, size, brings), ...(ports.validationBudgetMs !== undefined ? { pollBudgetMs: ports.validationBudgetMs } : {}) },
      );
      if (outcome.verdict !== "pass" || outcome.builds === null) {
        const failed = outcome.report.gates.filter((g) => g.status !== "pass");
        return {
          outcome: "rejected",
          summary: `Onboarding "${req.consumerName}" was rejected — ${failed.length} gate(s) did not pass: ${failed.map((g) => g.id).join(", ")}`,
          planJson: outcome.report,
        };
      }
      const mismatch = formMismatch(outcome, true, req.consumerName);
      if (mismatch) return mismatch;
      // The step needs the FULL specs (a `generate` key is minted at seed, never operator-supplied),
      // while requiredSecrets — what approve() demands from the operator — carries ONLY the
      // required non-generate keys. Specs hold key/required/generate, never a secret value, so
      // freezing them into params_json is safe.
      const secretSpecs = outcome.report.manifest?.secrets ?? [];
      const requiredSecrets = secretSpecs.filter((s) => !s.generate && s.required).map((s) => `consumer-secret:${s.key}`);
      // A manifest-declared activation adds a final `activate` step + asks the operator for its
      // dynamic args at approve (the prompt fields become NON-secret `requiredInputs`, collected in the
      // clear, below in the plan); the activation SHAPE is frozen into params so the step has it. Both
      // spreads read report.manifest?.activation directly, so an absent block is backward-compatible.
      const unitApex = unitApexFromChain(clusterValueFiles);
      const params: OnboardParams = {
        form: "deployable",
        consumerName: req.consumerName,
        repoURL: req.repoURL,
        repoCredentialId: req.repoCredentialId,
        owner: req.owner,
        version: req.version,
        channel: req.channel,
        stage: r.target.stage,
        resolvedSha: outcome.resolvedSha,
        domain: r.target.domain,
        builds: outcome.builds,
        report: outcome.report,
        clusterId: r.clusterId,
        cluster: r.cluster,
        namespace: r.namespace,
        unitApex,
        chartPath: req.chartPath,
        argoAppName: r.argoAppName,
        databases: outcome.report.manifest?.databases ?? [], // literal DB name(s) from the manifest, copied verbatim
        services: outcome.report.manifest?.services ?? [], // claimed services from the manifest, copied verbatim
        // How this consumer runs MongoDB, copied verbatim. Written unconditionally, because the
        // registration is the outward projection and a consumer that changes its mind later must
        // not need its registration rewritten twice.
        mongodb: outcome.report.manifest?.mongodb ?? "shared",
        // The namespace ceiling, from the operator's request — deliberately NOT from the manifest, so
        // a consumer cannot declare the ceiling it is bounded by.
        size: req.size,
        secretSpecs,
        ...(outcome.report.manifest?.activation ? { activation: outcome.report.manifest.activation } : {}),
        // The G19-checked declared fqdn — approving this plan is the operator's grant of it.
        ...(outcome.report.manifest?.fqdn ? { fqdn: outcome.report.manifest.fqdn } : {}),
      };
      const stepDefs = onboardSteps(ports, params);
      const plan: Plan = {
        kind: "consumer-onboard",
        targetKind: "cluster",
        targetId: r.clusterId,
        summary:
          `Onboard consumer "${req.consumerName}" to ${r.target.domain} (${r.target.stage}), version ${req.version} on channel ${req.channel}: ${stepDefs.length} steps — register, provision, inject the release kit, trigger the cycle once and watch the deployment it produces.` +
          // The grant is the operator's act, so the plan being approved names it — and names what the
          // grant IS: the admission policy admits the name; serving it stays the unit's own chart's
          // work (a second Ingress rule plus a tls entry of its own).
          (outcome.report.manifest?.fqdn ? ` The manifest declares the extra FQDN ${outcome.report.manifest.fqdn} — approving attests it, so the unit MAY serve it beside ${req.consumerName}.${unitApex}; its chart must carry the extra Ingress rule and its own tls entry, or the name stays unserved.` : ""),
        steps: stepDefs.map((s) => ({ name: s.name, title: s.title })),
        targets: [], // no host owned — the Manager acts master-locally
        locks: [
          // The registration commit rides the books branch; the values-chain reads ride the
          // cluster's install branch worktree — both are per-branch worktrees a concurrent writer
          // must not reset underneath this run. On a consumer that deploys onto the master itself the
          // two keys are the same string; the lock manager dedupes claims.
          { resource: "git-branch", key: ports.registrations.branch },
          { resource: "git-branch", key: r.target.domain },
          { resource: "master-kube", key: "m" },
        ],
        warnings: [],
        requiredSecrets,
        ...(outcome.report.manifest?.activation?.prompt.length ? { requiredInputs: outcome.report.manifest.activation.prompt.map((pr) => ({ field: pr.field, label: pr.label })) } : {}),
      };
      return { outcome: "planned", params, plan };
    },
    steps: (params) => onboardSteps(ports, params),
    // The rollback, both halves, from onboard-abort.ts: WHAT the compensations are (the ordered lists
    // write-registration arms — plus the ceremony-secret inverse seed-secrets arms on a real create,
    // named here so the executor can resolve it), and WHETHER they may run — a full un-deploy must
    // never fire for a run whose consumer has meanwhile gone live or been recorded.
    cleanups: (params) =>
      params.form === "build-only"
        ? buildOnlyOnboardCleanups(ports, params)
        : [...deployableOnboardCleanups(ports, params), removeCeremonySecretsCleanup(ports, params)],
    assertAbortable: (params, deps) => assertOnboardAbortable(ports, params, deps.db),
  };
}
