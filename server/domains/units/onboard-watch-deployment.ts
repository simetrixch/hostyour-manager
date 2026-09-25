// watch-deployment: the deployable form's last watch — the deployment the release cycle produced, read
// off the delivery branch the bump wrote and awaited on the generated Application.
import type { Step } from "../../executor/types.ts";
import type { OnboardPorts, DeployableOnboardParams } from "./onboard.run.ts";
import { sleep, type ReleaseCycleRuntime } from "#unit/server/release-cycle.ts";
import { parseBuildPins } from "../../../shared/pin.ts";
import { syncedRevisionFor, type ArgoAppStatus } from "../../adapters/kube/port.ts";
import { errValidation } from "../../kernel/errors.ts";

/** watch-deployment (deployable form only): the first deployment comes OUT of the release cycle —
 *  the bump wrote the minted image tag into the delivery branch's values file, and ArgoCD syncs that
 *  branch. This step reads the tag off `deploy/<stage>:<chartPath>/values-<stage>.yaml` (the file
 *  the bump wrote — read, never computed) and then waits for the generated Application to reach
 *  Synced/Healthy at that branch head. */
export function watchDeploymentStep(ports: OnboardPorts, p: DeployableOnboardParams, runtime: ReleaseCycleRuntime): Step {
  return {
    name: "watch-deployment",
    title: "Wait for the deployment the release cycle produced",
    run: async (ctx) => {
      const branch = `deploy/${p.stage}`;
      const file = `${p.chartPath}/values-${p.stage}.yaml`;
      // WHAT THE CYCLE MINTED, NEVER WHAT THE PLAN GUESSED (#246). The version in the params is what
      // the repository's release tags said when the WIZARD read them; the tag the release script
      // actually minted is the next free number when the CYCLE ran, and between the two the customer
      // may release as often as they like. swissbookai was planned at 0.1.3 and delivered 0.1.6, and
      // this step waited for a "0.1.3-stable-*" pin that could never appear. watch-release reads the
      // minted tag off the build run's own param and records it, so the truth is in hand here.
      // ON A RETRY OR A RESUME THE SIBLING STEP DOES NOT RUN AGAIN — it stands `ok`, so the runtime
      // object this run rebuilt is empty. The tag is therefore written into THIS step's own
      // checkpoint the moment it is known, which is the one record a re-entry can read back.
      const remembered = ctx.readCheckpoint<{ wanted?: string }>()?.wanted;
      const wanted = runtime.releaseTag ?? remembered;
      if (!wanted) throw errValidation("the release cycle recorded no minted tag, so nothing says which release this deployment must carry — watch-release did not run, or its param was empty");
      ctx.checkpoint({ wanted });
      const pollMs = ports.releasePollIntervalMs ?? 2_000;
      // Phase 1 — read the bump's own commit. The branch exists (the pipeline just synced it), but
      // push visibility can lag a moment, so the read is polled inside a small budget.
      const deadline = Date.now() + ports.deployRefVisibleMs;
      let head: string;
      let mintedTag: string;
      for (;;) {
        let readable = false;
        try {
          const cloned = await ports.repo.cloneAtRef({ repoURL: p.repoURL, ref: branch, credentialId: p.repoCredentialId, signal: ctx.signal });
          readable = true;
          try {
            const text = await ports.repo.readFile(cloned.workdir, file);
            const pins = text === null ? [] : parseBuildPins(`${branch}:${file}`, text);
            // Every declared build pinned at the tag THIS run's cycle minted. A build still pinned
            // at an older one means the bump did not finish; a NEWER one means somebody released
            // after us, which the log says below rather than refusing — the branch head is what the
            // Application follows either way.
            const tags = new Set(p.builds.filter((b) => pins.some((x) => x.image === b && (x.tag === wanted || x.tag.startsWith(`${wanted}-`)))).length === p.builds.length
              ? pins.filter((x) => p.builds.includes(x.image)).map((x) => x.tag)
              : []);
            if (tags.size === 1) {
              head = cloned.resolvedSha;
              mintedTag = [...tags][0]!;
              break;
            }
            if (tags.size > 1) {
              throw errValidation(`${branch}:${file} pins the declared builds at DIFFERENT tags (${[...tags].join(", ")}) — one release is one image set, so the bump can never write two; the delivery branch is corrupt`);
            }
          } finally {
            await ports.repo.dispose(cloned.workdir);
          }
        } catch (err) {
          // An unreadable branch (not yet visible) is polled; everything after a successful clone
          // rethrows — a corrupt pin grammar or a mixed-tag file will not heal by waiting.
          if (readable) throw err;
        }
        if (Date.now() >= deadline || ctx.signal.aborted) {
          throw errValidation(`${branch}:${file} does not pin every declared build at ${wanted} within the watch budget — the release run reported Succeeded but its bump commit is not visible; check the delivery branch`);
        }
        await sleep(pollMs, ctx.signal);
      }
      // The image tag is the release tag plus the commit's short sha (`<tag>-<sha7>`), so a pin that
      // extends the minted tag IS ours; anything else is a release that landed after this one.
      const ours = mintedTag === wanted || mintedTag.startsWith(`${wanted}-`);
      ctx.log(
        "meta",
        ours
          ? `the bump wrote ${mintedTag} into ${branch}:${file} (commit ${head.slice(0, 7)}) — waiting for the Application to converge on it`
          : `${branch}:${file} pins ${mintedTag} while this run's cycle minted ${wanted} — a release of this repository landed after ours; the Application is watched at the branch head, which is what it follows`,
      );
      // Phase 2 — THE DELIVERY IS WHAT THIS RUN OWES, AND SYNCED IS THE PROOF OF IT (#246). The
      // generated Application follows the delivery branch as a literal, so Synced with the
      // consumer-chart source at the bump commit says: the registration, the release cycle, the bump
      // and ArgoCD all did their part, and the cluster now runs exactly the images the customer's
      // release produced. Whether those images then come UP is the consumer repository's business —
      // a chart that cannot start, a migration that refuses, an image that crash-loops is a bug its
      // owner fixes, and holding the onboarding run red over it says the platform failed when it did
      // not. The health reached is REPORTED, in the step's log and its checkpoint, so nothing about
      // the state is hidden; it is simply not this run's verdict.
      const delivered = (s: ArgoAppStatus): boolean => s.sync === "Synced" && syncedRevisionFor(s, p.repoURL) === head;
      const serving = (s: ArgoAppStatus): boolean => delivered(s) && s.health === "Healthy";
      // A FAILED/ERRORED sync operation is terminal — nothing left to converge on — so stop the poll
      // the moment one is observed rather than waiting the whole budget out on it.
      const failedOp = (s: ArgoAppStatus): boolean => s.opPhase === "Failed" || s.opPhase === "Error";
      const { argoReader, argoNamespace } = await ports.resolver.resolve(p.clusterId);
      // Unbounded on purpose: a deployment takes what it takes (image pulls, migrations); what ends the
      // wait is Synced+Healthy, a sync operation that FAILED (fail-fast), or the operator's cancel.
      // The wait still aims at Healthy — it is the good outcome and worth waiting for — and only the
      // VERDICT below is Synced.
      const status = await argoReader.watchApplication(argoNamespace, p.argoAppName, serving, { signal: ctx.signal, failFast: failedOp });
      if (!delivered(status)) {
        throw errValidation(
          `Application ${p.argoAppName} was not Synced at ${branch}@${head.slice(0, 7)} — last seen sync=${status.sync}, health=${status.health}, phase=${status.opPhase ?? "none"}, rev=${syncedRevisionFor(status, p.repoURL) ?? "none"}${status.message ? ` (${status.message})` : ""}`,
        );
      }
      ctx.checkpoint({ wanted, mintedTag, deployedCommit: head, health: status.health });
      ctx.log(
        "meta",
        status.health === "Healthy"
          ? `Application ${p.argoAppName} is Synced + Healthy at ${head.slice(0, 7)} — the deployment carries ${mintedTag}, produced by the external release cycle`
          : `Application ${p.argoAppName} is Synced at ${head.slice(0, 7)} and carries ${mintedTag}, so the delivery is done — its health reads ${status.health}${status.message ? ` (${status.message})` : ""}, which is the consumer repository's to fix`,
      );
    },
  };
}
