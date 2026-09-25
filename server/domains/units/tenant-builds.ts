// The tenant onboarding builds the images its fan-out lacks — the consumer onboarding's own release
// cycle, run per build repository from inside the tenant run (hostyour-manager#165).
//
// A CONSUMER ONBOARDING BUILDS ITS IMAGES ITSELF: the wizard hands it a repository and a PAT, the
// release kit is committed, the workflow dispatched, the build watched, the pins bumped. A tenant
// onboarding gets the catalogue only, and ensure-images used to stop it at the first image the
// registry lacked — a hand step between the plan and the tenant. This module closes that gap:
//
//   1. resolveBuildUnits — the pure policy at plan time. Every required image the registry lacks is
//      mapped to the repository the catalogue's `tenant.buildRepos` names for it and grouped per
//      repository into ONE build unit. A unit registered on the installation carries its stored
//      credential; an unregistered one asks for a PAT at approve (requiredSecrets), once — the run
//      registers it, and the next tenant finds it and asks for nothing.
//   2. buildUnitStep — the run-time step per unit, BEFORE the tenant's own writes: the credential
//      (stored, or sealed from the approve-time PAT), the next version off the repository's release
//      tags, the channel that reaches the tenant's stage, the repository read the way the ungated
//      first-master path reads a build-only unit, and then the build-only chain of the consumer
//      onboarding, step by step, inside this step. Its registration and webhook are the unit's own
//      and stay when the tenant is gone; their cleanups ride this run, so an aborted tenant leaves no
//      half unit behind.
//   3. refreshImagesStep — after the builds the fan-out is rendered again against the books branch,
//      where every bump wrote its `pins-<stage>.yaml`, and with the tag the tenant's own apps bundle
//      was just built at (tenant-apps-steps.ts), so ensure-images probes the tags the cluster will
//      pull and the argo-sync grant names the units that now attest them.
//
// The tenant's own apps bundle is NEVER a build unit here: its repository is created and built by
// the apps-repo steps with the App's token, so its image is left out of the probe and no PAT is
// asked for it.
//
// Boundary: a domain module — it depends on the consumer onboarding's step factories and ports (the
// one place the release cycle is written), never on an adapter implementation.
import { z } from "zod";
import type { Step, StepCtx } from "../../executor/types.ts";
import type { Stage } from "../../../shared/enums.ts";
import { RELEASE_CHANNEL, type ReleaseChannel } from "../../../shared/release.ts";
import { unitNameFromRepoURL, type TenantSpec } from "../../../shared/consumer.ts";
import { errValidation } from "../../kernel/errors.ts";
import type { GitHubApp } from "../../adapters/github-app/port.ts";
import { judgeRepoIdentity, resolveRepoCredentialId, type OwnerIdentityReader, type RepoIdentityApp } from "./repo-identity.ts";
import { readOwnerIdentity } from "./owners.ts";
import type { PlatformRepo } from "../../adapters/git/port.ts";
import type { ChannelStages } from "../inventory/channel-stages.ts";
import { buildOnlySteps, type BuildOnlyOnboardParams, type OnboardPorts } from "./onboard.run.ts";
import { readUngatedOnboard } from "./first-master.ts";
import { DEFAULT_BRANCH_HEAD } from "./onboard-check.ts";
import { resolveNextVersion } from "./release-version.ts";
import { resolveMasterCluster } from "../inventory/read.ts";
import { triggerReleaseStep, watchReleaseBuildStep, type ReleaseCycleRuntime } from "./onboard-release-cycle.ts";
import { recordBuildOnlyStep } from "./onboard-registration.ts";
import { attestBuildsAgain } from "./build-unit-attest.ts";
import { type RequiredImage, requiredImagesFrom } from "./ensure-images.ts";
import type { RegistryProbe } from "../../adapters/registry/port.ts";
import { renderTenantArgoSync, tenantSyncUnits } from "./build-rbac.ts";
import { validateTenant, type ValidateTenantRequest } from "./validate-tenant.ts";
import type { RepoReader } from "../../adapters/git/port.ts";
import type { HelmRenderer } from "../../adapters/helm/port.ts";
import type { BuildRbacWriter, ClusterKubeResolver } from "../../adapters/kube/port.ts";
import { ensureImagesStep } from "./ensure-images.ts";
import type { ClusterValueFile } from "../../../shared/cluster-values.ts";
import type { TenantAppsRepoRuntime } from "./tenant-apps-steps.ts";

