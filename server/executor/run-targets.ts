import type { Plan, PlanSnapshot, RunTargetRef } from "./types.ts";

/** The run as these answers read it: what it targets and the plan it was approved with. */
type TargetedRun = { targetKind: string; targetId: string; plan: PlanSnapshot };

/** A plan that declares no targets and aims at one server owns that host; any other targets none. */
export function defaultTargets(plan: Plan): RunTargetRef[] {
  if (plan.targetKind === "server") return [{ serverId: plan.targetId, ownsHost: true, label: plan.targetId }];
  return [];
}

/** The server a run's default ctx.ssh() reaches: its target, or the host its plan says it owns. */
export function targetServerId(run: TargetedRun): string | undefined {
  if (run.targetKind === "server") return run.targetId;
  const targets = run.plan.targets ?? [];
  return targets.find((t) => t.ownsHost)?.serverId ?? targets[0]?.serverId;
}

/** Every target the run's plan declares — the gate for a non-default ctx.ssh(id) (deploy-slave per
 *  target server AND per address), and the address each host is reached on. Read off the FROZEN plan,
 *  so the transport a run was approved with is the transport it runs with. Falls back to the derived
 *  single owns-host target for a plan that declares no explicit targets. */
export function declaredTargets(run: TargetedRun): RunTargetRef[] {
  return run.plan.targets ?? defaultTargets(run.plan);
}
