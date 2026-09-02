// The onboard `await-build-namespace` step. Split out of onboard-steps.ts (like
// onboard-seed-repo-pat.ts / onboard-webhook.ts) so the reasoning that belongs to this one wait
// stands with it and the shared step file stays under its line budget.
import type { Step } from "../../executor/types.ts";
import { errValidation, errUpstream } from "../../kernel/errors.ts";
import { unitBuildNamespace } from "./build-rbac.ts";
import { MASTER_ARGO_NAMESPACE } from "./cluster-kube.ts";
import { syncedAt, describeUnsynced } from "./tenant-watch.ts";
import type { OnboardPorts, OnboardParams } from "./onboard.run.ts";

/** await-build-namespace: wait for GitOps to render the unit's `<name>-build` namespace, which the
 *  step after this one writes into.
 *
 *  THE MANAGER DOES NOT CREATE IT AND MUST NOT. The per-unit build Application renders that
 *  namespace itself — hostyour-cloud's consumer-build chart ships it with `CreateNamespace=false`
 *  deliberately, so the ValidatingAdmissionPolicy's label is on it — and that Application is fanned
 *  out by an ApplicationSet whose generator reads the registration `write-registration` commits two
 *  steps earlier. A second writer here would put the Manager on an object GitOps owns.
 *
 *  WHAT IT ENDS. Measured on a real installation, on the first consumer this platform ever
 *  onboarded: `provision-build-rbac` started twenty-six milliseconds after `write-registration`
 *  ended, and failed with `namespaces "hostyour-manager-build"
 *  not found`. ArgoCD had not seen the commit; it could not have. Without this step a unit's FIRST
 *  onboarding always fails and its second always succeeds, which reads like a flake and is not.
 *  Reproduced independently on a second machine.
 *
 *  THE NAMESPACE IS WATCHED THROUGH ITS APPLICATION and not by polling for the namespace, because
 *  the Application arriving Synced+Healthy is the statement that everything in it stands — the
 *  namespace, the SecretStore, the release Pipeline — which is what the four steps after this one
 *  need, and one of them is not enough to promise the others. It is the same watch, and the same
 *  two helpers, that the tenant fan-out and add-app already wait with.
 *
 *  THE READER IS INJECTED AND THE NAMESPACE IS A CONSTANT, and neither could come from the
 *  resolver. `argoNamespace` answers the per-slave ArgoCD namespace for a slave target while this
 *  Application is master-local whatever the target is (the ApplicationSet runs `runsOn: master`).
 *  And a BUILD-ONLY unit carries no `clusterId` at all — it deploys nothing, so it has no cluster —
 *  so there is nothing to resolve with in the very form this step exists for. `buildArgo` is
 *  injected the way `buildRbac` beside it is, and for the same reason. */
export function awaitBuildNamespaceStep(ports: OnboardPorts, p: OnboardParams): Step {
  return {
    name: "await-build-namespace",
    title: "Wait for GitOps to render the unit's build namespace",
    run: async (ctx) => {
      if (!ports.buildArgo) {
        throw errValidation(
          "the master ArgoCD reader is not wired — without it nothing can confirm that GitOps has rendered the unit's build namespace, and the grants below would be written into a namespace nobody has looked for",
        );
      }
      const app = unitBuildNamespace(p.consumerName);
      const until = syncedAt([app]);
      const byName = await ports.buildArgo.watchApplicationSet(MASTER_ARGO_NAMESPACE, [app], until, {
        timeoutMs: ports.argoWatchTimeoutMs,
        signal: ctx.signal,
      });
      if (!until(byName)) {
        throw errUpstream(
          `the registration for "${p.consumerName}" is committed, and ArgoCD has not rendered its build namespace within ${Math.round(ports.argoWatchTimeoutMs / 1000)}s: ${describeUnsynced([app], byName)}. ` +
            `That namespace is ${MASTER_ARGO_NAMESPACE}/${app}'s to create and no step of this run may write it. This is the platform's own sync, not a finding about the repository under validation — nothing in it can change this outcome.`,
        );
      }
      ctx.log("meta", `${app} is Synced + Healthy — its namespace, SecretStore and release Pipeline stand, and the grants below have somewhere to land`);
    },
  };
}
