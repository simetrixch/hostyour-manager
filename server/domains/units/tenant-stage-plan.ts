import { and, eq } from "drizzle-orm";
import type { Cleanup, RunDefinition, Step, StepCtx } from "../../executor/types.ts";
import { tenants } from "../../db/schema/inventory.ts";
import { errValidation } from "../../kernel/errors.ts";
import type { Db } from "../../db/client.ts";
import { STAGE } from "../../../shared/enums.ts";
import { TENANT_LIVE_STATUS } from "./tenant-live-guard.ts";
import { CreateTenantParams, CreateTenantRequest, createTenantSteps, type CreateTenantStageParams, type TenantOnboardPorts } from "./create-tenant.run.ts";
import { createTenantCleanups, assertCreateTenantAbortable } from "./create-tenant-abort.ts";
import { mintFreeGuid } from "./create-tenant-registration.ts";
import { planStandingStage, stageBundleStep, stageHostsStep } from "./tenant-stage-source.ts";

export function bundleStageSteps(ports: TenantOnboardPorts, p: CreateTenantStageParams, runtime: { appsImageTag?: string }, steps: Step[]): Step[] {
  return p.bundleStage ? steps.map((step) => ({ ...step, run: async (ctx) => {
    if (p.appsImage && !runtime.appsImageTag && ["refresh-images", "ensure-images", "provision-argo-sync", "write-registration"].includes(step.name)) {
      const source = await ports.registrations.readTenant(p.bundleStage!, p.guid);
      if (!source?.entry.appsImageTag || source.entry.appsImage !== p.appsImage) throw errValidation(`the shared bundle for ${p.guid} is not yet registered at ${p.bundleStage}`);
      runtime.appsImageTag = source.entry.appsImageTag;
    }
    await step.run(ctx);
  } })) : steps;
}

function stageContext(ctx: StepCtx, p: CreateTenantStageParams, name: string): StepCtx {
  return { ...ctx, params: p, stepName: name, registerCleanup: (cleanup) => ctx.registerCleanup(scopedCleanup(p, cleanup)) };
}

function scopedCleanup(p: CreateTenantStageParams, cleanup: Cleanup): Cleanup {
  return { name: `${p.stage}-${cleanup.name}`, title: `${p.stage}: ${cleanup.title}`, run: async (ctx) => {
    if (completedStage(ctx.db, p)) { ctx.log("meta", `keeping completed ${p.stage} stage of tenant ${p.guid}`); return; }
    await cleanup.run(stageContext(ctx, p, cleanup.name));
  } };
}

function completedStage(db: Db, p: CreateTenantStageParams): boolean {
  const row = db.select({ status: tenants.status }).from(tenants).where(and(eq(tenants.guid, p.guid), eq(tenants.stage, p.stage))).get();
  return Boolean(row && TENANT_LIVE_STATUS.includes(row.status));
}

function stagePlans(p: CreateTenantParams): CreateTenantStageParams[] {
  return [p, ...(p.additionalStages ?? [])];
}

function composedSteps(ports: TenantOnboardPorts, p: CreateTenantParams): Step[] {
  if (!p.additionalStages && !p.sourceTenantId) return createTenantSteps(ports, p);
  const stages = stagePlans(p);
  const activations: Step[] = [];
  return [
    {
      name: "attest-target", title: "Attest every selected machine and stage identity",
      run: async (ctx) => {
        for (const stage of stages) {
          await createTenantSteps(ports, stage)[0]!.run(stageContext(ctx, stage, "attest-target"));
          const row = ctx.db.select({ lastRunId: tenants.lastRunId }).from(tenants).where(and(eq(tenants.guid, stage.guid), eq(tenants.stage, stage.stage))).get();
          const pointer = await ports.registrations.scanTenant(stage.stage, stage.guid);
          if ((row || pointer.status !== "absent") && row?.lastRunId !== ctx.runId) throw errValidation(`tenant ${stage.guid} already has a ${stage.stage} stage; no standing stage is replaced`);
          if (stage.sourceStage && stage.sourceRegistration) {
            const source = await ports.registrations.readTenant(stage.sourceStage, stage.guid);
            if (!source || JSON.stringify(source.entry) !== stage.sourceRegistration) throw errValidation(`tenant ${stage.guid} ${stage.sourceStage} changed after this Add stage plan; plan again before creating ${stage.stage}`);
          }
        }
      },
    },
    ...stages.flatMap((stage) => {
      const steps = createTenantSteps(ports, stage).slice(1);
      if (stage.sourceTenantId) {
        const beforeSeeds = steps.findIndex((step) => step.name === "seed-tenant-crypto");
        steps.splice(beforeSeeds, 0, stageBundleStep(ports, stage));
        const beforeRegistration = steps.findIndex((step) => step.name === "write-registration");
        steps.splice(beforeRegistration, 0, stageHostsStep(ports, stage));
      }
      const scoped = steps.map((step) => ({
        ...step, name: `${stage.stage}-${step.name}`, title: `${stage.stage}: ${step.title}`,
        run: (ctx: StepCtx) => step.run(stageContext(ctx, stage, step.name)),
      }));
      const activation = scoped.find((step) => step.name === `${stage.stage}-activate`);
      if (activation) activations.push(activation);
      return scoped.filter((step) => step !== activation);
    }),
    ...activations,
  ];
}