/** One build unit the tenant run onboards or re-releases before it fans out. Frozen into the run
 *  params at plan time; the credential id is present only for a unit already registered. Every
 *  other unit's identity is its owner's (repo-identity.ts, #220): judged at plan — refused
 *  there, naming the owner, where none stands — and sealed by the step itself. Nothing is
 *  asked at approve. */
export const BuildUnitSchema = z.object({
  unit: z.string().min(1), // basename(repoURL), the identity every registration holds
  repoURL: z.string().min(1),
  images: z.array(z.string().min(1)).min(1), // the image names this unit builds among the missing ones
  registered: z.boolean(),
  form: z.enum(["build-only", "deployable"]).optional(), // known for a registered unit only
});
export type BuildUnit = z.infer<typeof BuildUnitSchema>;

/** What the plan reads about a unit already registered on the installation. */
export interface RegisteredUnit {
  form: "build-only" | "deployable";
}

export interface BuildUnitResolution {
  units: BuildUnit[];
  /** Missing images no `tenant.buildRepos` entry names — the plan refuses, naming them. */
  unmapped: RequiredImage[];
}

/** The plan-time policy: the missing images grouped by the repository that builds them. */
export async function resolveBuildUnits(input: {
  missing: readonly RequiredImage[];
  buildRepos: TenantSpec["buildRepos"];
  registration: (unit: string) => Promise<RegisteredUnit | null>;
}): Promise<BuildUnitResolution> {
  const repoOf = new Map<string, string>();
  for (const entry of input.buildRepos) for (const image of entry.builds) repoOf.set(image, entry.repo);
  const byRepo = new Map<string, Set<string>>();
  const unmapped: RequiredImage[] = [];
  for (const img of input.missing) {
    const repo = repoOf.get(img.repo);
    if (repo === undefined) {
      unmapped.push(img);
      continue;
    }
    const images = byRepo.get(repo) ?? new Set<string>();
    images.add(img.repo);
    byRepo.set(repo, images);
  }
  const units: BuildUnit[] = [];
  for (const [repoURL, images] of byRepo) {
    const unit = unitNameFromRepoURL(repoURL);
    const found = await input.registration(unit);
    units.push({
      unit,
      repoURL,
      images: [...images].sort(),
      registered: found !== null,
      ...(found ? { form: found.form } : {}),
    });
  }
  units.sort((a, b) => a.unit.localeCompare(b.unit));
  return { units, unmapped };
}

export interface PlannedBuilds {
  units: BuildUnit[];
  warnings: string[];
}

/** THE PLAN'S HALF, in one call: probe every required image, map the missing ones to their build units,
 *  and say what the run will do. An image no `buildRepos` entry names is a refusal — nothing can be
 *  built for it — and so is a unit registered as DEPLOYABLE: its release deploys its own standing
 *  instance too, which is the unit's own act (its Consumers page), not a tenant's. A render that
 *  pulls the apps TEMPLATE (`tenant.appsBundle`) is refused before the registry is asked: the
 *  template is copied from, never built and never mounted, so a chart still naming it is stale and
 *  is named here rather than built or pulled. The tenant's OWN bundle (`appsImage`) is not probed:
 *  the apps-repo steps build it in every run, and refresh-images probes it at the tag they read. */
