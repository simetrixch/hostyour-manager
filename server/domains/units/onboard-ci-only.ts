// THE CI-ONLY PLAN of the consumer-onboard run: a repository that runs its own `scripts/check.sh` on
// every push to the build plane and builds, releases and deploys nothing. It stands apart from the
// two other build forms because it asks the repository for one file only — the gates judge a
// deploy manifest, a build list and a chart that such a repository does not have — and because it
// needs no stage, version or channel: nothing is released.
import { z } from "zod";
import type { Plan, PlanStreamCtx, PlanStreamResult } from "../../executor/types.ts";
import { unitNameFromRepoURL } from "../../../shared/consumer.ts";
import { errValidation } from "../../kernel/errors.ts";
import { resolveMasterCluster } from "../inventory/read.ts";
import { CiOnlyParams, ciOnlySteps, DEFAULT_BRANCH_HEAD, repoURLSchema, unitNameSchema, type BuildPorts } from "#unit/server/build-chain.ts";

/** What the unit's own CI runs. The ci pipeline the build plane renders clones the repository and
 *  runs exactly this path, so a repository without it would register, receive every push and fail
 *  every run. */
export const CI_ENTRY_POINT = "scripts/check.sh";

/** The raw request of the wizard's CI only form. The sealed credential reference replaces the raw PAT
 *  before a run exists, exactly as OnboardPlanRequest does. */
export const CiOnlyPlanRequest = z.object({
  form: z.literal("ci-only"),
  consumerName: unitNameSchema,
  repoURL: repoURLSchema,
  owner: z.string().min(1),
  repoCredentialId: z.string().min(1),
});
export type CiOnlyPlanRequest = z.infer<typeof CiOnlyPlanRequest>;

export async function planCiOnly(ports: BuildPorts, ctx: PlanStreamCtx, rawParams: unknown): Promise<PlanStreamResult<CiOnlyParams>> {
  const req = CiOnlyPlanRequest.parse(rawParams);
  ctx.log(`onboard parameters — consumer="${req.consumerName}" repo="${req.repoURL}" CI only owner="${req.owner}" repoCredential=${req.repoCredentialId} (raw PAT sealed, never logged)`);
  if (unitNameFromRepoURL(req.repoURL) !== req.consumerName) {
    throw errValidation(`the unit of ${req.repoURL} is "${unitNameFromRepoURL(req.repoURL)}", not "${req.consumerName}" — a unit is named by its repository`);
  }
  if ((await ports.registrations.listUnitNames()).includes(req.consumerName)) {
    throw errValidation(`"${req.consumerName}" is already registered — a CI-only onboarding creates a unit and never changes a standing one`);
  }
  const master = resolveMasterCluster(ctx.db);
  const cloned = await ports.repo.cloneAtRef({ repoURL: req.repoURL, ref: DEFAULT_BRANCH_HEAD, credentialId: req.repoCredentialId, signal: ctx.signal });
  let hasEntryPoint: boolean;
  try {
    hasEntryPoint = (await ports.repo.readFile(cloned.workdir, CI_ENTRY_POINT)) !== null;
  } finally {
    await ports.repo.dispose(cloned.workdir);
  }
  if (!hasEntryPoint) {
    return {
      outcome: "rejected",
      summary: `Onboarding "${req.consumerName}" (CI only) was rejected — the default branch head ${cloned.resolvedSha.slice(0, 7)} has no ${CI_ENTRY_POINT}, so every push would run nothing and fail`,
      planJson: { form: "ci-only", resolvedSha: cloned.resolvedSha, found: [], expected: [CI_ENTRY_POINT] },
    };
  }
  ctx.log(`${CI_ENTRY_POINT} found at ${cloned.resolvedSha.slice(0, 7)}`);
  const params: CiOnlyParams = {
    form: "ci-only",
    consumerName: req.consumerName,
    repoURL: req.repoURL,
    repoCredentialId: req.repoCredentialId,
    owner: req.owner,
    resolvedSha: cloned.resolvedSha,
    domain: master.domain,
    builds: [],
  };
  const stepDefs = ciOnlySteps(ports, params);
  const plan: Plan = {
    kind: "consumer-onboard",
    targetKind: "cluster",
    targetId: master.clusterId, // the build plane — the one cluster this form touches
    summary: `Onboard CI-only unit "${req.consumerName}": ${stepDefs.length} steps — register it with no builds, seed its repository credential, wait for its pipelines and register the push webhook. Every push then runs ${CI_ENTRY_POINT}; nothing is built or deployed.`,
    steps: stepDefs.map((s) => ({ name: s.name, title: s.title })),
    targets: [],
    locks: [
      { resource: "git-branch", key: ports.registrations.branch },
      { resource: "master-kube", key: "m" },
    ],
    warnings: [],
    requiredSecrets: [],
  };
  return { outcome: "planned", params, plan };
}
