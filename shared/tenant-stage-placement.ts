import { TENANT_SETTLED_STATUS, type Stage } from "./enums.ts";

/** Test stays off its tenant's production machine; dev has no additional placement restriction. */
export function tenantStagesNeedSeparateMachines(stage: Stage, sibling: Stage): boolean {
  return (stage === "test" && sibling === "prod") || (stage === "prod" && sibling === "test");
}

/** The stage of the same tenant that forbids `stage` on `clusterId`, or undefined where none does.
 *  A stage that is offboarded or purged no longer stands on its machine, so it forbids nothing; a row
 *  without a status is a stage that is requested and not yet recorded, and it stands. */
export function findStagePlacementConflict<S extends { stage: Stage; clusterId: string; status?: string }>(
  siblings: readonly S[], stage: Stage, clusterId: string,
): S | undefined {
  return siblings.find((s) => s.clusterId === clusterId && tenantStagesNeedSeparateMachines(stage, s.stage) && !TENANT_SETTLED_STATUS.some((settled) => settled === s.status));
}
