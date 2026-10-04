import type { Stage } from "./enums.ts";

/** Test stays off its tenant's production machine; dev has no additional placement restriction. */
export function tenantStagesNeedSeparateMachines(stage: Stage, sibling: Stage): boolean {
  return (stage === "test" && sibling === "prod") || (stage === "prod" && sibling === "test");
}
