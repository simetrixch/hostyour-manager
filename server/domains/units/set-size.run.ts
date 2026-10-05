import { z } from "zod";
import type { RunDefinition, Step, LockClaim } from "../../executor/types.ts";
import { eq } from "drizzle-orm";
import { UnitSizeSchema, TenantSizeSchema, TENANT_BRINGS, ONBOARDING_VOLUME, PartSizesSchema, dataParts, type PartSizes, type PartVolumes, type UnitSize } from "#unit/shared/unit-size.ts";
import { tenants } from "../../db/schema/inventory.ts";
import { errInternal, errNotFound, errValidation } from "../../kernel/errors.ts";
import { attestTargetStep, loadAppCluster, type LifecyclePorts } from "./lifecycle.ts";
import { attestTenantTargetStep, loadTenantCluster } from "./lifecycle.ts";
import { tenantLocks } from "./tenant-lifecycle.run.ts";
import { validateTenant } from "./validate-tenant.ts";
import type { TenantOnboardPorts } from "./create-tenant.run.ts";
import { resolveUnitQuota } from "#unit/server/unit-size.ts";
import type { UnitComposition } from "#unit/shared/unit-size.ts";
import type { ConsumerRegistration } from "#core/shared/consumer.ts";
import { gateUnitSize } from "./gates/compose.ts";
import type { Stage } from "../../../shared/enums.ts";


/** What a consumer brings, read off its own registration — the file that states what the unit IS.
 *  A resize changes the size and nothing else, so this is never asked again at resize time. Exported
 *  because the size PICKER has to compose the same figures the run will write: an operator choosing
 *  from the sizes must see what each costs THIS unit, not what the bare table says. */
export async function consumerComposition(
  registrations: Pick<LifecyclePorts["registrations"], "readRegistration">,
  ac: { stage: Stage; name: string },
): Promise<UnitComposition> {
  return compositionOf((await registrations.readRegistration(ac.stage, ac.name))?.entry);
}

const compositionOf = (entry: ConsumerRegistration | undefined): UnitComposition => ({
  postgresql: (entry?.services ?? []).includes("postgresql"),
  mongodb: entry?.mongodb ?? "shared",
  redis: entry?.redis ?? "shared",
});

/** What a consumer resize writes beside the quota: the application's size, each data part's — the one
 *  asked for, else the one it stands at (its own, else the unit's) — and each part's volume: the pin it
 *  has, else the preset volume of the size it stands at, which is what its claim was created with. The
 *  pin lands in the same commit as the first size change, so the appset never falls back to a new
 *  size's preset for a claim made at an old one. Neither map for a unit with no data part. */
export async function consumerSizing(
  registrations: Pick<LifecyclePorts["registrations"], "readRegistration">,
  ac: { stage: Stage; name: string },
  size: UnitSize,
  asked: PartSizes = {},
): Promise<{ brings: UnitComposition; sizing: { size: UnitSize; sizes?: PartSizes; volumes?: PartVolumes }; current: UnitSize | undefined }> {
  const entry = (await registrations.readRegistration(ac.stage, ac.name))?.entry;
  const brings = compositionOf(entry);
  const current = entry?.size;
  const parts = dataParts(brings);
  if (parts.length === 0) return { brings, sizing: { size }, current };
  const standing = (p: (typeof parts)[number]): UnitSize => entry?.sizes?.[p] ?? entry?.size ?? size;
  return {
    brings,
    sizing: {
      size,
      sizes: Object.fromEntries(parts.map((p) => [p, asked[p] ?? standing(p)])),
      volumes: Object.fromEntries(parts.map((p) => [p, entry?.volumes?.[p] ?? ONBOARDING_VOLUME[p][standing(p)]])),
    },
    current,
  };
}

// `set-size` / `tenant-set-size` — put a unit on a different size, or on the same size's NEW figures.
//
// WHY IT EXISTS. The size table says what `small` means; a unit's registration carries the figures it
// was written with. Those two are deliberately not the same thing: editing the table must not silently
// re-size every running customer, and re-sizing one customer must not require a table edit. This run kind
// is the bridge, and it is the ONLY way a table change reaches something already deployed.
//
// SO IT IS ALSO THE RE-APPLY. Asking for the size a unit already has is not a no-op: the run re-reads
// the table and writes what it says NOW. That is how an operator who raised `medium` moves the tenants
// standing on medium onto the new figures — one approved run per unit, each visible as its own commit,
// rather than one edit quietly moving twenty namespaces at once.
//
// WHAT IT DOES NOT DO. It rolls no pods and needs to roll none: a ResourceQuota is a namespace object,
// and the kubelet enforces the new ceiling as soon as ArgoCD applies it. What CAN happen is that a
// namespace already over the new ceiling keeps its running pods and refuses the NEXT one — Kubernetes
// never evicts to fit a quota — so the plan says so rather than letting "resized" read as "shrunk".