export async function planBuildUnits(input: {
  requiredImages: readonly RequiredImage[];
  registryHost: string;
  buildRepos: TenantSpec["buildRepos"];
  appsBundle?: TenantSpec["appsBundle"];
  appsImage?: string | undefined;
  registration: (unit: string) => Promise<RegisteredUnit | null>;
  /** The platform's GitHub App and the owner identities: every unregistered unit's identity
   *  is judged here (repo-identity.ts), and a unit whose owner records none refuses the plan. */
  githubApp?: Pick<GitHubApp, "reachesRepository" | "installationOrg"> | undefined;
  owners: OwnerIdentityReader;
  probe: RegistryProbe;
  stage: Stage;
  subdomain: string;
  signal: AbortSignal;
  log: (line: string) => void;
}): Promise<{ outcome: "planned"; builds: PlannedBuilds } | { outcome: "rejected"; summary: string }> {
  const template = input.requiredImages.filter((img) => img.repo === input.appsBundle);
  if (template.length > 0) {
    return {
      outcome: "rejected",
      summary: `Tenant "${input.subdomain}" was rejected — the rendered members pull ${template.map((m) => `${m.repo}:${m.tag}`).join(", ")}, and "${input.appsBundle}" is the catalogue's apps template (tenant.appsBundle): the template is copied from, never built and never mounted, so a member chart still lists it as a build and needs to mount the tenant's own bundle instead`,
    };
  }
  const missing: RequiredImage[] = [];
  for (const img of input.requiredImages) {
    if (img.repo === input.appsImage) continue;
    if (!(await input.probe.imageExists({ registryHost: input.registryHost, repo: img.repo, tag: img.tag }, { signal: input.signal }))) missing.push(img);
  }
  const { units, unmapped } = await resolveBuildUnits({ missing, buildRepos: input.buildRepos, registration: input.registration });
  if (unmapped.length > 0) {
    return {
      outcome: "rejected",
      summary: `Tenant "${input.subdomain}" was rejected — ${unmapped.length} required image(s) are missing from ${input.registryHost} and the catalogue's tenant.buildRepos names no repository that builds them: ${unmapped.map((m) => `${m.repo}:${m.tag}`).join(", ")}`,
    };
  }
  const deployable = units.filter((u) => u.form === "deployable");
  if (deployable.length > 0) {
    return {
      outcome: "rejected",
      summary: `Tenant "${input.subdomain}" was rejected — the image(s) ${deployable.flatMap((u) => u.images).join(", ")} are missing from ${input.registryHost} and belong to unit(s) registered as deployable (${deployable.map((u) => u.unit).join(", ")}); release each from its Consumers page, then plan again`,
    };
  }
  // Registered or not, the unit's identity is the owner's, judged now (#226): a registered unit
  // whose owner lost its identity is refused the same way a new one is.
  for (const u of units) {
    const judged = await judgeRepoIdentity({ repoURL: u.repoURL, githubApp: input.githubApp, owners: input.owners, signal: input.signal });
    if ("refused" in judged) return { outcome: "rejected", summary: `Tenant "${input.subdomain}" was rejected — build unit ${u.unit} (${u.repoURL}) builds ${u.images.join(", ")} and has no identity: ${judged.refused}` };
    const as = judged.kind === "github-app" ? "the platform's GitHub App" : "its owner's repository PAT";
    input.log(`build unit ${u.unit} (${u.repoURL}) builds ${u.images.join(", ")} — ${u.registered ? "registered, its release is re-run" : "not registered, onboarded build-only by this run"} as ${as}`);
  }
  const warnings = units.length > 0
    ? [`${units.length} build unit(s) build before anything of the tenant is written (${units.map((u) => `${u.unit}: ${u.images.join(", ")}, ${u.registered ? "registered, re-released with its builds attested as its manifest declares them now" : "onboarded build-only"}`).join("; ")}) — each releases its next version onto ${input.stage} and pins it on the books branch`]
    : [];
  return { outcome: "planned", builds: { units, warnings } };
}

/** The consumer onboarding's ports and the two release-version inputs beside them, handed to the
 *  tenant run LATE: the consumer family is wired after the tenant family (it needs the tenant
 *  registrations), so the tenant defs hold a getter the wiring fills once both stand. */
export interface TenantBuildDeps {
  ports: OnboardPorts;
  platformGitHub?: { owner: string; repo: string };
  platformRepo?: PlatformRepo;
  /** The platform's GitHub App — the identity of a unit it reaches, sealed by the step (repo-identity.ts). */
  githubApp?: RepoIdentityApp;
}

/** What the build steps hand the steps after them, in-run memory (the run's own closure): the image
 *  set and the sync units as they stand AFTER the builds wrote their pins, and — from the apps-repo
 *  steps — the tag the tenant's own bundle was built at and the credential its token was sealed
 *  under. Absent while no build ran, in which case the plan's frozen set stands. */
