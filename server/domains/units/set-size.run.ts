import { z } from "zod";
import type { RunDefinition, Step, LockClaim } from "../../executor/types.ts";
import { UnitSizeSchema, type UnitSize } from "../../../shared/unit-size.ts";
import { errValidation } from "../../kernel/errors.ts";
import { attestTargetStep, loadAppCluster, type LifecyclePorts } from "./lifecycle.ts";
import { attestTenantTargetStep, loadTenantCluster, type TenantLifecyclePorts } from "./lifecycle.ts";
import { tenantLocks } from "./tenant-lifecycle.run.ts";
import { resolveUnitQuota } from "./unit-size.ts";
import type { UnitComposition } from "../../../shared/unit-size.ts";
import type { Stage } from "../../../shared/enums.ts";

/** A tenant brings no database of its own: its members claim the cluster's shared MongoDB replica set
 *  and no tenant runs a PostgreSQL, so its quota is the base row alone. */
export const TENANT_BRINGS: UnitComposition = { postgresql: false, mongodb: "shared" };

/** What a consumer brings, read off its own registration — the file that states what the unit IS.
 *  A resize changes the size and nothing else, so this is never asked again at resize time. Exported
 *  because the size PICKER has to compose the same figures the run will write: an operator choosing
 *  from three sizes must see what each costs THIS unit, not what the bare table says. */
export async function consumerComposition(
  registrations: Pick<LifecyclePorts["registrations"], "readRegistration">,
  ac: { stage: Stage; name: string },
): Promise<UnitComposition> {
  const reg = await registrations.readRegistration(ac.stage, ac.name);
  const entry = reg?.entry;
  return {
    postgresql: (entry?.services ?? []).includes("postgresql"),
    mongodb: entry?.mongodb ?? "shared",
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

const SizeField = z.object({ size: UnitSizeSchema });

export const SetSizeParams = z.object({ appId: z.string().startsWith("app_") }).and(SizeField);
export type SetSizeParams = z.infer<typeof SetSizeParams>;

export const TenantSetSizeParams = z.object({ tenantId: z.string().startsWith("tnt_") }).and(SizeField);
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
        const quota = resolveUnitQuota(ctx.db, p.size, await consumerComposition(ports.registrations, ac));
        const { commit } = await ports.registrations.setQuota(ac.stage, ac.name, quota, ctx.runId);
        ctx.checkpoint({ commit, size: p.size, quota });
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
      const quota = resolveUnitQuota(db, params.size, await consumerComposition(ports.registrations, ac));
      const stepDefs = setSizeSteps(ports, params);
      return {
        kind: "consumer-set-size",
        targetKind: "app",
        targetId: params.appId,
        summary: summary(`consumer "${ac.name}"`, `${ac.domain} (${ac.stage})`, params.size, "its namespace", quota),
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

function tenantSetSizeSteps(ports: TenantLifecyclePorts, p: TenantSetSizeParams): Step[] {
  return [
    attestTenantTargetStep(ports, p.tenantId),
    {
      name: "write-size",
      title: "Write the size's figures into the tenant's registration",
      run: async (ctx) => {
        const tc = loadTenantCluster(ctx.db, p.tenantId);
        const quota = resolveUnitQuota(ctx.db, p.size, TENANT_BRINGS);
        const { commit } = await ports.registrations.setQuota(tc.stage, tc.guid, quota, ctx.runId);
        ctx.checkpoint({ commit, size: p.size, quota });
        ctx.log("meta", `tenant ${tc.guid} sized "${p.size}" (${commit}) — EVERY member namespace gets these figures, and the ArgoCD on ${tc.domain} applies them on its next sync`);
      },
    },
  ];
}

export function makeTenantSetSizeDef(ports: TenantLifecyclePorts): RunDefinition<TenantSetSizeParams> {
  return {
    kind: "tenant-set-size",
    paramsSchema: TenantSetSizeParams,
    mutating: true,
    plan: async (params, { db }) => {
      const tc = loadTenantCluster(db, params.tenantId);
      if (tc.members.length === 0) throw errValidation(`tenant ${tc.guid} has no members — there is no namespace to bound`);
      const quota = resolveUnitQuota(db, params.size, TENANT_BRINGS);
      const stepDefs = tenantSetSizeSteps(ports, params);
      return {
        kind: "tenant-set-size",
        targetKind: "tenant",
        targetId: params.tenantId,
        summary: summary(`tenant ${tc.guid}`, `${tc.domain} (${tc.stage})`, params.size, "EACH of its member namespaces", quota),
        steps: stepDefs.map((s) => ({ name: s.name, title: s.title })),
        targets: [],
        locks: tenantLocks(ports.registrations),
        warnings: [],
        requiredSecrets: [],
      };
    },
    steps: (params) => tenantSetSizeSteps(ports, params),
  };
}
