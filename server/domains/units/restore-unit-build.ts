// The unit-scoped build parts a consumer restore brings back: the repository token in the build Vault
// (`build/<unit>/repo-pat`), the release kit in the consumer repository and the build webhook. The
// offboard of a unit's last stage removes all three (offboard.run.ts), so without them a restored unit
// runs on its pinned images but its build Application cannot read its git secret, a push builds
// nothing and no release can be cut.
//
// Each step runs the onboarding's own step, which is idempotent: the seed attests an entry that
// stands, the kit commits nothing when it stands, ensureHook keeps one hook per repository. They come
// after `record`: the unit is restored and open by then, and the restore's compensations remove
// nothing of a unit whose row is no longer offboarded (restore-cleanups.ts offboardedApp), so a failed
// step leaves a running unit and a run that can be resumed.
import { eq } from "drizzle-orm";
import type { Step, StepCtx } from "../../executor/types.ts";
import type { Db } from "../../db/client.ts";
import { apps } from "../../db/schema/inventory.ts";
import { errValidation } from "../../kernel/errors.ts";
import type { Stage } from "../../../shared/enums.ts";
import type { BuildPorts, BuildParams } from "#unit/server/build-chain.ts";
import { seedRepoPatStep } from "#unit/server/seed-repo-pat.ts";
import { injectReleaseKitStep } from "#unit/server/inject-release-kit.ts";
import { setupWebhookStep } from "#unit/server/build-webhook.ts";
import { unitStaysRegistered } from "#unit/server/lifecycle.ts";
import { resolveRepoCredentialId } from "#unit/server/repo-identity.ts";
import { readOwnerIdentity } from "#unit/server/owners.ts";
import { loadActiveTargetCluster } from "#unit/server/relocation-target.ts";
import { loadAppCluster } from "./lifecycle.ts";
import type { ConsumerRelocationPorts } from "./relocation-world-consumer.ts";

type UnitBuildSource = Pick<BuildParams, "consumerName" | "repoURL" | "repoCredentialId" | "domain">;
type RestorePorts = Pick<ConsumerRelocationPorts, "registrations" | "githubApp" | "store">;

function repoUrlOf(db: Db, appId: string, name: string): string {
  const row = db.select({ repoUrl: apps.repoUrl }).from(apps).where(eq(apps.id, appId)).get();
  if (!row?.repoUrl) throw errValidation(`consumer "${name}" has no repo URL on record — nothing says which repository its build parts belong to`);
  return row.repoUrl;
}

/** What the plan says about the build parts. The restored stage is not counted: a registration of its
 *  own can stand only where an earlier restore was aborted without its cleanup. Where no credential
 *  reaches the repository, the plan's manifest read has refused already (planRestoreSecrets). */
export async function planUnitBuildRestore(ports: Pick<RestorePorts, "registrations">, unit: { name: string; stage: Stage }): Promise<string> {
  const elsewhere = (await ports.registrations.readUnitStages(unit.name)).filter((standing) => standing !== unit.stage);
  if (elsewhere.length > 0) {
    return `${unit.name} stays registered at ${elsewhere.join(", ")}, so its repository token, release kit and build webhook still stand and stay as they are`;
  }
  return `${unit.name} has no other stage, so its offboard removed its repository token, release kit and build webhook; the restore brings all three back after it records the unit, from the credential its repository is reached with`;
}

/** The build source of the restored unit, read at run time: the credential resolved now, and the
 *  target cluster whose map names the build plane. */
async function unitBuildSource(ports: RestorePorts, ctx: StepCtx, params: { appId: string; targetClusterId: string }): Promise<UnitBuildSource> {
  const ac = loadAppCluster(ctx.db, params.appId);
  const repoURL = repoUrlOf(ctx.db, params.appId, ac.name);
  const repoCredentialId = await resolveRepoCredentialId({ repoURL, githubApp: ports.githubApp, owners: (org) => readOwnerIdentity(ctx.db, org), store: ctx.creds, signal: ctx.signal });
  return { consumerName: ac.name, repoURL, repoCredentialId, domain: loadActiveTargetCluster(ctx.db, params.targetClusterId).domain };
}

/** The commit the default branch stands at now, whose `.npmrc` says which packages reader the seed
 *  needs; the onboarding reads it at the commit its plan resolved. */
async function headCommit(build: BuildPorts, source: UnitBuildSource, ctx: StepCtx): Promise<string> {
  const head = await build.repo.cloneAtRef({ repoURL: source.repoURL, ref: "HEAD", credentialId: source.repoCredentialId, signal: ctx.signal });
  await build.repo.dispose(head.workdir);
  return head.resolvedSha;
}

function restoreUnitPart(ports: RestorePorts, params: { appId: string; targetClusterId: string }, part: { name: string; title: string; subject: string; step: (source: UnitBuildSource, ctx: StepCtx) => Step | Promise<Step> }): Step {
  return {
    name: part.name,
    title: part.title,
    run: async (ctx) => {
      const ac = loadAppCluster(ctx.db, params.appId);
      if (await unitStaysRegistered(ctx, ports.registrations, { name: ac.name, stage: ac.stage }, part.subject)) return;
      await (await part.step(await unitBuildSource(ports, ctx, params), ctx)).run(ctx);
    },
  };
}

/** The three steps that follow `record` in a consumer restore. */
export function restoreUnitBuildSteps(ports: RestorePorts, build: BuildPorts, params: { appId: string; targetClusterId: string }): Step[] {
  return [
    restoreUnitPart(ports, params, {
      name: "restore-repo-pat",
      title: "Bring back the unit's repository token and its owner's packages reader in the local build Vault",
      subject: "the repository token",
      step: async (source, ctx) => seedRepoPatStep(build, { ...source, resolvedSha: await headCommit(build, source, ctx) }),
    }),
    restoreUnitPart(ports, params, {
      name: "restore-release-kit",
      title: "Bring back the release kit in the consumer repo (release/ + workflow)",
      subject: "the release kit",
      step: (source) => injectReleaseKitStep(build, source),
    }),
    restoreUnitPart(ports, params, {
      name: "restore-webhook",
      title: "Bring back the consumer's build webhook (push → Tekton)",
      subject: "the build webhook",
      step: (source) => setupWebhookStep(build, source),
    }),
  ];
}
