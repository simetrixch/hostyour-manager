import { z } from "zod";
import { parse as parseYaml } from "yaml";
import type { RunDefinition, Step, Plan } from "../../executor/types.ts";
import { STAGE, type Stage } from "../../../shared/enums.ts";
import { appName, guid as guidSchema, subdomain as subdomainSchema } from "../../../shared/tenant.ts";
import { ConsumerManifestSchema, type TenantSpec } from "../../../shared/consumer.ts";
import { errValidation, errInternal } from "../../kernel/errors.ts";
import type { TenantOnboardPorts } from "./create-tenant.run.ts";
import { assertDeployState } from "./lifecycle.ts";
import { resolveMasterCluster } from "../inventory/read.ts";
import { TENANT_MANIFEST_PATH } from "./gates/tenant-gates.ts";
import { tenantLocks } from "./tenant-lifecycle.run.ts";
import { tenantAppsRepoURL, tenantAppsUnit } from "./tenant-apps-tree.ts";
import { NO_GITHUB_APP, resolveTenantAppsUnit, tenantAppsRepoSteps, TenantAppsUnitSchema, type TenantAppsRepoRuntime } from "./tenant-apps-steps.ts";
import { readOwnerIdentity } from "./owners.ts";

// The "tenant-apps-repo" Run: the tenant's OWN apps repository for a STANDING tenant — the same
// three steps tenant-create runs on the way (tenant-apps-steps.ts), between the build plane's
// attestation and the record on the tenant's registration. A fresh tenant gets its repository from
// tenant-create itself; this run kind is how a standing tenant gains one, or gains an app.
//
// mutating: true ⇒ steps()[0] MUST be attest-target (executor/guards.ts). The target is the master —
// the build plane the unit's `<unit>-build` namespace lives on — as it is for every build-only form.

/** What the route (or a hand-made request) sends. */
export const TenantAppsRepoRequest = z.object({
  subdomain: subdomainSchema,
  guid: guidSchema,
  stage: z.enum(STAGE),
  // The chosen apps. Only the NAMES shape the repository: a selection is the tenant's choice among
  // what an app offers and rides tenant-create, while the repository carries what the app offers
  // (its apps.yaml entry). Accepted here so one app list serves both runs.
  apps: z.array(z.object({ name: appName, selections: z.record(z.string(), z.boolean()).optional() })).min(1),
  // The manifest's owner: the tenant's owner where the caller knows it, else the subdomain.
  owner: z.string().min(1).optional(),
});
export type TenantAppsRepoRequest = z.infer<typeof TenantAppsRepoRequest>;

/** The frozen params: the request's identity fields plus what the plan resolved. */
export const TenantAppsRepoParams = z.object({
  subdomain: subdomainSchema,
  guid: guidSchema,
  stage: z.enum(STAGE),
  apps: z.array(appName).min(1),
  owner: z.string().min(1),
  ...TenantAppsUnitSchema.shape,
  // The master — the build plane this run's build-only onboarding acts on (attest-target).
  clusterId: z.string().startsWith("cls_"),
  domain: z.string().min(1),
});
export type TenantAppsRepoParams = z.infer<typeof TenantAppsRepoParams>;

/** The catalog's tenant spec off this installation's books branch — where `appsOrg`, `appsBundle`
 *  and `appsRepo` are stated (the same clone validateTenant makes). */
export async function readTenantSpec(ports: TenantOnboardPorts, ctx: { signal?: AbortSignal }): Promise<TenantSpec | null> {
  const cloned = await ports.repo.cloneAtRef({ repoURL: ports.catalogRepoUrl, ref: ports.registrations.branch, ...(ports.catalogCredentialId ? { credentialId: ports.catalogCredentialId } : {}), ...(ctx.signal ? { signal: ctx.signal } : {}) });
  try {
    const text = await ports.repo.readFile(cloned.workdir, TENANT_MANIFEST_PATH);
    if (text === null) return null;
    return ConsumerManifestSchema.parse(parseYaml(text)).tenant ?? null;
  } finally {
    await ports.repo.dispose(cloned.workdir);
  }
}

/** The record of the bundle on the tenant's registration, after its first build: appsRepo, appsImage
 *  and the tag read off the release. Composed by this run and by tenant-add-app where the tenant
 *  had no bundle yet (hostyour-manager#213). */
