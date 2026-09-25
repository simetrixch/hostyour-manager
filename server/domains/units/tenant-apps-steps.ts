// The tenant's OWN apps repository, as ONE implementation two run kinds share: `tenant-create` runs
// these steps after the platform build units and before its own writes, `tenant-apps-repo` runs
// them for a standing tenant. The repository `<org>/<bundle>-<subdomain>` is created through the
// platform's GitHub App, its tree written from the catalog's apps template with the apps the tenant
// chose, and the unit onboarded Build-only with a `github-app` credential — one that stores no
// token and mints a fresh installation token from the App at every open — building the first
// image. The tag the release built lands in the runtime the caller hands in.
//
// The plan half stands here too (resolveTenantAppsUnit): the refusals a plan makes before either run
// kind freezes its params, each a sentence the operator acts on, and the four facts both freeze.
//
// IDEMPOTENT, by construction of each step: a repository that stands is found, not failed on; a
// second run adds the folders and entries the repository lacks and removes nothing, committing only
// when something changed; a unit already registered build-only has its release re-run rather than
// being onboarded again.
import { z } from "zod";
import { parse as parseYaml } from "yaml";
import type { Step, StepCtx } from "../../executor/types.ts";
import type { Stage } from "../../../shared/enums.ts";
import { CONSUMER_MANIFEST_PATH, ConsumerManifestSchema, consumerName, tenantAppsTemplate, type ConsumerManifest, type TenantSpec } from "../../../shared/consumer.ts";
import { APPS_MANIFEST_PATH, parseAppsManifest } from "../../../shared/apps-manifest.ts";
import { errValidation } from "../../kernel/errors.ts";
import type { GitHubApp } from "../../adapters/github-app/port.ts";
import type { TenantOnboardPorts } from "./create-tenant.run.ts";
import { TENANT_MANIFEST_PATH } from "./gates/tenant-gates.ts";
import { DEFAULT_BRANCH_HEAD } from "#unit/server/build-chain.ts";
import { buildOnlySteps, type BuildOnlyParams } from "#unit/server/build-chain.ts";
import { readUngatedOnboard } from "#unit/server/ungated-build.ts";
import { resolveNextVersion } from "#unit/server/release-version.ts";
import { resolveMasterCluster } from "../inventory/read.ts";
import { channelReaching } from "./tenant-builds.ts";
import { triggerReleaseStep, watchReleaseBuildStep, type ReleaseCycleRuntime } from "#unit/server/release-cycle.ts";
import { recordBuildOnlyStep } from "#unit/server/build-registration.ts";
import { refreshRepoPatStep } from "#unit/server/seed-repo-pat.ts";
import { mergeAppsManifest, readTemplateTree, tenantAppsManifest, tenantAppsRepoURL, tenantAppsUnit } from "./tenant-apps-tree.ts";
import { ADD_APP_FORM, npmrcPackageScopes, packagesReaderMissing, type OwnerIdentityReader } from "#unit/server/repo-identity.ts";
import { appIdentityRowId } from "../../security/app-identity.ts";
import { probeAppsRepository } from "./tenant-probes.ts";

const repoURL = z.string().regex(/^https:\/\/[^ ]+\.git$/);

/** The sentence every plan that needs the App and finds none answers with. */
export const NO_GITHUB_APP = "this Manager holds no GitHub App identity: set GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID and GITHUB_APP_PRIVATE_KEY (Vault <stage>/app/github-app) and restart it";

/** The four facts a plan resolves about the tenant's apps unit and both run kinds freeze. */
export const TenantAppsUnitSchema = z.object({
  // The owner the App is installed in — the catalog's `tenant.appsOrg` where it names one,
  // held equal to the installation's at the plan. The repository is `<org>/<bundle>-<subdomain>`.
  org: z.string().min(1),
  // The template: the catalog's `tenant.appsRepo` and `tenant.appsBundle` — the repository the tree
  // is copied from, and the entry of its manifest whose containerfile the tenant's own build takes.
  templateRepoURL: repoURL,
  templateBuild: z.string().regex(/^[a-z0-9-]+$/),
  // The unit already stands registered build-only on this installation (a second run): its release
  // is re-run through the registered chain instead of the whole onboarding.
  registered: z.boolean(),
});
export type TenantAppsUnit = z.infer<typeof TenantAppsUnitSchema>;

