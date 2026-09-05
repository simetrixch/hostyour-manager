import type { PlanGuard, PlannerDeps, AnyRunDefinition } from "./types.ts";
import type { RunKind } from "../../shared/enums.ts";

/**
 * Every run kind's plan-time guards, total over RUN_KIND — the Record type forces compile-time
 * exhaustiveness, so a new kind cannot forget to declare its guards.
 *
 * EVERY LIST IS EMPTY TODAY, and that is a fact about this build rather than a gap in it. The three
 * guards this table used to hold all asked the same first question — is `keystore.mode` `plaintext`?
 * — and returned unless it was. No booted manager answers yes: the composition root builds the
 * credential store with a Vault client where the installation configures one and with a local data
 * key where it does not (boot/wire.ts, jobs/registry-reaper.ts), and the manager chart configures
 * one unconditionally. `plaintext` is what a test that constructs the store with neither gets. A
 * guard that cannot refuse is read as a protection and is none, so the three went.
 */
export const KIND_GUARDS: Record<RunKind, readonly PlanGuard[]> = {
  noop: [],
  "cluster-deploy-slave": [],
  "cluster-redeploy": [],
  "cluster-remove-slave": [],
  "cluster-tailnet-disconnect": [],
  "cluster-tailnet-reconnect": [],
  "cluster-tailnet-rejoin": [],
  "cluster-tailnet-read": [],
  "cluster-password-login-disable": [],
  "cluster-password-login-enable": [],
  "cluster-operator-key-place": [],
  "cluster-operator-key-remove": [],
  "cluster-authorized-keys-read": [],
  "consumer-onboard": [],
  "consumer-suspend": [],
  "consumer-resume": [],
  "consumer-offboard": [],
  "consumer-purge": [],
  "consumer-restart-workloads": [],
  "consumer-set-size": [],
  "consumer-adopt": [],
  "consumer-backup": [],
  "consumer-restore": [],
  "consumer-migrate": [],
  "tenant-check": [],
  "tenant-create": [],
  "tenant-add-app": [],
  "tenant-remove-app": [],
  "tenant-suspend": [],
  "tenant-resume": [],
  "tenant-restart-workloads": [],
  "tenant-set-size": [],
  "tenant-offboard": [],
  "tenant-purge": [],
  "tenant-backup": [],
  "tenant-restore": [],
  "tenant-migrate": [],
};

export async function runGuards(kind: RunKind, params: unknown, deps: PlannerDeps): Promise<void> {
  for (const guard of KIND_GUARDS[kind]) await guard(params, deps);
}

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

/**
 * Backs the guards.armed self-check: every registered mutating def starts with attest-target.
 *
 * It asserts nothing about KIND_GUARDS. It used to require a guard on four kinds, and that half went
 * with the three guards themselves: a demand that a table hold an entry is only worth making while
 * the entry can refuse something.
 */
export function assertGuardsArmed(runDefinitions: Map<RunKind, AnyRunDefinition>): void {
  for (const def of runDefinitions.values()) {
    if (!def.mutating) continue;
    if (def.steps({})[0]?.name !== ATTEST_TARGET_STEP) {
      throw new Error(`mutating run ${def.kind} must start with ${ATTEST_TARGET_STEP}`);
    }
  }
}