export function recordAppsRepoStep(ports: TenantOnboardPorts, p: { subdomain: string; guid: string; stage: Stage; org: string; bundle: string }, runtime: TenantAppsRepoRuntime): Step {
  const unit = tenantAppsUnit(p.bundle, p.subdomain);
  const url = tenantAppsRepoURL(p.org, p.bundle, p.subdomain);
  return {
    name: "record-apps-repo",
    title: "Record the apps repository, image and tag on the tenant's registration",
    run: async (ctx) => {
      const appsImageTag = runtime.appsImageTag;
      if (!appsImageTag) {
        throw errValidation(`the tag ${unit} was built at is not in this pass's memory — onboard-build-only reads it off the release and a resumed pass has none; the registration cannot name an image without its tag`);
      }
      const current = await ports.registrations.readTenant(p.stage, p.guid);
      if (!current) {
        ctx.checkpoint({ appsRepo: url, appsImage: unit, appsImageTag, registration: "absent" });
        ctx.log("meta", `tenant ${p.guid} has no registration at ${p.stage} yet — appsRepo ${url}, appsImage ${unit} and appsImageTag ${appsImageTag} ride this run's record; a tenant-create writes them`);
        return;
      }
      if (current.entry.appsRepo === url && current.entry.appsImage === unit && current.entry.appsImageTag === appsImageTag) {
        ctx.log("meta", `tenant ${p.guid}'s registration already names ${url} and ${unit}:${appsImageTag} — nothing to commit`);
        return;
      }
      const { commit } = await ports.registrations.setTenantAppsRepo(p.stage, p.guid, { appsRepo: url, appsImage: unit, appsImageTag }, ctx.runId);
      ctx.checkpoint({ commit, appsRepo: url, appsImage: unit, appsImageTag });
      ctx.log("meta", `tenant ${p.guid}'s registration now names ${url} and the image ${unit}:${appsImageTag} (${commit}) — its fan-out mounts the tenant's own bundle from here on`);
    },
  };
}

function standaloneSteps(ports: TenantOnboardPorts, p: TenantAppsRepoParams): Step[] {
  // Read defensively: the armed check evaluates def.steps({}) with no params at all.
  const unit = tenantAppsUnit(p.templateBuild ?? "", p.subdomain ?? "");
  const runtime: TenantAppsRepoRuntime = {};
  return [
    {
      name: "attest-target",
      title: "Attest the build plane (deploy-state fresh)",
      run: async (ctx) => {
        const { clusterReader } = await ports.resolver.resolve(p.clusterId);
        const state = assertDeployState(await clusterReader.readDeployState(), p.domain, unit);
        ctx.log("meta", `build plane ${p.domain} attested for ${unit} — deploy-state generation ${state.generation}`);
      },
    },
    ...tenantAppsRepoSteps(ports, p, runtime),
    recordAppsRepoStep(ports, { subdomain: p.subdomain ?? "", guid: p.guid ?? "", stage: p.stage ?? "prod", org: p.org ?? "", bundle: p.templateBuild ?? "" }, runtime),
  ];
}

export function makeTenantAppsRepoDef(ports: TenantOnboardPorts): RunDefinition<TenantAppsRepoParams> {
  return {
    kind: "tenant-apps-repo",
    paramsSchema: TenantAppsRepoParams,
    mutating: true, // mutating ⇒ steps()[0] MUST be attest-target, asserted at boot
    plan: () => {
      throw errInternal("tenant-apps-repo is planned via planStream (the streaming entrypoint), not plan()");
    },
    // Streaming planner: the refusals, each a sentence the operator acts on, then the template read
    // once for what it offers, then the plan.
    planStream: async (rawParams, ctx) => {
      const req = TenantAppsRepoRequest.parse(rawParams);
      const chosen = req.apps.map((a) => a.name);
      const refuse = (why: string) => ({ outcome: "rejected" as const, summary: `The apps repository of tenant ${req.guid} ("${req.subdomain}") was refused — ${why}`, planJson: { subdomain: req.subdomain, apps: chosen } });
      if (!ports.githubApp) return refuse(NO_GITHUB_APP);
      const master = resolveMasterCluster(ctx.db);
      const resolved = await resolveTenantAppsUnit(ports, { subdomain: req.subdomain, chosen, spec: await readTenantSpec(ports, ctx), owners: (org) => readOwnerIdentity(ctx.db, org), signal: ctx.signal, log: ctx.log });
      if (resolved.outcome === "refused") return refuse(resolved.why);
      const unit = tenantAppsUnit(resolved.unit.templateBuild, req.subdomain);
      const params: TenantAppsRepoParams = {
        subdomain: req.subdomain, guid: req.guid, stage: req.stage, apps: chosen, owner: req.owner ?? req.subdomain,
        ...resolved.unit,
        clusterId: master.clusterId, domain: master.domain,
      };
      const stepDefs = standaloneSteps(ports, params);
      const plan: Plan = {
        kind: "tenant-apps-repo",
        targetKind: "cluster",
        targetId: master.clusterId, // the build plane — the one cluster this run touches
        summary: `Create ${params.org}/${unit} from ${params.templateRepoURL} with ${chosen.length} app(s) (${chosen.join(", ")}), onboard it build-only on ${req.stage} and build its first image: ${stepDefs.length} steps.${params.registered ? ` The unit is already registered build-only; its release is re-run.` : ""}`,
        steps: stepDefs.map((s) => ({ name: s.name, title: s.title })),
        targets: [], // no host owned — the Manager acts master-locally
        // The tenant registration rides the catalog's books branch, the unit's build registration
        // the platform repo's — one installation, one branch name in both, two locks by resource.
        locks: [...tenantLocks(ports.registrations), { resource: "git-branch", key: ports.registrations.branch }],
        warnings: [],
        requiredSecrets: [], // the App's token is minted by the Manager itself — nothing is asked at approve
      };
      return { outcome: "planned", params, plan };
    },
    steps: (params) => standaloneSteps(ports, params),
  };
}