export interface TenantBuildRuntime extends TenantAppsRepoRuntime {
  requiredImages?: RequiredImage[];
  syncUnits?: string[];
}

/** The channel a tenant's build units are released on: the highest channel whose ceiling admits the
 *  tenant's stage (stable where it reaches, else beta, else alpha) — a tenant is never a pre-release. */
export function channelReaching(table: ChannelStages, stage: Stage): ReleaseChannel {
  for (const channel of [...RELEASE_CHANNEL].reverse()) {
    if (table[channel]?.includes(stage)) return channel;
  }
  throw errValidation(`no release channel reaches stage ${stage} (global.channelStages) — nothing can release a build unit onto it`);
}

export function buildUnitStepName(unit: string): string {
  return `build-unit:${unit}`;
}

/** The credential the unit's repository is reached with, resolved now the way the plan judged it
 *  (repo-identity.ts): the App's one row where the App reaches the repository, else the owner's
 *  repository PAT row — never a row of the unit's (#226). */
async function unitCredentialId(ctx: StepCtx, d: TenantBuildDeps, unit: BuildUnit): Promise<string> {
  return resolveRepoCredentialId({ repoURL: unit.repoURL, githubApp: d.githubApp, owners: (org) => readOwnerIdentity(ctx.db, org), store: ctx.creds, signal: ctx.signal });
}

async function nextVersion(ctx: StepCtx, deps: TenantBuildDeps, unit: BuildUnit, repoCredentialId: string): Promise<string> {
  const github = deps.ports.github;
  if (!github) throw errValidation(`build unit "${unit.unit}" needs the GitHub consumer client to read the repository's release tags, and none is wired on this manager`);
  const pat = await ctx.creds.open(repoCredentialId, { purpose: "tenant-create:build-unit-version", runId: ctx.runId });
  try {
    const { version } = await resolveNextVersion(
      { github, ...(deps.platformGitHub ? { platformGitHub: deps.platformGitHub } : {}), ...(deps.platformRepo ? { platformRepo: deps.platformRepo } : {}) },
      { repoURL: unit.repoURL, token: pat.toString("utf8"), signal: ctx.signal },
    );
    return version;
  } finally {
    pat.fill(0);
  }
}

/** ONE step per build unit, run before the tenant's own writes. Inside it the consumer onboarding's
 *  build-only chain runs step by step (registration, repo-pat seed, build namespace, release kit,
 *  webhook, release trigger, build watch, record) with parameters composed here; a unit already
 *  registered build-only skips the registration half and re-runs its release. */
export function buildUnitStep(
  deps: () => TenantBuildDeps | undefined,
  p: { guid: string; owner: string; stage: Stage },
  unit: BuildUnit,
): Step {
  return {
    name: buildUnitStepName(unit.unit),
    title: `Build ${unit.images.join(", ")} — ${unit.registered ? "re-release" : "onboard"} the build unit ${unit.unit}`,
    run: async (ctx) => {
      const d = deps();
      if (!d) {
        throw errValidation(`tenant ${p.guid} needs the build unit "${unit.unit}" (${unit.repoURL}) onboarded, and the consumer onboarding is not wired on this manager — the gate-runner and the git/kube/vault adapters must be wired first`);
      }
      const { ports } = d;
      const repoCredentialId = await unitCredentialId(ctx, d, unit);
      const master = resolveMasterCluster(ctx.db);
      const version = await nextVersion(ctx, d, unit, repoCredentialId);
      const channel = channelReaching(await ports.channelStages(), p.stage);
      ctx.log(
        "meta",
        `build unit ${unit.unit} (${unit.repoURL}) builds ${unit.images.join(", ")} — ` +
          (unit.registered ? "registered on this installation, its release is re-run" : "not registered on this installation, onboarded build-only by this run") +
          `; version ${version}, channel ${channel}, release run on ${p.stage}, build plane ${master.domain}`,
      );
      // The repository as the ungated first-master path reads a build-only unit: cloned at its
      // default branch head with the unit's own credential, the manifest refused unless it declares
      // the build-only shape. The fan-out that pulls these images was gated (T1..T4) at plan.
      const ungated = await readUngatedOnboard(
        { repo: ports.repo, log: (l) => ctx.log("meta", `${unit.unit}: ${l}`), signal: ctx.signal },
        { repoURL: unit.repoURL, ref: DEFAULT_BRANCH_HEAD, consumerName: unit.unit, repoCredentialId },
        {
          cluster: master.domain,
          admittedBy: [
            `build unit of tenant ${p.guid}: its images are pulled by a fan-out the tenant gates judged at plan; the unit's own manifest is read here and refused unless it declares the build-only shape`,
          ],
        },
      );
      const params: BuildOnlyOnboardParams = {
        form: "build-only",
        consumerName: unit.unit,
        repoURL: unit.repoURL,
        repoCredentialId,
        owner: p.owner,
        version,
        channel,
        stage: p.stage,
        resolvedSha: ungated.resolvedSha,
        domain: master.domain,
        builds: ungated.builds,
        ungated,
      };
      // A registered unit's builds are attested again, and rendered, before its release (build-unit-attest.ts).
      if (unit.registered) await attestBuildsAgain(ctx, ports, unit.unit, ungated.builds);
      const release: ReleaseCycleRuntime = {};
      const chain: Step[] = unit.registered
        ? [triggerReleaseStep(ports, params), watchReleaseBuildStep(ports, params, release), recordBuildOnlyStep(ports, params, release)]
        : buildOnlySteps(ports, params, release);
      for (const step of chain) {
        ctx.log("meta", `${unit.unit}: ${step.title}`);
        await step.run(ctx);
      }
      ctx.log("meta", `build unit ${unit.unit} done — ${unit.images.join(", ")} built and pinned for ${p.stage} on the books branch`);
    },
  };
}

