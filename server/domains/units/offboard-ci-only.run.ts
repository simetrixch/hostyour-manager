import { z } from "zod";
import type { RunDefinition, Step } from "../../executor/types.ts";
import { errNotFound, errValidation } from "../../kernel/errors.ts";
import { KV_MOUNT } from "../../adapters/vault/port.ts";
import { MASTER_ARGO_NAMESPACE } from "../inventory/cluster-kube.ts";
import { resolveMasterCluster } from "../inventory/read.ts";
import { unitBuildNamespace } from "#unit/server/build-rbac.ts";
import { removeConsumerWebhook } from "#unit/server/build-webhook.ts";
import { parseGitHubOwnerRepo } from "#unit/server/github-repo-url.ts";
import { readOwnerIdentity } from "#unit/server/owners.ts";
import { unitRepoCredentialId } from "#unit/server/repo-identity.ts";
import { isCiOnly } from "#unit/server/registrations.ts";
import { webhookTargetUrl } from "#unit/server/adapters/github-consumer/port.ts";
import { ATTEST_TARGET_STEP } from "../../executor/guards.ts";
import { repoURLSchema, unitNameSchema, type BuildPorts } from "#unit/server/build-chain.ts";
import { gone } from "./offboard.run.ts";

// offboard of a CI-only unit (onboard-ci-only.ts): the unit has no apps row, no stage, no cluster of
// its own and no Application beyond the build plane's `<name>-build`, so the row-driven
// consumer-offboard cannot name it and the stage-driven consumer-purge needs a stage it never had.
// This run kind is keyed on the unit and removes exactly what the CI-only onboarding made: the push
// webhook, the build registration (GitOps then prunes the `<name>-build` Application with its
// namespace, pipelines and build Secrets) and the repository token in the build Vault.
//
// It refuses a unit that deploys or builds anything: that unit has stage files and a release kit
// this run does not remove, and taking its build registration would break its releases.

export const OffboardCiOnlyParams = z.object({
  consumerName: unitNameSchema,
  // Read off the registration by the route that plans the run, because the steps after the
  // registration is removed still need the repository to look for its webhook.
  repoURL: repoURLSchema,
});
export type OffboardCiOnlyParams = z.infer<typeof OffboardCiOnlyParams>;

export type OffboardCiOnlyPorts = Pick<BuildPorts, "registrations" | "seeder" | "githubApp" | "github" | "buildArgo" | "argoWatchTimeoutMs" | "resolveBuildPlaneFqdn" | "webhookSubdomain">;

/** The registration this run is about, or the reason it may not touch it. Asked at plan time and again
 *  as the first step, because the tree can change between the approve and the run. */
export async function attestCiOnlyUnit(ports: Pick<OffboardCiOnlyPorts, "registrations">, p: OffboardCiOnlyParams): Promise<void> {
  const read = await ports.registrations.readBuildRegistration(p.consumerName);
  if (read === null) throw errNotFound(`build registration of ${p.consumerName}`);
  const stages = await ports.registrations.readUnitStages(p.consumerName);
  if (!isCiOnly(read.entry, stages)) {
    throw errValidation(`${p.consumerName} is not a CI-only unit (${stages.length > 0 ? `it stands at ${stages.join(", ")}` : `it builds ${read.entry.builds?.join(", ")}`}) — offboard it with the consumer offboard, which removes what it releases and deploys`);
  }
  if (read.entry.repoURL !== p.repoURL) {
    throw errValidation(`${p.consumerName} is registered for ${read.entry.repoURL}, not ${p.repoURL}`);
  }
}

