// The lifecycle helpers every unit's run kinds share, whichever family the unit belongs to: the
// fail-closed deploy-state gate of an attest-target step, the question whether a unit stays
// registered at another stage, and the relocation mark a removal takes off first.
import type { StepCtx } from "#core/server/executor/types.ts";
import { AppError, errNotFound } from "#core/server/kernel/errors.ts";
import type { Stage } from "#core/shared/enums.ts";
import type { DeployState, ClusterReader } from "#core/server/adapters/kube/port.ts";
import { CLAIM_RELOCATING_ANNOTATION } from "#core/server/adapters/kube/port.ts";
import type { Registrations } from "./registrations.ts";

/** Fail-closed deploy-state gate, shared by every consumer AND tenant attest-target step: the target
 *  cluster must still be a provisioned hostyour cluster (its deploy-state ConfigMap present) whose
 *  DOMAIN agrees with the unit's cluster row. The deploy-state's stage is the platform's and is not
 *  compared: a unit at any stage stands on a cluster of any stage. `subject` names the unit in the
 *  mismatch message ("app" / "tenant"). Returns the (now-non-null) DeployState so the caller can log
 *  its generation. */
export function assertDeployState(state: DeployState | null, domain: string, subject: string): DeployState {
  if (!state) throw errNotFound(`deploy-state for cluster ${domain} — refusing to act on an unprovisioned cluster`);
  if (state.domain !== domain) {
    throw errNotFound(`deploy-state mismatch: cluster reports ${state.domain}, ${subject} targets ${domain}`);
  }
  return state;
}

/** Does the unit stay registered at another stage? Every teardown step whose object belongs to the UNIT
 *  rather than to the unit-in-a-stage has to ask before it removes anything, and both consumer removal
 *  run kinds (offboard, purge) ask through this one helper.
 *
 *  What is per stage, because every name of it carries the stage: the stage registration, the
 *  generated Application `<name>-<stage>`, the isolation AppProject, the admission policy
 *  `consumer-<name>-<stage>`, the namespace `<name>-<stage>`, the ArgoCD repository credential
 *  `repo-<name>-<stage>`, the argo-sync grant `<name>-<stage>-argo-sync`, the mail-ops grant
 *  `<name>-<stage>-smtp-ops`, the public DNS record `<label>.<stage apex>` and the
 *  `<stage>/consumer/<name>/*` Vault entries. Two stages of one unit may share one cluster and always
 *  share the relay's namespace, which is why none of these may be named per unit. What is per UNIT,
 *  one copy shared by every stage: the `<name>-build` namespace with its EventListener and
 *  manager-read grants, the repo PAT at `secret/build/<name>/repo-pat`, the ONE build webhook on the
 *  consumer repo, and the release kit committed into that repo. Removing any of the second group
 *  while another stage stands leaves that stage unable to build, release or deploy.
 *
 *  The registration tree answers it: `registrations/<unit>/` still holding another `<stage>.yaml` means
 *  the unit stays registered — the same rule removeRegistration applies to build.yaml, asked of the same
 *  branch. It is read at the moment of the decision rather than carried from an earlier step, so a
 *  resumed run and a purge that found no registration of its own both get the true answer.
 *
 *  Returns true ⇒ the caller must keep its object, and the skip is already logged with the stages that
 *  kept it. `subject` names the object in that line.
 *
 *  `unit.stage` is the stage this run is removing, and it is discounted because the run's own
 *  registration may or may not still stand when the step acts. It is ABSENT for a caller that registers
 *  no stage of its own — the build-only onboard's abort cleanup — where every standing stage belongs to
 *  another run and none may be discounted. */
export async function unitStaysRegistered(
  ctx: StepCtx,
  registrations: Registrations,
  unit: { name: string; stage?: Stage },
  subject: string,
): Promise<boolean> {
  const elsewhere = (await registrations.readUnitStages(unit.name)).filter((standing) => standing !== unit.stage);
  if (elsewhere.length === 0) return false;
  ctx.log(
    "meta",
    `${subject} for ${unit.name} kept — the unit stays registered at ${elsewhere.join(", ")}, and there is one per unit, not one per stage; it goes with the unit's last stage`,
  );
  return true;
}

/** Take the relocation mark off the unit's namespaces — the FIRST thing every removal run kind does, on
 *  the cluster it is about to strip, before it removes the registration.
 *
 *  A move writes CLAIM_RELOCATING_ANNOTATION on the SOURCE namespaces at repoint, and while it stands
 *  the service-provisioner keeps a ServiceClaim's databases instead of dropping them
 *  (apps/service-provisioner/templates/configmap.yaml). Only two things ever take it off again: a
 *  later move ARRIVING on that cluster, and the source namespace being deleted by clear-source. A move
 *  that dies between repoint and clear-source and is then abandoned therefore leaves it standing — and
 *  a mark standing on a cluster is a removal run kind's problem, because the prune that a registration
 *  removal sets off runs the very teardown the mark disarms: offboard and purge would report success
 *  while every database of the unit stayed on the cluster, with nothing recording that it did.
 *
 *  Clearing here rather than reading and refusing is right because a mark this run kind finds is stale by
 *  construction: a move and a removal of the same unit cannot run at once (both claim the master-kube
 *  lock and the registration branch), so no live move is relying on it.
 *
 *  An absent namespace is the normal case for a teardown (a re-run, a purge of an orphan that never
 *  got one), so NOT_FOUND is swallowed — the opposite of the repoint, where marking nothing must never
 *  read as success. */
export async function clearRelocationHold(ctx: StepCtx, clusterReader: ClusterReader, namespaces: readonly string[], unit: string): Promise<void> {
  const cleared: string[] = [];
  for (const ns of namespaces) {
    try {
      await clusterReader.annotateNamespace(ns, { [CLAIM_RELOCATING_ANNOTATION]: null });
      cleared.push(ns);
    } catch (err) {
      if (!(err instanceof AppError && err.code === "NOT_FOUND")) throw err;
    }
  }
  ctx.log(
    "meta",
    cleared.length
      ? `${CLAIM_RELOCATING_ANNOTATION} cleared on ${cleared.join(", ")} — the patch runs whether or not one stood there, it is not a finding; a mark an abandoned move left behind would make this teardown keep ${unit}'s databases`
      : `no namespace of ${unit} stands on this cluster — no ${CLAIM_RELOCATING_ANNOTATION} mark to clear`,
  );
}