/** What the three steps read: the unit's facts and the tenant's own identity. */
export interface TenantAppsStepParams extends TenantAppsUnit {
  subdomain: string;
  guid: string;
  stage: Stage;
  owner: string;
  /** The chosen apps' NAMES: only the names shape the repository. */
  apps: readonly string[];
}

/** In-run memory of one execute() pass: the id of the `github-app` credential sealed for the unit,
 *  and the image tag the bundle's release built (read off its PipelineRun, plugins/unit/server/release-cycle.ts).
 *  A resumed pass seals afresh — the id sealed before is not in its memory — and carries no tag,
 *  which the step that needs it refuses rather than guessing one. */
export interface TenantAppsRepoRuntime {
  appsRepoCredentialId?: string;
  appsImageTag?: string;
}

export function requireGitHubApp(ports: TenantOnboardPorts): GitHubApp {
  if (!ports.githubApp) throw errValidation(NO_GITHUB_APP);
  return ports.githubApp;
}

/** The credential the tenant's own repository is reached with: the App's one row (repo-identity.ts
 *  appIdentityRowId, #226) — the repository is created under the App and the App reaches it by
 *  construction, so nothing is judged and nothing is sealed per unit. The store mints a fresh
 *  installation token from the App at every open, so nothing expires and no token reaches params. */
async function appCredentialId(ctx: StepCtx, runtime: TenantAppsRepoRuntime): Promise<string> {
  if (runtime.appsRepoCredentialId) return runtime.appsRepoCredentialId;
  const id = await appIdentityRowId(ctx.creds);
  if (!id) throw errValidation("this Manager holds no row for the platform's GitHub App — boot seeds it (ensureAppIdentityRow)");
  runtime.appsRepoCredentialId = id;
  return id;
}

/** The template's two files these steps read: its apps.yaml (which apps it offers) and its manifest
 *  (how its bundle is built). Cloned the way the catalog reads it (app-catalog.ts readAppsManifest):
 *  at its default branch head, with the catalog's own credential — the template is no unit and has
 *  no credential of its own. */
