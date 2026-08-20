import { eq, and, ne, notInArray } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { meta } from "../db/schema/meta.ts";
import { clusters, servers } from "../db/schema/inventory.ts";
import { errPlanRefused } from "../kernel/errors.ts";
import type { PlanGuard, PlannerDeps, AnyRunDefinition } from "./types.ts";
import { MASTER_ROLES, type RunKind } from "../../shared/enums.ts";

const GATE_MESSAGE =
  "Cluster keys are stored unencrypted — this action requires the envelope keystore or an explicit, dated decision to keep storing them unencrypted.";

function keystoreMode(db: Db): string {
  return db.select().from(meta).where(eq(meta.key, "keystore.mode")).get()?.value ?? "plaintext";
}

// What the gate below counts is clusters whose ACCESS KEY the controller stores: a slave is reached
// over a harvested cluster-admin bearer sealed in the keystore. A cluster carrying the master part is
// reached over the controller pod's own ServiceAccount and no bearer is harvested for it
// (domains/onboarding/cluster-kube.ts), so it holds nothing the plaintext keystore could expose and
// is excluded — including a master+slave, whose slave part is its own host.
function countLiveSlaves(db: Db): number {
  return db
    .select({ id: clusters.id })
    .from(clusters)
    .innerJoin(servers, eq(clusters.serverId, servers.id))
    .where(and(notInArray(servers.role, [...MASTER_ROLES]), ne(clusters.status, "removed")))
    .all().length;
}

// The crypto gate: under plaintext, a new slave is allowed only as the single
// rehearsal slave (zero real slaves). Non-plaintext ⇒ the gate is open: the keystore encrypts at
// rest, so a harvested cluster access key is no longer readable from the database file alone.
const slaveCryptoGate: PlanGuard = async (params, deps) => {
  if (keystoreMode(deps.db) !== "plaintext") return;
  if ((params as { tier?: unknown }).tier !== "rehearsal") throw errPlanRefused(GATE_MESSAGE, { code: "O_GATE_1" });
  if (countLiveSlaves(deps.db) >= 1) throw errPlanRefused(GATE_MESSAGE, { code: "O_GATE_1" });
};

// onboard under plaintext: allowed only onto a rehearsal cluster. The BUILD-ONLY form names
// no cluster at all — it deploys nothing and touches only git, the local Vault and the build plane's
// own namespaces (the controller's cluster, whose access rides the pod SA, not a stored bearer), so
// there is nothing the plaintext keystore could expose and the gate passes it through.
const onboardCryptoGate: PlanGuard = async (params, deps) => {
  if (keystoreMode(deps.db) !== "plaintext") return;
  const clusterId = (params as { clusterId?: unknown }).clusterId;
  if (clusterId === undefined) return;
  if (typeof clusterId !== "string") throw errPlanRefused(GATE_MESSAGE, { code: "O_GATE_1" });
  const cluster = deps.db.select().from(clusters).where(eq(clusters.id, clusterId)).get();
  if (cluster?.tier !== "rehearsal") throw errPlanRefused(GATE_MESSAGE, { code: "O_GATE_1" });
};

// create-tenant / add-app under plaintext: allowed only onto a rehearsal cluster — the tenant
// analogue of onboardCryptoGate, keyed on the tenant's target cluster tier. Both kinds are planned
// via the streaming planner (fan-out / subset validation), so this fires from runStreamingPlan's
// runGuards call against the RESOLVED params (add-app resolves clusterId from its tenant during the
// plan), not only executor.plan() — otherwise the gate would be dead on the streaming path.
const createTenantCryptoGate: PlanGuard = async (params, deps) => {
  if (keystoreMode(deps.db) !== "plaintext") return;
  const clusterId = (params as { clusterId?: unknown }).clusterId;
  if (typeof clusterId !== "string") throw errPlanRefused(GATE_MESSAGE, { code: "O_GATE_1" });
  const cluster = deps.db.select().from(clusters).where(eq(clusters.id, clusterId)).get();
  if (cluster?.tier !== "rehearsal") throw errPlanRefused(GATE_MESSAGE, { code: "O_GATE_1" });
};

/**
 * Total over RUN_KIND — the Record type forces compile-time exhaustiveness, so a new kind
 * cannot forget to declare its guards (security critique N3, made structural).
 */
