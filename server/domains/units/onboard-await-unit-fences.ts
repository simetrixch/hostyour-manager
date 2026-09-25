// The onboard `await-unit-fences` step: wait for GitOps to render the unit's per-stage fences before
// the release cycle starts.
import type { Step } from "../../executor/types.ts";
import { errUpstream } from "../../kernel/errors.ts";
import { syncedAt, describeUnsynced } from "#unit/server/argo-app-status.ts";
import type { OnboardPorts, DeployableOnboardParams } from "./onboard.run.ts";

/** The two Applications hostyour-cloud's units-appset.yaml generates per (unit, stage) in the ArgoCD
 *  namespace the unit belongs to: the reconciler (the isolation AppProject and the argo-sync grant)
 *  and the admission policy. */
export function unitFenceApplications(consumerName: string, stage: string): string[] {
  return [`${consumerName}-reconciler-${stage}`, `${consumerName}-admissionpolicy-${stage}`];
}

/** await-unit-fences: the release pipeline's own `argo-sync` step reads the unit's Application through
 *  the argo-sync grant the reconciler renders, so that grant has to stand before the cycle is
 *  triggered. Measured on master.digitacloud.app: the release build of a fresh digita-auth onboarding
 *  reached `argo-sync` at 21:17:02Z and was refused (Forbidden); the ApplicationSet generated the
 *  reconciler at 21:17:30Z and its Role at 21:17:31Z — four minutes after the registration commit,
 *  where the build took two. The fences are watched through their Applications in the namespace the
 *  resolver answers for the target: `argocd` on the master, the slave's own on a slave. */
export function awaitUnitFencesStep(ports: OnboardPorts, p: DeployableOnboardParams): Step {
  return {
    name: "await-unit-fences",
    title: "Wait for GitOps to render the unit's fences",
    run: async (ctx) => {
      const { argoReader, argoNamespace } = await ports.resolver.resolve(p.clusterId);
      const apps = unitFenceApplications(p.consumerName, p.stage);
      const until = syncedAt(apps);
      const byName = await argoReader.watchApplicationSet(argoNamespace, apps, until, { timeoutMs: ports.argoWatchTimeoutMs, signal: ctx.signal });
      if (!until(byName)) {
        throw errUpstream(
          `the registration for "${p.consumerName}" is committed, and ArgoCD has not rendered its fences within ${Math.round(ports.argoWatchTimeoutMs / 1000)}s: ${describeUnsynced(apps, byName)}. ` +
            "The release is not triggered: its pipeline refreshes the unit's Application through the argo-sync grant the reconciler renders.",
        );
      }
      ctx.log("meta", `${apps.join(" and ")} are Synced + Healthy in ${argoNamespace} — the unit's AppProject, its argo-sync grant and its admission policy stand before its first release`);
    },
  };
}
