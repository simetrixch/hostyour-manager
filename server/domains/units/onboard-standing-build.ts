import { z } from "zod";
import type { Step, StepCtx } from "../../executor/types.ts";
import { errValidation } from "../../kernel/errors.ts";
import { GateReportSchema } from "../../../shared/gates.ts";
import { BuildOnlyParams, type BuildPorts } from "#unit/server/build-chain.ts";
import { parseGitHubOwnerRepo } from "#unit/server/github-repo-url.ts";
import { attestBuildsAgain } from "#unit/server/build-unit-attest.ts";
import { preflightScopesStep } from "#unit/server/preflight-scopes.ts";
import { injectReleaseKitStep } from "#unit/server/inject-release-kit.ts";
import { triggerReleaseStep, watchReleaseBuildStep, type ReleaseCycleRuntime } from "#unit/server/release-cycle.ts";
import { recordBuildOnlyStep } from "#unit/server/build-registration.ts";

// The existing internal discriminator freezes the shorter chain into the approved plan. The
// request has no form selector; native registration reads alone choose this variant.
export const StandingBuildOnlyParams = BuildOnlyParams.extend({
  form: z.literal("standing-build-only"),
  report: GateReportSchema,
});
export type StandingBuildOnlyParams = z.infer<typeof StandingBuildOnlyParams>;

/** A repeated build-only action must not adopt another repository, a deployed unit or a paused
 *  registration. Asked at plan and again before re-attestation so approval cannot outlive it. */
export async function hasStandingBuildOnly(
  ports: Pick<BuildPorts, "registrations">,
  p: Pick<BuildOnlyParams, "consumerName" | "repoURL">,
): Promise<boolean> {
  const standing = await ports.registrations.readBuildRegistration(p.consumerName);
  const stages = await ports.registrations.readUnitStages(p.consumerName);
  if (stages.length > 0) throw errValidation(`unit ${p.consumerName} is deployed on ${stages.join(", ")} — it cannot be repeated as build-only`);
  if (!standing) return false;
  const expected = parseGitHubOwnerRepo(p.repoURL);
  const actual = parseGitHubOwnerRepo(standing.entry.repoURL);
  if (expected.owner.toLowerCase() !== actual.owner.toLowerCase() || expected.repo.toLowerCase() !== actual.repo.toLowerCase()) {
    throw errValidation(`repository ${p.repoURL} does not match the standing repository of build-only unit ${p.consumerName} — plan its actual identity instead`);
  }
  if (standing.entry.suspended || standing.entry.quiesced) throw errValidation(`build-only unit ${p.consumerName} is suspended or quiesced — a repeated onboarding must not resume it`);
  return true;
}

export function standingBuildOnlySteps(ports: BuildPorts, p: StandingBuildOnlyParams, check: Step): Step[] {
  const unit: BuildOnlyParams = { ...p, form: "build-only" };
  const release: ReleaseCycleRuntime = {};
  const attest = async (ctx: StepCtx): Promise<void> => {
    if (!await hasStandingBuildOnly(ports, unit)) throw errValidation(`build-only unit ${unit.consumerName} is no longer registered — plan the run again`);
    await attestBuildsAgain(ctx, ports, unit.consumerName, unit.builds);
  };
  const trigger = triggerReleaseStep(ports, unit);
  return [
    preflightScopesStep(ports, unit),
    check,
    {
      name: "re-attest-builds",
      title: "Re-attest the standing builds and wait for their exact GitOps render",
      run: attest,
    },
    injectReleaseKitStep(ports, unit),
    // Retry skips completed steps, so the dispatch must prove the standing identity and render too.
    { ...trigger, run: async (ctx) => { await attest(ctx); await trigger.run(ctx); } },
    watchReleaseBuildStep(ports, unit, release),
    recordBuildOnlyStep(ports, unit, release),
  ];
}