export interface RefreshImagesPorts {
  repo: RepoReader;
  helm: HelmRenderer;
  registrations: { branch: string };
  catalogRepoUrl: string;
  catalogCredentialId?: string;
  resolveClusterValueFiles: (domain: string, stage: Stage) => Promise<ClusterValueFile[]>;
  attestedBuilds: () => Promise<{ unit: string; build: string }[]>;
}

export interface RefreshImagesParams {
  guid: string;
  domain: string;
  stage: Stage;
  subdomain: string;
  apps: ValidateTenantRequest["apps"];
  seedUsers: boolean;
  registryHost: string;
  requiredImages: readonly RequiredImage[];
  /** The tenant's own apps bundle, rendered at the tag the apps-repo steps read off its release. */
  appsImage?: string | undefined;
}

/** After the builds: the fan-out rendered again against the books branch, where the bumps wrote the
 *  pins, and with the bundle at the tag its release stated, so the image set ensure-images probes and
 *  the sync units the argo-sync grant names are the ones the cluster will pull and attest. The plan's
 *  frozen set was the trunk's for every image not yet built and the placeholder for the bundle; the
 *  difference is logged tag by tag. */
export function refreshImagesStep(ports: RefreshImagesPorts, p: RefreshImagesParams, runtime: TenantBuildRuntime): Step {
  return {
    name: "refresh-images",
    title: "Render the fan-out again against the pins the builds wrote",
    run: async (ctx) => {
      const clusterValueFiles = await ports.resolveClusterValueFiles(p.domain, p.stage);
      const appsImageTag = runtime.appsImageTag;
      // A pass resumed after onboard-build-only has no tag in memory: the bundle would render at no
      // tag at all and the probe would name an image that cannot exist. Refused, naming the retry.
      if (p.appsImage !== undefined && appsImageTag === undefined) {
        throw errValidation(`the tag the apps bundle ${p.appsImage} was built at is not in this pass's memory — onboard-build-only reads it off the release; retry from that step`);
      }
      const outcome = await validateTenant(
        {
          repoURL: ports.catalogRepoUrl,
          ref: ports.registrations.branch,
          stage: p.stage,
          apps: p.apps,
          probeGuid: p.guid,
          subdomain: p.subdomain,
          seedUsers: p.seedUsers,
          clusterValueFiles,
          ...(p.appsImage !== undefined ? { appsImage: p.appsImage } : {}),
          ...(appsImageTag !== undefined ? { appsImageTag } : {}),
          ...(ports.catalogCredentialId ? { credentialId: ports.catalogCredentialId } : {}),
        },
        { repo: ports.repo, helm: ports.helm, log: (l) => ctx.log("meta", l), signal: ctx.signal },
      );
      if (outcome.verdict !== "pass") {
        const failed = outcome.report.gates.filter((g) => g.status !== "pass").map((g) => g.id);
        throw errValidation(`the fan-out no longer validates after the builds wrote their pins — ${failed.join(", ")} did not pass; read the gate lines above`);
      }
      const requiredImages = requiredImagesFrom(outcome.images, p.registryHost);
      const syncUnits = tenantSyncUnits(requiredImages, await ports.attestedBuilds());
      runtime.requiredImages = requiredImages;
      runtime.syncUnits = syncUnits;
      const before = new Map(p.requiredImages.map((i) => [i.repo, i.tag]));
      const moved = requiredImages.filter((i) => before.get(i.repo) !== i.tag).map((i) => `${i.repo}: ${before.get(i.repo) ?? "(new)"} -> ${i.tag}`);
      ctx.checkpoint({ requiredImages, syncUnits, moved });
      ctx.log(
        "meta",
        `${requiredImages.length} required image(s) re-read off the books branch — ` +
          (moved.length > 0 ? `${moved.length} pinned by the builds: ${moved.join("; ")}` : "no tag moved") +
          `; argo-sync units: ${syncUnits.length > 0 ? syncUnits.join(", ") : "none"}`,
      );
    },
  };
}

