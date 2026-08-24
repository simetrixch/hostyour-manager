// The consumer onboard ROLLBACK — everything abort-with-cleanup needs from this run: what its
// compensations ARE, in the one order they may run, and whether they may run at all. The consumer
// mirror of create-tenant-abort.ts, split out of onboard.run.ts for the same reason: the two halves
// belong together because the second is a statement about the first — the compensations are a full
// GitOps un-deploy of whatever this run put on the platform, so "may this run be aborted" is really
// "is that consumer still deployed and serving".
//
// ORDER. abortWithCleanup runs a run's registered cleanups in reverse STEP order but keeps ONE step's
// registrations in the order they were written (executor/cleanup.ts) — so write-registration arms the
// WHOLE list below and the rollback runs registration-removal FIRST, then the prune wait, then the
// object deletes. The per-step arming this replaces produced the reverse: the AppProject went while
// the generated Application still referenced it, and nothing ever waited for the prune.
import { eq, and } from "drizzle-orm";
import type { Cleanup } from "../../executor/types.ts";
import type { Db } from "../../db/client.ts";
import { apps } from "../../db/schema/inventory.ts";
import { errValidation } from "../../kernel/errors.ts";
import type { AppStatus } from "../../../shared/enums.ts";
import {
  removeRegistrationCleanup, watchConsumerPruneCleanup, deleteAppProjectCleanup, deleteAdmissionPolicyCleanup,
  deleteBuildRbacCleanup, deleteRepoCredentialCleanup, removeDnsCleanup, removeBuildRegistrationCleanup,
} from "./onboard-steps.ts";
import { removeWebhookCleanup } from "./onboard-webhook.ts";
// Type-only, so there is no runtime import cycle back into onboard.run.ts — the create-tenant-abort.ts shape.
import type { OnboardPorts, OnboardParams, DeployableOnboardParams } from "./onboard.run.ts";

/** The deployable form's compensations, in RUN order — armed as one block by write-registration
 *  (before its commit, so a rollback always exists once anything is committed) and resolved by name
 *  through the definition's cleanups(). The registration goes first because it is what the consumers
 *  ApplicationSet generates the Application from; the prune wait stands between that removal and every
 *  object delete (watchConsumerPruneCleanup states why); the remaining deletes are each idempotent, so
 *  arming them for steps the run never reached costs nothing. remove-ceremony-secrets is NOT here: the
 *  seed's cas=0 outcome decides whether the entry is this run's to destroy, so seed-secrets arms that
 *  one itself, on a real create only. */
export function deployableOnboardCleanups(ports: OnboardPorts, p: DeployableOnboardParams): Cleanup[] {
  return [
    removeRegistrationCleanup(ports, p),
    watchConsumerPruneCleanup(ports, p),
    deleteAppProjectCleanup(ports, p),
    deleteAdmissionPolicyCleanup(ports, p),
    deleteBuildRbacCleanup(ports, p),
    deleteRepoCredentialCleanup(ports, p),
    removeDnsCleanup(ports, p),
    removeWebhookCleanup(ports, p),
  ];
}

/** The build-only form's compensations, in RUN order — armed by its write-registration the same way.
 *  Nothing of a build-only unit deploys, so there is no prune to wait for; every entry already asks
 *  the registration tree before it removes a UNIT-scoped object (the grants and the webhook go only
 *  with the unit's last stage, and build.yaml is kept while any stage file stands). */
export function buildOnlyOnboardCleanups(ports: OnboardPorts, p: OnboardParams): Cleanup[] {
  return [
    removeBuildRegistrationCleanup(ports, p),
    deleteBuildRbacCleanup(ports, p),
    removeWebhookCleanup(ports, p),
  ];
}

/** The two row states that mean the consumer is DEPLOYED and expected to serve — the consumer twin of
 *  TENANT_LIVE_STATUS (tenant-live-guard.ts), a positive set for the same reason: a status added later
 *  must owe this rule a decision instead of being refused sight unseen. "suspended" belongs here: a
 *  suspended consumer keeps its registration, its namespace and its data, one resume away from serving.
 *
 *  "provisioning" is the decision this rule asked for, and the answer is NO. A provisioning row records
 *  an onboard that is still running or died half-way: nothing serves yet, and aborting is exactly what
 *  should be possible — the compensations exist to take that half-built unit back down. Counting it as
 *  live would lock the operator out of the one run that cleans it up. */
