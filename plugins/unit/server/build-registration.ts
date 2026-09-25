// The build-only `write-registration` step, its rollback, and the build-only `record`: a unit's
// build.yaml is written, taken back and recorded here. The writer itself is the Registrations
// (registrations.ts), the ONE writer of registrations/**.
import type { Cleanup, Step } from "#core/server/executor/types.ts";
import type { BuildOnlyParams, BuildParams, BuildPorts } from "./build-chain.ts";
import type { ReleaseCycleRuntime } from "./release-cycle.ts";
import { removeWebhookCleanup } from "./build-webhook.ts";

/** The build-only form's registration commit: build.yaml alone — a build-only unit has no stage
 *  file. For a unit hand-seeded before the run kind existed this is the ATTEST case: identical content
 *  commits nothing (the platform repo's empty-staged-diff no-op), a changed fact (a new sealed
 *  credential id, a new build name) commits the correction — either way the manager is the writer
 *  of the registration. */
export function writeBuildRegistrationStep(ports: BuildPorts, p: BuildOnlyParams): Step {
  return {
    name: "write-registration",
    title: "Commit the build registration (GitOps)",
    run: async (ctx) => {
      // The build-only form's whole rollback, armed before the commit so a rollback always exists
      // once anything is committed (buildOnlyCleanups).
      for (const c of buildOnlyCleanups(ports, p)) ctx.registerCleanup(c);
      const { commit } = await ports.registrations.commitRegistration({
        unit: {
          name: p.consumerName,
          repoURL: p.repoURL,
          owner: p.owner,
          onboardedAt: new Date().toISOString(),
          suspended: false,
          quiesced: false,
        },
        builds: p.builds,
        runId: ctx.runId,
      });
      ctx.checkpoint({ commit, registration: `registrations/${p.consumerName}/build.yaml` });
      ctx.log("meta", `build registration committed (${commit}) — the build fan-out renders this unit's release pipeline from it`);
    },
  };
}

/** The build-only form's compensations, in RUN order — armed by its write-registration as one block.
 *  Nothing of a build-only unit deploys, so there is no prune to wait for; every entry already asks
 *  the registration tree before it removes a UNIT-scoped object (the webhook goes only with the
 *  unit's last stage, and build.yaml is kept while any stage file stands). */
export function buildOnlyCleanups(ports: BuildPorts, p: BuildParams): Cleanup[] {
  return [
    removeBuildRegistrationCleanup(ports, p),
    removeWebhookCleanup(ports, p),
  ];
}

/** Take back registrations/<name>/build.yaml — the registrations itself keeps it (removed:false) when
 *  a stage file still stands (the unit is deployed elsewhere and its build attestation must survive
 *  this run's abort). */
export function removeBuildRegistrationCleanup(ports: BuildPorts, p: BuildParams): Cleanup {
  return {
    name: "remove-build-registration",
    title: "Remove the build registration",
    run: async (ctx) => {
      const { removed } = await ports.registrations.removeBuildRegistration(p.consumerName, ctx.runId);
      ctx.log("meta", removed
        ? `build registration for ${p.consumerName} removed`
        : `build registration for ${p.consumerName} kept — already absent, or a stage file still stands and the attestation belongs to it`);
    },
  };
}

/** The build-only form's final record. A build-only unit deploys nowhere and runs on no cluster, so
 *  the apps inventory (keyed on a cluster) has no row for it — its durable record is
 *  registrations/<name>/build.yaml plus THIS run: the checkpoint ties the attested builds to the
 *  release the triggered cycle proved, which is what the manager's read-check-record duty
 *  amounts to here. */
export function recordBuildOnlyStep(_ports: BuildPorts, p: BuildOnlyParams, release: ReleaseCycleRuntime): Step {
  return {
    name: "record",
    title: "Record the build-only unit in the run record",
    run: async (ctx) => {
      ctx.checkpoint({
        registration: `registrations/${p.consumerName}/build.yaml`,
        builds: p.builds,
        ...(release.releaseTag ? { releaseTag: release.releaseTag } : {}),
      });
      ctx.log(
        "meta",
        `build-only unit ${p.consumerName} recorded — builds [${p.builds.join(", ")}] attested` +
          (release.releaseTag ? `, release ${release.releaseTag} proven through the injected cycle` : ""),
      );
    },
  };
}