async function readTemplate(ports: TenantOnboardPorts, templateRepoURL: string, signal: AbortSignal): Promise<{ appsYaml: string; npmrc: string | null; manifest: ConsumerManifest; folders: (app: string) => Promise<boolean>; tree: (chosen: readonly string[]) => Promise<{ path: string; content: string }[]>; dispose: () => Promise<void> }> {
  const repo = ports.repo;
  const cloned = await repo.cloneAtRef({ repoURL: templateRepoURL, ref: DEFAULT_BRANCH_HEAD, ...(ports.catalogCredentialId ? { credentialId: ports.catalogCredentialId } : {}), signal });
  try {
    const appsYaml = await repo.readFile(cloned.workdir, APPS_MANIFEST_PATH);
    if (appsYaml === null) throw errValidation(`${templateRepoURL} carries no ${APPS_MANIFEST_PATH} at its default branch — nothing says which apps the template offers`);
    const manifestText = await repo.readFile(cloned.workdir, CONSUMER_MANIFEST_PATH);
    if (manifestText === null) throw errValidation(`${templateRepoURL} carries no ${CONSUMER_MANIFEST_PATH} at its default branch — the tenant's manifest is composed from it`);
    const manifest = ConsumerManifestSchema.safeParse(parseYaml(manifestText));
    if (!manifest.success) throw errValidation(`${CONSUMER_MANIFEST_PATH} in ${templateRepoURL} is not a valid consumer manifest: ${manifest.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
    const templateApps = parseAppsManifest(appsYaml).apps.map((a) => a.name);
    return {
      appsYaml,
      npmrc: await repo.readFile(cloned.workdir, ".npmrc"),
      manifest: manifest.data,
      folders: async (app) => (await repo.listDir(cloned.workdir, app)).length > 0,
      tree: (chosen) => readTemplateTree(repo, cloned.workdir, { templateApps, chosen }),
      dispose: () => repo.dispose(cloned.workdir),
    };
  } catch (e) {
    await repo.dispose(cloned.workdir);
    throw e;
  }
}

/** THE PLAN'S HALF: the refusals, each a sentence the operator acts on, then the template read once
 *  for what it offers, then the four facts. The caller hands in the catalog's tenant spec as it read
 *  it (null where the catalog declares none) and has checked the App is wired. */
export async function resolveTenantAppsUnit(
  ports: TenantOnboardPorts,
  input: { subdomain: string; chosen: readonly string[]; spec: TenantSpec | null; owners: OwnerIdentityReader; signal: AbortSignal; log: (line: string) => void },
): Promise<{ outcome: "resolved"; unit: TenantAppsUnit } | { outcome: "refused"; why: string }> {
  const refuse = (why: string) => ({ outcome: "refused" as const, why });
  if (!input.spec) return refuse(`the catalog ${ports.catalogRepoUrl} declares no tenant fan-out in ${TENANT_MANIFEST_PATH} on ${ports.registrations.branch}`);
  const org = await requireGitHubApp(ports).installationOrg(input.signal);
  if (input.spec.appsOrg !== undefined && input.spec.appsOrg !== org) return refuse(`the catalog's tenant.appsOrg is "${input.spec.appsOrg}" and the GitHub App is installed in "${org}" — the repository would be created where the App has no rights; install the App in ${input.spec.appsOrg} or correct the catalog`);
  const template = tenantAppsTemplate(input.spec);
  if (!template) return refuse(`the catalog declares no tenant.appsBundle and tenant.appsRepo in ${TENANT_MANIFEST_PATH} — the template a tenant's repository is created from`);
  const unit = tenantAppsUnit(template.name, input.subdomain);
  if (!consumerName.safeParse(unit).success) return refuse(`"${unit}" is not a unit name (lower-case letters, digits and hyphens, at most 40 characters) — choose a shorter subdomain`);
  input.log(`template ${template.repo} (${template.name}), owner ${org}, repository ${tenantAppsRepoURL(org, template.name, input.subdomain)}`);
  const read = await readTemplate(ports, template.repo, input.signal);
  let offered: string[];
  const unfolded: string[] = [];
  try {
    offered = parseAppsManifest(read.appsYaml).apps.map((a) => a.name);
    // The bundle's build installs what the template's .npmrc routes to GitHub Packages with the
    // owner's packages reader (#220, #221) — asked here, before anything is created.
    const scopes = npmrcPackageScopes(read.npmrc);
    if (scopes.length > 0 && !input.owners(org)?.packagesCredentialId) return refuse(packagesReaderMissing(org, unit, scopes, ADD_APP_FORM));
    for (const app of input.chosen) if (offered.includes(app) && !(await read.folders(app))) unfolded.push(app);
    if (!read.manifest.builds.some((b) => b.name === template.name)) return refuse(`${template.repo} declares no build named ${template.name} in its ${CONSUMER_MANIFEST_PATH} — the tenant's build takes its containerfile from that entry`);
  } finally {
    await read.dispose();
  }
  const unknown = input.chosen.filter((a) => !offered.includes(a));
  if (unknown.length > 0) return refuse(`${unknown.join(", ")} ${unknown.length === 1 ? "is" : "are"} not in the template's ${APPS_MANIFEST_PATH} (it offers ${offered.join(", ") || "nothing"})`);
  if (unfolded.length > 0) return refuse(`${unfolded.join(", ")} ${unfolded.length === 1 ? "has" : "have"} no folder in ${template.repo} although its ${APPS_MANIFEST_PATH} names ${unfolded.length === 1 ? "it" : "them"} — the bundle would refuse to build`);
  const registration = (await ports.buildUnitRegistration?.(unit)) ?? null;
  if (registration?.form === "deployable") return refuse(`the unit ${unit} is registered as DEPLOYABLE on this installation — a tenant's apps repository is a build-only unit; offboard that unit first`);
  return { outcome: "resolved", unit: { org, templateRepoURL: template.repo, templateBuild: template.name, registered: registration !== null } };
}

/** The three steps, in order: create-repository, write-tree, onboard-build-only. The build plane is
 *  the master, resolved at run time the way buildUnitStep resolves it for a platform build unit. */
export function tenantAppsRepoSteps(ports: TenantOnboardPorts, p: TenantAppsStepParams, runtime: TenantAppsRepoRuntime): Step[] {
  // Read defensively: the armed check evaluates def.steps({}) with no params at all.
  const unit = tenantAppsUnit(p.templateBuild ?? "", p.subdomain ?? "");
  const url = tenantAppsRepoURL(p.org ?? "", p.templateBuild ?? "", p.subdomain ?? "");
  const chosen = p.apps ?? [];
  return [
    {
      name: "create-repository",
      title: `Create the private repository ${unit}`,
      probe: (ctx) => probeAppsRepository(ports, { org: p.org ?? "", templateRepoURL: p.templateRepoURL ?? "", bundle: p.templateBuild ?? "", subdomain: p.subdomain ?? "" }, ctx),
      run: async (ctx) => {
        const app = requireGitHubApp(ports);
        const { created } = await app.createRepository({ org: p.org, name: unit, description: `The apps of tenant ${p.subdomain} (${p.guid}), created from the catalog's ${p.templateBuild}`, private: true, signal: ctx.signal });
        ctx.checkpoint({ repoURL: url, created });
        ctx.log("meta", created ? `repository ${url} created, private` : `repository ${url} already stands — left as it is, the tree below adds what it lacks`);
      },
    },
    {
      name: "write-tree",
      title: `Write the tree of ${unit} from the catalog's ${p.templateBuild}`,
      run: async (ctx) => {
        const writer = ports.onboard?.()?.ports.consumerRepo;
        if (!writer) throw errValidation(`${unit} needs the consumer repository writer to commit its tree, and the consumer onboarding is not wired on this manager — the gate-runner and the git/kube/vault adapters must be wired first`);
        const credentialId = await appCredentialId(ctx, runtime);
        const template = await readTemplate(ports, p.templateRepoURL, ctx.signal);
        let files: { path: string; content: string }[];
        try {
          files = await template.tree(chosen);
        } finally {
          await template.dispose();
        }
        const build = template.manifest.builds.find((b) => b.name === p.templateBuild);
        if (!build) throw errValidation(`${p.templateRepoURL} declares no build named ${p.templateBuild} in its ${CONSUMER_MANIFEST_PATH} — the tenant's build takes its containerfile from that entry`);
        const session = await writer.open({ repoURL: url, credentialId, signal: ctx.signal });
        try {
          // A path that stands is left as it stands, whatever it says: this run ADDS what the
          // repository lacks and never overwrites or removes — the repository is the tenant's.
          const write: { path: string; content: string }[] = [];
          for (const f of files) if ((await writer.readFile(session.workdir, f.path)) === null) write.push(f);
          if ((await writer.readFile(session.workdir, CONSUMER_MANIFEST_PATH)) === null) {
            write.push({ path: CONSUMER_MANIFEST_PATH, content: tenantAppsManifest({ unit, owner: p.owner, envs: template.manifest.envs, containerfile: build.containerfile, context: build.context }) });
          }
          const current = await writer.readFile(session.workdir, APPS_MANIFEST_PATH);
          const merged = mergeAppsManifest(template.appsYaml, current, chosen);
          if (current === null || merged.added.length > 0) write.push({ path: APPS_MANIFEST_PATH, content: merged.content });
          if (write.length === 0) {
            ctx.checkpoint({ repoURL: url, branch: session.branch, files: 0, added: [] });
            ctx.log("meta", `${url} already carries every file of the template and every chosen entry (${chosen.join(", ")}) — nothing to commit`);
            return;
          }
          const message = current === null ? `Create ${unit} from the catalog` : `Add ${merged.added.join(", ")} to ${unit} from the catalog`;
          const { commit } = await writer.commitPush({ workdir: session.workdir, branch: session.branch, credentialId, message, write, signal: ctx.signal });
          ctx.checkpoint({ repoURL: url, branch: session.branch, commit, files: write.length, added: merged.added });
          ctx.log("meta", `${write.length} file(s) committed to ${url} on ${session.branch} (${commit}) — apps ${merged.added.join(", ") || "(none added)"}; the release kit follows with the onboarding`);
        } finally {
          await writer.dispose(session.workdir);
        }
      },
    },
    {
      name: "onboard-build-only",
      title: `Onboard ${unit} build-only and build its first image`,
      run: async (ctx) => {
        const d = ports.onboard?.();
        if (!d) throw errValidation(`${unit} needs the consumer onboarding's build-only chain, and it is not wired on this manager — the gate-runner and the git/kube/vault adapters must be wired first`);
        const onboard = d.ports;
        if (!onboard.github) throw errValidation(`${unit} needs the GitHub consumer client to read its release tags, and none is wired on this manager`);
        const credentialId = await appCredentialId(ctx, runtime);
        const master = resolveMasterCluster(ctx.db);
        const token = await ctx.creds.open(credentialId, { purpose: "tenant-apps-repo:release-version", runId: ctx.runId });
        let version: string;
        try {
          ({ version } = await resolveNextVersion(
            { github: onboard.github, ...(d.platformGitHub ? { platformGitHub: d.platformGitHub } : {}), ...(d.platformRepo ? { platformRepo: d.platformRepo } : {}) },
            { repoURL: url, token: token.toString("utf8"), signal: ctx.signal },
          ));
        } finally {
          token.fill(0);
        }
        const channel = channelReaching(await onboard.channelStages(), p.stage);
        // Read the way the tenant's build units are read (tenant-builds.ts): the manifest this run
        // wrote a step ago, refused unless it declares the build-only shape. The image it builds is
        // mounted by a fan-out the tenant gates judge at the plan.
        const ungated = await readUngatedOnboard(
          { repo: onboard.repo, log: (l) => ctx.log("meta", `${unit}: ${l}`), signal: ctx.signal },
          { repoURL: url, ref: DEFAULT_BRANCH_HEAD, consumerName: unit, repoCredentialId: credentialId },
          { cluster: master.domain, admittedBy: [`apps repository of tenant ${p.guid}, created by this run from the catalog's ${p.templateBuild}; its manifest was written by this run and its image is mounted by a fan-out the tenant gates judge`] },
        );
        const params: BuildOnlyParams = {
          form: "build-only", consumerName: unit, repoURL: url, repoCredentialId: credentialId, owner: p.owner,
          version, channel, stage: p.stage, resolvedSha: ungated.resolvedSha, domain: master.domain, builds: ungated.builds, ungated,
        };
        // A registered unit's release re-run rewrites its build repo-pat first: the entry seeded at
        // the onboarding holds a token that died an hour later, and the pipeline's clone reads it.
        // The chain's scope preflight skips itself for the App credential (plugins/unit/server/preflight-scopes.ts).
        const release: ReleaseCycleRuntime = {};
        const chain: Step[] = p.registered
          ? [refreshRepoPatStep(onboard, params), triggerReleaseStep(onboard, params), watchReleaseBuildStep(onboard, params, release), recordBuildOnlyStep(onboard, params, release)]
          : buildOnlySteps(onboard, params, release);
        ctx.log("meta", `${unit}: version ${version}, channel ${channel}, release run on ${p.stage}, build plane ${master.domain} — ${p.registered ? "registered build-only, its release is re-run" : "onboarded build-only by this run"}`);
        // The chain's own cleanups (write-registration arms remove-build-registration and
        // remove-consumer-webhook) are the consumer onboarding's, and this run kind has no
        // implementation for them: the bundle is the tenant's and stays registered build-only on
        // an abort, so a later run finds it registered and re-releases it (#215).
        const chainCtx: StepCtx = { ...ctx, registerCleanup: () => undefined };
        for (const step of chain) {
          ctx.log("meta", `${unit}: ${step.title}`);
          await step.run(chainCtx);
        }
        // The bundle's tag is what its release's PipelineRun states (the `image-tag` result), and
        // nothing else names it: no chart's builds[] pins a tenant's bundle, so the registration
        // carries the tag.
        if (!release.imageTag) {
          throw errValidation(`the release PipelineRun of ${unit} states no image-tag result — the tag ${unit} was pushed under cannot be read, so the registration cannot carry it`);
        }
        runtime.appsImageTag = release.imageTag;
        ctx.checkpoint({ appsImage: unit, appsImageTag: release.imageTag });
        ctx.log("meta", `${unit} built as ${unit}:${release.imageTag} for ${p.stage} — the registration will carry that tag`);
      },
    },
  ];
}