export const KIND_GUARDS: Record<RunKind, readonly PlanGuard[]> = {
  noop: [],
  adopt: [],
  "deploy-slave": [slaveCryptoGate],
  // redeploy and release both act on a cluster that is ALREADY live, and neither harvests a new
  // cluster access key — so the crypto gate has nothing to protect. Gating them would strand exactly the
  // running cluster they exist to reconcile on a plaintext-keystore install (purge's reasoning).
  // release also carried an unconditional gate while nothing regenerated an install branch; the
  // regenerate-branch program does now, and the def itself refuses the one shape that still has no
  // regeneration — a slave target (release.ts plan()).
  redeploy: [],
  release: [],
  // The tailnet repair run kinds act on a host that is ALREADY deployed and harvest no cluster access
  // key, so the crypto gate has nothing to protect — and arming it would strand exactly the host they
  // exist to put back on the private network (purge's reasoning).
  "tailnet-disconnect": [],
  "tailnet-reconnect": [],
  "tailnet-rejoin": [],
  // The password-login run kinds change one daemon's configuration and one stored credential on a host
  // that is ALREADY adopted, and harvest no cluster access key — so the crypto gate has nothing to
  // protect. Gating the disable run kind would additionally block, on exactly the plaintext-keystore
  // install the gate exists for, the one act that takes a way into that host away.
  "password-login-disable": [],
  "password-login-enable": [],
  // The operator-key run kinds edit one line of one file on a host that is ALREADY adopted, and harvest
  // no cluster access key — so the crypto gate has nothing to protect. Gating the removal would additionally
  // block, on exactly the plaintext-keystore install the gate exists for, the one act that takes a
  // human's standing access to a machine away.
  "operator-key-place": [],
  "operator-key-remove": [],
  "authorized-keys-read": [],
  onboard: [onboardCryptoGate],
  suspend: [],
  resume: [],
  offboard: [],
  // purge is a force-offboard (teardown) — no crypto gate: blocking an ORPHAN removal behind the crypto gate
  // would strand exactly the leftover artifacts purge exists to reap on a plaintext-keystore cluster.
  purge: [],
  // restart-workloads rolls the pods of a unit that is ALREADY deployed and harvests no cluster access
  // key — so the crypto gate has nothing to protect. Gating it would additionally strand, on exactly the
  // plaintext-keystore install the gate exists for, the last step of putting a new secret value in
  // front of a unit: the operator would have written it into Vault and be unable to make the pods read it.
  "restart-workloads": [],
  // set-size writes one field of a registration that already stands and harvests no cluster access
  // key — so the crypto gate has nothing to protect, and gating it would strand, on exactly the
  // plaintext-keystore install the gate exists for, the only way to move a running unit onto a
  // corrected ceiling.
  "set-size": [],
  // adopt-consumer RECORDS an existing deployment: its only mutation is the
  // local inventory row, it places no bytes on any cluster — so the crypto gate has nothing to protect, and
  // gating it would strand exactly the invisible consumer the run kind exists to recover (purge's reasoning).
  "adopt-consumer": [],
  // The relocation run kinds act on a unit that is ALREADY deployed and harvest no new cluster access
  // key — backup/restore are recovery run kinds (purge's reasoning: gating them would strand exactly the
  // data they exist to save), and migrate moves between clusters whose keys the keystore already holds.
  backup: [],
  restore: [],
  migrate: [],
  // check-tenants only READS: it asks each tenant whether anybody can still administer it and
  // writes the answer onto the local inventory row. It places no bytes on any cluster and
  // harvests no key, so the crypto gate has nothing to protect — and gating it would blind
  // exactly the plaintext-keystore install to a tenant nobody can get into.
  "check-tenants": [],
  "create-tenant": [createTenantCryptoGate],
  "add-app": [createTenantCryptoGate],
  "remove-app": [],
  "tenant-suspend": [],
  "tenant-resume": [],
  // Ungated like its consumer twin above — same reasoning.
  "tenant-restart-workloads": [],
  // Ungated like its consumer twin above — same reasoning.
  "tenant-set-size": [],
  "tenant-offboard": [],
  // tenant-purge is a force-offboard (teardown) — no crypto gate, for the SAME reason the consumer
  // purge carries none: blocking an ORPHAN removal behind the crypto gate would strand exactly the leftover
  // artifacts purge exists to reap on a plaintext-keystore cluster.
  "tenant-purge": [],
  // Ungated like their consumer twins above — same reasoning.
  "tenant-backup": [],
  "tenant-restore": [],
  "tenant-migrate": [],
};

export async function runGuards(kind: RunKind, params: unknown, deps: PlannerDeps): Promise<void> {
  for (const guard of KIND_GUARDS[kind]) await guard(params, deps);
}

/** The step name pinned as step 0 of every MUTATING run: its fail-closed precondition. Named once,
 *  here, because two places must key on the SAME string — the boot assertion below, which MAKES the
 *  invariant true for the whole registry, and Executor.skipStep, which RELIES on it to refuse the one
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
 * Backs the guards.armed self-check: the gate is armed on the crypto-gated kinds (deploy-slave,
 * onboard, create-tenant, add-app), and every registered mutating def starts with attest-target
 *. add-app is crypto-gated too (it fans a new app into a live tenant), so it belongs in the
 * armed set — omitting it would let a future edit silently disarm its gate.
 */
export function assertGuardsArmed(registry: Map<RunKind, AnyRunDefinition>): void {
  for (const kind of ["deploy-slave", "onboard", "create-tenant", "add-app"] as const) {
    if (KIND_GUARDS[kind].length === 0) throw new Error(`no crypto gate armed on ${kind}`);
  }
  for (const def of registry.values()) {
    if (!def.mutating) continue;
    if (def.steps({})[0]?.name !== ATTEST_TARGET_STEP) {
      throw new Error(`mutating run ${def.kind} must start with ${ATTEST_TARGET_STEP}`);
    }
  }
}