export function makeTenantStagesDef(
  ports: TenantOnboardPorts,
  stageDefinition: (ports: TenantOnboardPorts, guid?: string) => RunDefinition<CreateTenantStageParams>,
): RunDefinition<CreateTenantParams> {
  const single = stageDefinition(ports);
  return {
    ...single, paramsSchema: CreateTenantParams,
    planStream: async (raw, ctx) => {
      const request = CreateTenantRequest.parse(raw);
      if (!request.stages && !request.sourceTenantId) return single.planStream!(request, ctx);
      const placements = request.stages ?? [{ stage: request.stage, clusterId: request.clusterId }];
      // The broadest channel builds the shared bundle once and admits it to every selected stage.
      placements.sort((a, b) => STAGE.indexOf(b.stage) - STAGE.indexOf(a.stage));
      const guid = request.sourceTenantId ? undefined : await mintFreeGuid(ports);
      const results = [];
      for (const placement of placements) {
        ctx.log(`Planning ${placement.stage} on ${placement.clusterId}`);
        const result = request.sourceTenantId
          ? await planStandingStage(ports, request.sourceTenantId, placement, request, ctx)
          : await stageDefinition(ports, guid).planStream!({ ...request, ...placement }, ctx);
        if (result.outcome !== "planned") return result;
        results.push(result);
      }
      const first = results[0]!;
      const primary: CreateTenantStageParams = { ...first.params, appsStages: placements.map((p) => p.stage) };
      const params: CreateTenantParams = {
        ...primary,
        additionalStages: results.slice(1).map(({ params: stage }) => {
          const { appsUnit: _appsUnit, ...rest } = stage;
          return { ...rest, ...(stage.appsImage ? { bundleStage: primary.stage } : {}) };
        }),
      };
      const steps = composedSteps(ports, params);
      return { outcome: "planned", params, plan: {
        ...first.plan,
        summary: `${request.sourceTenantId ? "Add fresh stages to" : "Create"} tenant ${primary.guid} (${primary.subdomain}): ${results.map((r) => `${r.params.stage} on ${r.params.domain}`).join(", ")}. Each stage has fresh data, users, sessions and signing keys. ${primary.members.length} members per stage. Standing siblings are unchanged.${request.sourceTenantId ? "" : results.map((r) => ` ${r.plan.summary}`).join("")}`,
        steps: steps.map(({ name, title }) => ({ name, title })),
        warnings: results.flatMap((r) => r.plan.warnings),
        requiredSecrets: [...new Set(results.flatMap((r) => r.plan.requiredSecrets))],
      } };
    },
    steps: (p) => composedSteps(ports, p),
    cleanups: (p) => !p.additionalStages && !p.sourceTenantId ? createTenantCleanups(ports, p) : stagePlans(p).flatMap((stage) => createTenantCleanups(ports, stage).map((cleanup) => scopedCleanup(stage, cleanup))),
    assertAbortable: async (p, deps) => {
      const incomplete = stagePlans(p).filter((stage) => !completedStage(deps.db, stage));
      // A failed invite after all stages completed keeps the existing live-tenant refusal.
      if (!incomplete.length) await assertCreateTenantAbortable(ports, p, deps.db);
      for (const stage of incomplete) await assertCreateTenantAbortable(ports, stage, deps.db);
    },
  };
}