// `size` is the application's; `sizes` names a data part's own, and a part it does not name keeps the
// size it stands at.
export const SetSizeParams = z.object({ appId: z.string().startsWith("app_"), size: UnitSizeSchema, sizes: PartSizesSchema.optional() });
export type SetSizeParams = z.infer<typeof SetSizeParams>;

export const TenantSetSizeParams = z.object({ tenantId: z.string().startsWith("tnt_"), size: TenantSizeSchema });
export type TenantSetSizeParams = z.infer<typeof TenantSetSizeParams>;

/** How the plan describes the change, for both families. Written once because the sentence is the
 *  same act in both, and the two summaries would otherwise drift into saying different things about
 *  one mechanism. `scope` names what the figures bound — one namespace, or each member's. */
function summary(unit: string, where: string, size: UnitSize, scope: string, q: { requestsCpu: string; requestsMemory: string; limitsCpu: string; limitsMemory: string; pods: number; persistentVolumeClaims: number }): string {
  return (
    `Put ${unit} on ${where} at size "${size}": ${scope} is bounded at ${q.requestsCpu} CPU / ${q.requestsMemory} requested, ` +
    `${q.limitsCpu} CPU / ${q.limitsMemory} at the limit, ${q.pods} pods and ${q.persistentVolumeClaims} PVCs. ` +
    "The figures are read from the size table as it stands NOW and written into the registration, so asking for the size the unit already has re-applies the table's current numbers. " +
    "Nothing is rolled and nothing is evicted: Kubernetes applies the new ceiling to what is created FROM NOW ON, so a namespace already above a lowered ceiling keeps its running pods and is refused the next one."
  );
}

/** The data parts' sizes and the volumes they keep, in the consumer's summary. */
function partsSentence(sizing: { sizes?: PartSizes; volumes?: PartVolumes }): string {
  const parts = Object.entries(sizing.sizes ?? {}).map(([p, s]) => `${p} at "${s}" on its ${sizing.volumes?.[p as keyof PartVolumes] ?? "?"} volume`);
  return parts.length === 0 ? "" : ` Its data parts: ${parts.join(", ")}. A volume keeps the size it was created with: a resize changes CPU and memory only.`;
}

// ---- Consumer ----

function setSizeSteps(ports: LifecyclePorts, p: SetSizeParams): Step[] {
  return [
    attestTargetStep(ports, p.appId),
    {
      name: "write-size",
      title: "Write the size's figures into the consumer's registration",
      run: async (ctx) => {
        const ac = loadAppCluster(ctx.db, p.appId);
        // What the consumer brings is read off its OWN registration, not asked again: a resize
        // changes the size, never what the unit is made of.
        const { brings, sizing } = await consumerSizing(ports.registrations, ac, p.size, p.sizes);
        const quota = resolveUnitQuota(ctx.db, p.size, brings, sizing.sizes);
        const { commit } = await ports.registrations.setSize(ac.stage, ac.name, sizing, quota, ctx.runId);
        ctx.checkpoint({ commit, ...sizing, quota });
        ctx.log("meta", `${ac.name} sized "${p.size}" (${commit}) — the ArgoCD on ${ac.domain} applies the new ResourceQuota on its next sync`);
      },
    },
  ];
}

export function makeSetSizeDef(ports: LifecyclePorts): RunDefinition<SetSizeParams> {
  return {
    kind: "consumer-set-size",
    paramsSchema: SetSizeParams,
    mutating: true,
    plan: async (params, { db }) => {
      const ac = loadAppCluster(db, params.appId);
      const { brings, sizing } = await consumerSizing(ports.registrations, ac, params.size, params.sizes);
      const quota = resolveUnitQuota(db, params.size, brings, sizing.sizes);
      const g24 = gateUnitSize({ unitName: ac.name, size: params.size, brings, quota, ...(sizing.sizes !== undefined ? { sizes: sizing.sizes } : {}) });
      if (g24.status === "fail") throw errValidation(`G24 ${g24.reason ?? g24.found}`);
      const stepDefs = setSizeSteps(ports, params);
      return {
        kind: "consumer-set-size",
        targetKind: "app",
        targetId: params.appId,
        summary: summary(`consumer "${ac.name}"`, `${ac.domain} (${ac.stage})`, params.size, "its namespace", quota) + partsSentence(sizing),
        steps: stepDefs.map((s) => ({ name: s.name, title: s.title })),
        targets: [],
        // The BOOKS branch, where the consumer registrations stand, plus the consumer's own cluster
        // branch — the claim every run kind that commits a registration makes (suspend-resume.run.ts says
        // why the books lock comes first).
        locks: [
          { resource: "git-branch", key: ports.registrations.branch },
          { resource: "git-branch", key: ac.domain },
          { resource: "master-kube", key: "m" },
        ] satisfies LockClaim[],
        warnings: [],
        requiredSecrets: [],
      };
    },
    steps: (params) => setSizeSteps(ports, params),
  };
}