function offboardCiOnlySteps(ports: OffboardCiOnlyPorts, p: OffboardCiOnlyParams): Step[] {
  return [
    {
      name: ATTEST_TARGET_STEP,
      title: "Attest the unit is CI-only",
      run: async (ctx) => {
        await attestCiOnlyUnit(ports, p);
        ctx.log("meta", `${p.consumerName} registers no builds and no stage — a CI-only unit`);
      },
    },
    {
      name: "remove-webhook",
      title: "Remove the repository's push webhook",
      run: async (ctx) => {
        // Before the registration goes, so a run that stops between the two can be retried: the
        // delete is idempotent and the identity that opens it is the owner's, which outlives the unit.
        await removeConsumerWebhook(ctx, {
          github: ports.github,
          consumerName: p.consumerName,
          repoURL: p.repoURL,
          repoCredentialId: await unitRepoCredentialId({ repoURL: p.repoURL, githubApp: ports.githubApp, owners: (org) => readOwnerIdentity(ctx.db, org), store: ctx.creds, signal: ctx.signal }),
        });
      },
    },
    {
      name: "remove-registration",
      title: "Remove the build registration",
      run: async (ctx) => {
        const { removed } = await ports.registrations.removeBuildRegistration(p.consumerName, ctx.runId);
        ctx.log("meta", removed
          ? `build registration for ${p.consumerName} removed — GitOps prunes ${unitBuildNamespace(p.consumerName)} with it`
          : `build registration for ${p.consumerName} already removed — skipping (resume)`);
      },
    },
    {
      name: "watch-removal",
      title: "Wait for ArgoCD to prune the unit's build namespace",
      run: async (ctx) => {
        if (!ports.buildArgo) throw errValidation("the master ArgoCD reader is not wired — nothing can confirm that GitOps pruned the unit's build namespace");
        const app = unitBuildNamespace(p.consumerName);
        const status = await ports.buildArgo.watchApplication(MASTER_ARGO_NAMESPACE, app, gone, { timeoutMs: ports.argoWatchTimeoutMs, signal: ctx.signal, failFast: (s) => s.deletionError !== undefined });
        if (!gone(status)) {
          throw errNotFound(`Application ${app} was not pruned — ${status.deletionError ? `ArgoCD reports: ${status.deletionError}` : `last seen health=${status.health}`}; the registration is removed but the namespace lingers`);
        }
        ctx.log("meta", `Application ${app} pruned`);
      },
    },
    {
      name: "remove-repo-pat",
      title: "Remove the unit's repository token (build Vault)",
      run: async (ctx) => {
        // After the prune: the namespace's ExternalSecrets read this entry until the Application is gone.
        await ports.seeder.deleteBuildRepoPat({ consumerName: p.consumerName });
        ctx.log("meta", `repo PAT removed — ${KV_MOUNT}/build/${p.consumerName}/repo-pat deleted`);
      },
    },
    {
      name: "assert-no-orphans",
      title: "Assert nothing of the unit is left standing",
      run: async (ctx) => {
        // Measures instead of acting: the webhook removal is fail-soft, so a run can reach here
        // having only logged about a hook that still fires. The Vault entry cannot be read back
        // (the seeder is write-only); its delete is fail-closed instead.
        const left: string[] = [];
        const gonePieces: string[] = [];
        const look = (what: string, present: boolean): void => {
          (present ? left : gonePieces).push(what);
        };
        look(`registration registrations/${p.consumerName}/build.yaml`, (await ports.registrations.readBuildRegistration(p.consumerName)) !== null);
        if (ports.buildArgo) look(`Application ${unitBuildNamespace(p.consumerName)}`, (await ports.buildArgo.getApplication(MASTER_ARGO_NAMESPACE, unitBuildNamespace(p.consumerName))) !== null);
        if (!ports.github) throw errValidation(`cannot look for a leftover webhook of ${p.consumerName}: no GitHub client is wired on this manager`);
        const credentialId = await unitRepoCredentialId({ repoURL: p.repoURL, githubApp: ports.githubApp, owners: (org) => readOwnerIdentity(ctx.db, org), store: ctx.creds, signal: ctx.signal });
        if (!credentialId) throw errValidation(`cannot look for a leftover webhook of ${p.consumerName}: no identity reaches ${p.repoURL}`);
        const token = await ctx.creds.open(credentialId, { purpose: "consumer-offboard-ci-only:assert-no-orphans", runId: ctx.runId });
        try {
          const targetUrl = webhookTargetUrl(await ports.resolveBuildPlaneFqdn(resolveMasterCluster(ctx.db).domain), ports.webhookSubdomain);
          look(`push webhook ${targetUrl}`, await ports.github.hookStandsAt({ ...parseGitHubOwnerRepo(p.repoURL), token: token.toString("utf8"), targetUrl, signal: ctx.signal }));
        } finally {
          token.fill(0);
        }
        if (left.length > 0) {
          throw errValidation(`the offboard of CI-only unit ${p.consumerName} left ${left.length} object(s) standing: ${left.join("; ")}. Remove them and retry this step.`);
        }
        ctx.checkpoint({ gone: gonePieces });
        ctx.log("meta", `nothing of ${p.consumerName} is left standing — read back and gone: ${gonePieces.join(", ")}`);
      },
    },
    {
      name: "record-offboard",
      title: "Record the CI-only unit as offboarded",
      run: async (ctx) => {
        // The unit has no apps row, so the run record is the only record.
        ctx.checkpoint({ consumerName: p.consumerName, repoURL: p.repoURL });
        ctx.log("meta", `CI-only unit ${p.consumerName} offboarded — ${p.repoURL} no longer runs CI on a push`);
      },
    },
  ];
}

export function makeOffboardCiOnlyDef(ports: OffboardCiOnlyPorts): RunDefinition<OffboardCiOnlyParams> {
  return {
    kind: "consumer-offboard-ci-only",
    paramsSchema: OffboardCiOnlyParams,
    mutating: true, // mutating ⇒ steps()[0] MUST be attest-target
    plan: async (params, { db }) => {
      await attestCiOnlyUnit(ports, params);
      const master = resolveMasterCluster(db);
      const stepDefs = offboardCiOnlySteps(ports, params);
      return {
        kind: "consumer-offboard-ci-only",
        targetKind: "cluster",
        targetId: master.clusterId, // the build plane — the one cluster this unit touches
        summary: `Offboard CI-only unit "${params.consumerName}": ${stepDefs.length} steps — remove the push webhook of ${params.repoURL}, remove the build registration, wait for ArgoCD to prune the build namespace, delete the repository token from the build Vault, and read back that nothing is left. The repository itself is not touched. The Vault entry is NOT recoverable.`,
        steps: stepDefs.map((s) => ({ name: s.name, title: s.title })),
        targets: [],
        locks: [
          { resource: "git-branch", key: ports.registrations.branch },
          { resource: "master-kube", key: "m" },
        ],
        warnings: [],
        requiredSecrets: [],
      };
    },
    steps: (params) => offboardCiOnlySteps(ports, params),
  };
}
