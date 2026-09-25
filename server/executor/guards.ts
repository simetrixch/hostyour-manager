import type { AnyRunDefinition } from "./types.ts";

/** The step name pinned as step 0 of every MUTATING run: its fail-closed precondition. Named once,
 *  here, because two places must key on the SAME string — the boot assertion below, which MAKES the
 *  invariant true for the whole run-definitions map, and Executor.skipStep, which RELIES on it to refuse the one
 *  step an operator may never wave through. */
export const ATTEST_TARGET_STEP = "attest-target";

/** Is `stepName` the fail-closed precondition of a MUTATING run — i.e. the step assertGuardsArmed
 *  guarantees is that run's step 0? The two facts are asked together because neither alone means
 *  anything: a NON-mutating def may legitimately carry a step of any name (nothing is pinned for it),
 *  and a mutating def's step 0 is pinned to exactly this name. Lives beside the assertion that
 *  establishes it, so the rule and its enforcement can never drift apart. */
export function isMutatingPrecondition(def: AnyRunDefinition | undefined, stepName: string): boolean {
  return def?.mutating === true && stepName === ATTEST_TARGET_STEP;
}

/** Backs the guards.armed self-check: every registered mutating def starts with attest-target. */
export function assertGuardsArmed(runDefinitions: Map<string, AnyRunDefinition>): void {
  for (const def of runDefinitions.values()) {
    if (!def.mutating) continue;
    if (def.steps({})[0]?.name !== ATTEST_TARGET_STEP) {
      throw new Error(`mutating run ${def.kind} must start with ${ATTEST_TARGET_STEP}`);
    }
  }
}
