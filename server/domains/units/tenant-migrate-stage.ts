import { eq } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { tenants } from "../../db/schema/inventory.ts";
import { errValidation } from "../../kernel/errors.ts";
import { TENANT_SETTLED_STATUS } from "../../../shared/enums.ts";
import { assertDeployState } from "#unit/server/lifecycle.ts";
import { assertMovableTo } from "#unit/server/relocation-target.ts";
import type { WorldOf } from "#unit/server/relocation.ts";
import type { Step, StepCtx } from "../../executor/types.ts";
import { attestTenantTargetStep, loadTenantCluster } from "./lifecycle.ts";
import { tenantWorld, type TenantRelocationPorts } from "./relocation-world-tenant.ts";
import type { TenantMigrateParams } from "./migrate.run.ts";

type StageMove = Extract<TenantMigrateParams, { stage: unknown }>;

function loadSource(db: Db, p: StageMove) {
  const source = loadTenantCluster(db, p.tenantId);
  if (source.stage !== p.stage) throw errValidation("the selected tenant stage changed — choose the stage and plan Move again");
  if (source.clusterId !== p.sourceClusterId) throw errValidation("the selected stage's source machine changed — plan Move again");
  return source;
}

export function loadTenantMove(db: Db, p: StageMove) {
  const source = loadSource(db, p);
  const rows = db.select().from(tenants).where(eq(tenants.guid, source.guid)).all();
  const row = rows.find((r) => r.id === p.tenantId)!;
  if (row.status !== "active" || row.suspended) throw errValidation("Move needs an active, unsuspended tenant stage");
  const target = assertMovableTo(db, source.clusterId, p.targetClusterId);
  if (rows.some((r) => r.id !== p.tenantId && r.clusterId === target.clusterId && !TENANT_SETTLED_STATUS.some((s) => s === r.status))) {
    throw errValidation("another stage of this tenant uses the target machine — choose a different machine");
  }
  return { source, target };
}

export function tenantMoveWorld(ports: TenantRelocationPorts, p: TenantMigrateParams): WorldOf {
  const world = tenantWorld(ports, p.tenantId);
  if (!("stage" in p)) return world;
  return async (ctx) => {
    // A crash can follow record's own transaction but precede the executor's success checkpoint.
    const row = ctx.db.select().from(tenants).where(eq(tenants.id, p.tenantId)).get();
    if (ctx.stepName === "record" && row?.stage === p.stage && row.clusterId === p.targetClusterId && row.lastRunId === ctx.runId) return world(ctx);
    loadTenantMove(ctx.db, p);
    return world(ctx);
  };
}

export function tenantMoveCleanupWorld(ports: TenantRelocationPorts, p: TenantMigrateParams): WorldOf {
  const world = tenantWorld(ports, p.tenantId);
  return async (ctx: StepCtx) => {
    if ("stage" in p) loadSource(ctx.db, p);
    return world(ctx);
  };
}

export function attestTenantMoveStep(ports: TenantRelocationPorts, p: TenantMigrateParams): Step {
  if (!("stage" in p)) return attestTenantTargetStep(ports, p.tenantId);
  return {
    name: "attest-target",
    title: "Attest the selected stage and both machines (deploy-state fresh)",
    run: async (ctx) => {
      const { target } = loadTenantMove(ctx.db, p);
      await attestTenantTargetStep(ports, p.tenantId).run(ctx);
      const { clusterReader } = await ports.resolver.resolve(target.clusterId);
      assertDeployState(await clusterReader.readDeployState(), target.domain, "tenant");
      ctx.log("meta", `Move ${p.stage}: source and target ${target.domain} attested; other stages stay in place`);
    },
  };
}
