import { createHash } from "node:crypto";
import type { Plan } from "./types.ts";

/** The plan fingerprint frozen at approval: sha256 over the canonical
 *  {kind,targetId,steps,targets,locks,params}. Shared by the synchronous plan() path and the
 *  streaming planStreamed() path so both freeze the same shape. */
export function hashPlan(plan: Plan, params: Record<string, unknown>): string {
  const canonical = JSON.stringify({
    kind: plan.kind,
    targetId: plan.targetId,
    steps: plan.steps.map((s) => s.name),
    targets: plan.targets ?? null,
    locks: plan.locks ?? null,
    params,
  });
  return createHash("sha256").update(canonical).digest("hex");
}