// ---- Tenant ----

function tenantSetSizeSteps(ports: TenantOnboardPorts, p: TenantSetSizeParams): Step[] {
  return [
    attestTenantTargetStep(ports, p.tenantId),
    {
      name: "write-size",
      title: "Write the size's figures into the tenant's registration",
      run: async (ctx) => {
        const tc = loadTenantCluster(ctx.db, p.tenantId);
        const quota = resolveUnitQuota(ctx.db, p.size, TENANT_BRINGS);
        const { commit } = await ports.registrations.setSize(tc.stage, tc.guid, p.size, quota, ctx.runId);
        ctx.db.update(tenants).set({ size: p.size, updatedAt: new Date() }).where(eq(tenants.id, p.tenantId)).run();
        ctx.checkpoint({ commit, size: p.size, quota });
        ctx.log("meta", `tenant ${tc.guid} sized "${p.size}" (${commit}) — EVERY member namespace gets these figures, and the ArgoCD on ${tc.domain} applies them on its next sync`);
      },
    },
  ];
}

/** The members are rendered as the tenant stands, at the size asked for, and held against the quota
 *  that size resolves to (T5): a size whose quota cannot hold the members' pods twice is refused here,
 *  before any registration names it. */
export function makeTenantSetSizeDef(ports: TenantOnboardPorts): RunDefinition<TenantSetSizeParams> {
  return {
    kind: "tenant-set-size",
    paramsSchema: TenantSetSizeParams,
    mutating: true,
    plan: () => { throw errInternal("tenant-set-size is planned via planStream (its members are rendered at the size), not plan()"); },
    planStream: async (raw, ctx) => {
      const params = TenantSetSizeParams.parse(raw);
      const tc = loadTenantCluster(ctx.db, params.tenantId);
      if (tc.members.length === 0) throw errValidation(`tenant ${tc.guid} has no members — there is no namespace to bound`);
      const current = await ports.registrations.readTenant(tc.stage, tc.guid);
      if (!current) throw errNotFound(`tenant ${tc.guid} has no registration at ${tc.stage}`);
      const quota = resolveUnitQuota(ctx.db, params.size, TENANT_BRINGS);
      const e = current.entry;
      const outcome = await validateTenant({
        repoURL: ports.deployRepoUrl, ref: ports.registrations.branch, stage: tc.stage,
        apps: e.apps, members: e.members, identityProvider: e.identityProvider, isStandingTenant: true,
        appDatabases: Object.fromEntries(e.apps.filter((a) => a.databases).map((a) => [a.name, a.databases!])),
        probeGuid: tc.guid, subdomain: e.subdomain, seedUsers: e.seedUsers, demo: e.demo === true,
        appsImage: e.appsImage, appsImageTag: e.appsImageTag, ownDomain: e.ownDomain, ownDomainRedirects: e.ownDomainRedirects,
        approvedTags: e.approvedTags, routing: e.routing, quota, size: params.size,
        clusterValueFiles: await ports.resolveClusterValueFiles(tc.domain, tc.stage),
        ...(ports.deployCredentialId ? { credentialId: ports.deployCredentialId } : {}),
      }, { repo: ports.repo, helm: ports.helm, log: ctx.log, signal: ctx.signal });
      if (outcome.verdict !== "pass") {
        const failed = outcome.report.gates.filter((g) => g.status !== "pass").map((g) => g.id).join(", ");
        return { outcome: "rejected", summary: `Sizing tenant ${tc.guid} "${params.size}" was rejected: ${failed}`, planJson: outcome.report };
      }
      const stepDefs = tenantSetSizeSteps(ports, params);
      return { outcome: "planned", params, plan: {
        kind: "tenant-set-size",
        targetKind: "tenant",
        targetId: params.tenantId,
        summary: summary(`tenant ${tc.guid}`, `${tc.domain} (${tc.stage})`, params.size, "EACH of its member namespaces", quota),
        steps: stepDefs.map((s) => ({ name: s.name, title: s.title })),
        targets: [],
        locks: tenantLocks(ports.registrations),
        warnings: [],
        requiredSecrets: [],
      } };
    },
    steps: (params) => tenantSetSizeSteps(ports, params),
  };
}