/** The image steps after the builds: the fan-out rendered again where a build unit or the apps-repo
 *  steps ran, then the probe of the set that render left behind — the plan's frozen set where
 *  nothing was built. */
export function tenantImageSteps(
  ports: RefreshImagesPorts & { registryProbe: RegistryProbe },
  p: RefreshImagesParams & { buildUnits?: readonly BuildUnit[] },
  runtime: TenantBuildRuntime,
): Step[] {
  const built = (p.buildUnits ?? []).length > 0 || p.appsImage !== undefined;
  return [
    ...(built ? [refreshImagesStep(ports, p, runtime)] : []),
    ensureImagesStep(ports, { registryHost: p.registryHost, get requiredImages() { return runtime.requiredImages ?? p.requiredImages; } }),
  ];
}

/** The tenant's scoped argo-sync grant, over the sync units as they stand after the builds. */
export function provisionArgoSyncStep(
  ports: { resolver: ClusterKubeResolver; buildRbac: BuildRbacWriter },
  p: { guid: string; clusterId: string; expectedApps: readonly string[]; syncUnits: readonly string[] },
  runtime: TenantBuildRuntime,
): Step {
  return {
  name: "provision-argo-sync",
    title: "Provision the tenant's scoped argo-sync grant",
    run: async (ctx) => {
      const syncUnits = runtime.syncUnits ?? p.syncUnits;
      // Beside the AppProjects and before the registration, in the same ArgoCD namespace: the grant
      // is what lets a release of a platform unit sync the pin it just bumped into this tenant,
      // instead of leaving the new image to ArgoCD's next poll. resourceNames name THIS tenant's
      // member Applications and no others, so a release syncing one tenant cannot touch a sibling.
      // No registerCleanup — the shared teardown armed at record-provisional deletes it beside the
      // member AppProjects. Idempotent on resume (the writer replaces both objects in place).
      const { argoNamespace } = await ports.resolver.resolve(p.clusterId);
      const syncGrant = renderTenantArgoSync({ guid: p.guid, applications: p.expectedApps, argoNamespace, units: syncUnits });
      const { created } = await ports.buildRbac.applyBuildRbac([syncGrant]);
      ctx.checkpoint({ argoSync: `${argoNamespace}/${syncGrant.role.metadata.name}`, units: syncUnits, created });
      ctx.log(
        "meta",
        syncUnits.length > 0
          ? `argo-sync grant ${syncGrant.role.metadata.name} applied in ${argoNamespace} over ${p.expectedApps.length} Application(s) — the release pipelines of ${syncUnits.join(", ")} may sync this tenant and no other`
          : `argo-sync grant ${syncGrant.role.metadata.name} applied in ${argoNamespace} over ${p.expectedApps.length} Application(s) with NO subject — no registered unit attests a build this tenant pins, so every bump reaches it on ArgoCD's own poll`,
      );
    },
  }
}