export const CONSUMER_LIVE_STATUS: readonly AppStatus[] = ["active", "suspended"];

/** The abort's PRECONDITION (RunDefinition.assertAbortable): the compensations above are a full
 *  un-deploy, so a FAILED onboard standing behind a consumer that is LIVE must not be aborted — the
 *  registration would be git-rm'd, the ApplicationSet would prune the serving Application, and the
 *  prune deletes the consumer's ServiceClaim, whose deprovision drops its databases. Two ends can say
 *  the consumer is live, and BOTH are asked because the run can fail on either side of record-inventory:
 *
 *  1. THE INVENTORY ROW. `activate` is deliberately the LAST step, after smoke + record-inventory, so a
 *     run that failed only there stands behind a consumer that is deployed, recorded active and
 *     serving. The row alone is not enough — a live row whose registration is already gone is the
 *     failed-offboard leftover state, which the abort may still reap — so the registration is read too.
 *
 *  2. THE CLUSTER, when there is NO live row: the run died at watch-deployment or smoke, i.e. before
 *     record-inventory ever ran. That failure branch cannot tell A STEP THAT FAILED from A STEP THAT
 *     TIMED OUT WHILE SUCCEEDING — the deployment can converge minutes after the watch budget — so the
 *     truth is read back HERE, at the moment the abort asks: the generated Application on the target
 *     cluster. Synced + Healthy means the run's work is live, and the way to make the record agree
 *     with the cluster is not a rollback but a RETRY: every step re-reads the world, so a retry passes
 *     the watch it once timed out on, records the consumer in the inventory and settles the run green.
 *     The refusal says exactly that.
 *
 *  Fail-closed throughout: an unreadable registration or an unreachable ArgoCD propagates — "cannot
 *  read" is never "is not there", and a rollback must not fire blind. Asked on the DEFINITION so it
 *  holds for every caller of the abort (the run screen's hidden button is a convenience, not a guard). */
export async function assertOnboardAbortable(ports: OnboardPorts, p: OnboardParams, db: Db): Promise<void> {
  // A build-only unit deploys nothing, so there is nothing live an abort could un-deploy; its
  // unit-scoped removals already keep what another stage still depends on (unitStaysRegistered).
  if (p.form !== "deployable") return;
  // The pointer: absent means the ApplicationSet generates nothing — whatever the run committed is
  // already taken back (or never landed), and the compensations reap leftovers only.
  if ((await ports.registrations.readRegistration(p.stage, p.consumerName)) === null) return;
  const rollback =
    `aborting this onboard would run its rollback: git-rm the registration, wait for ArgoCD to prune the generated Application ` +
    `(the prune deletes the consumer's ServiceClaim, and its deprovision drops the consumer's databases and user), then delete the AppProject, ` +
    `the admission policy, the build grants, the repository credential and the DNS record`;
  const row = db
    .select({ status: apps.status })
    .from(apps)
    .where(and(eq(apps.clusterId, p.clusterId), eq(apps.name, p.consumerName), eq(apps.stage, p.stage)))
    .get();
  if (row && CONSUMER_LIVE_STATUS.includes(row.status)) {
    throw errValidation(
      `consumer "${p.consumerName}" is ${row.status} on ${p.domain} (${p.stage}) and its registration still stands — ${rollback}: un-deploying a consumer that is serving. ` +
        `Offboard is the removal run kind for a serving consumer. This run has nothing left to roll back; delete the run once you no longer need its log.`,
    );
  }
  const { argoReader, argoNamespace } = await ports.resolver.resolve(p.clusterId);
  const status = await argoReader.getApplication(argoNamespace, p.argoAppName);
  if (status !== null && status.sync === "Synced" && status.health === "Healthy") {
    throw errValidation(
      `Application ${p.argoAppName} reads Synced/Healthy on ${p.domain} — the run failed on a watch, but the deployment it watched for has since SUCCEEDED, and ${rollback}: un-deploying work that landed. ` +
        `Retry the run from its failed step instead: every step re-reads the world, so the retry passes the watch, records the consumer in the inventory and the run settles green. ` +
        `Offboard is the removal run kind once it is recorded.`,
    );
  }
}
