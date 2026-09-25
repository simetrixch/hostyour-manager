// The onboard `seed-repo-pat` step, and the `refresh-repo-pat` step a release of a unit whose
// credential is the platform's GitHub App runs first. Split out of onboard.run.ts (like
// onboard-webhook.ts / onboard-activate.ts / secret-mint.ts) so the run file stays a thin
// orchestrator and the per-unit PAT writes are a small, self-contained unit.
import type { Step } from "../../executor/types.ts";
import { KV_MOUNT } from "../../adapters/vault/port.ts";
import { errValidation } from "../../kernel/errors.ts";
import type { OnboardPorts, OnboardParams } from "./onboard.run.ts";
import { BUILD_TARGET_SECRETS, deleteBuildSecrets, readBuildSecretRefreshTimes, refreshUnitRepoPat } from "./app-token-refresh.ts";
import { unitBuildNamespace } from "./build-rbac.ts";
import { sleep } from "./onboard-release-cycle.ts";
import { probePackages } from "./onboard-probes.ts";
import { CONSUMER_WIZARD, npmrcPackageScopes, packagesReaderFor, packagesReaderMissing } from "./repo-identity.ts";
import { parseGitHubOwnerRepo } from "./onboard-webhook.ts";
import type { StepCtx } from "../../executor/types.ts";
import { readOwnerIdentity } from "./owners.ts";

/** The onboard `seed-repo-pat` step: write the unit's build entry secret/build/<name>/repo-pat on
 *  the LOCAL Vault with its TWO values (#220): property `pat`, the repository token the Manager
 *  clones with (the App's, or the owner's repository PAT), read by the clone credential and
 *  the bump; property `packages`, the owner's packages reader by the owner of the
 *  repository URL, read by the build's `.npmrc` — an App token reads no private package. The
 *  manager runs on the build-plane cluster, so its own Vault IS the build plane's and there is no
 *  target-cluster resolution. Stage-free: one build plane, one entry per unit.
 *
 *  ATTEST-OR-CREATE (cas=0): the seven platform units were hand-seeded before the run kind existed, so a
 *  path that already stands is attested (`created: false`) and never overwritten — the write-only
 *  rule on data holds, and the cas conflict is the existence proof. UNCONDITIONAL in both onboard
 *  forms and fail-closed: a failed write fails the run. The value is opened from the sealed store
 *  (never re-plumbed raw through params) and zeroed after the write. */
/** The owner's packages reader where the repository routes a scope to GitHub Packages (its
 *  `.npmrc` at the pinned commit, read the way the packages probe reads it), null where it routes
 *  none — and a refusal, naming the owner and the scopes, where a scope is routed and the
 *  owner records no reader (#221). */
async function packagesReaderOrRefuse(ports: OnboardPorts, p: OnboardParams, ctx: StepCtx): Promise<string | null> {
  const id = packagesReaderFor((org) => readOwnerIdentity(ctx.db, org), p.repoURL);
  if (id) return id;
  const clone = await ports.repo.cloneAtRef({ repoURL: p.repoURL, ref: p.resolvedSha, credentialId: p.repoCredentialId, signal: ctx.signal });
  let scopes: string[];
  try {
    scopes = npmrcPackageScopes(await ports.repo.readFile(clone.workdir, ".npmrc"));
  } finally {
    await ports.repo.dispose(clone.workdir);
  }
  if (scopes.length > 0) {
    const { owner, repo } = parseGitHubOwnerRepo(p.repoURL);
    throw errValidation(packagesReaderMissing(owner, repo, scopes, CONSUMER_WIZARD));
  }
  ctx.log("meta", `${p.repoURL} routes no scope to GitHub Packages — no packages reader needed, the entry's packages property is empty`);
  return null;
}

export function seedRepoPatStep(ports: OnboardPorts, p: OnboardParams): Step {
  return {
    name: "seed-repo-pat",
    title: "Seed the unit's repository token and its owner's packages reader into the local build Vault",
    // What the seeded packages reader will be asked to read by the build: one private package per scope.
    probe: (ctx) => probePackages(ports, p, ctx),
    run: async (ctx) => {
      const packagesCredentialId = await packagesReaderOrRefuse(ports, p, ctx);
      const pat = await ctx.creds.open(p.repoCredentialId, { purpose: "consumer-onboard:seed-repo-pat", runId: ctx.runId });
      const packages = packagesCredentialId
        ? await ctx.creds.open(packagesCredentialId, { purpose: "consumer-onboard:seed-repo-pat", runId: ctx.runId }).catch((e: unknown) => { pat.fill(0); throw e; })
        : Buffer.alloc(0);
      let created: boolean;
      try {
        ({ created } = await ports.seeder.seedBuildRepoPat({ consumerName: p.consumerName, pat: pat.toString("utf8"), packages: packages.toString("utf8") }));
      } finally {
        pat.fill(0);
        packages.fill(0);
      }
      const path = `${KV_MOUNT}/build/${p.consumerName}/repo-pat`;
      ctx.checkpoint({ path, created });
      ctx.log(
        "meta",
        created
          ? `repository token and packages reader seeded to ${path} (properties pat, packages) — the unit's build namespace can now clone, install private packages and push its bump`
          : `${path} already present — attested and left untouched (create-only). To replace it, delete the entry deliberately and re-onboard.`,
      );
    },
  };
}

/** The `refresh-repo-pat` step: REWRITE the unit's entry with the value its credential opens to now,
 *  DELETE the three build Secrets that carry it, and WAIT until ESO has materialized them again.
 *  For a `github-app` credential the value is a token the App minted this second, so the release
 *  triggered next clones with one that lives a full hour — the boot-time and 45-minute refresh
 *  (app-token-refresh.ts) keeps the entry alive between releases, and this step keeps a release
 *  right after a Manager boot from meeting the value a dead Manager left. The deletion is what
 *  carries the rewrite into the Secrets: the unit's ExternalSecrets read Vault on deploy and on the
 *  deletion of their target and never on a timer (`refreshPolicy: OnChange`). The wait is what keeps
 *  the clone from racing the materialization: the pipeline's clone task reads `build-git-https` the
 *  moment it starts, and a Secret still absent then fails the run. The return is read off each
 *  ExternalSecret's `refreshTime`, the one field that moves on a materialization — `ready` stays
 *  True across the deletion, and the Manager holds no `get` on Secrets. Runs only in the release
 *  re-run of a unit already registered (tenant-apps-steps.ts): the first onboarding seeds the entry
 *  through seed-repo-pat and clones within the hour. */
export function refreshRepoPatStep(ports: OnboardPorts, p: OnboardParams): Step {
  return {
    name: "refresh-repo-pat",
    title: "Rewrite the unit's repo PAT in the local build Vault with a value minted now, and carry it into the build Secrets",
    run: async (ctx) => {
      const kube = ports.buildClusterReader;
      if (!kube) {
        throw errValidation(`onboard "${p.consumerName}" requires the build plane's cluster reader to delete the unit's build Secrets after the repo PAT rewrite but none is wired on this manager — without the deletion ESO keeps the Secrets it wrote before, and the release would clone with the old token`);
      }
      const namespace = unitBuildNamespace(p.consumerName);
      const before = await readBuildSecretRefreshTimes(kube, p.consumerName);
      const packagesCredentialId = await packagesReaderOrRefuse(ports, p, ctx);
      await refreshUnitRepoPat({ store: ctx.creds, seeder: ports.seeder }, p.consumerName, p.repoCredentialId, packagesCredentialId, { purpose: "consumer-onboard:refresh-repo-pat", runId: ctx.runId });
      const path = `${KV_MOUNT}/build/${p.consumerName}/repo-pat`;
      ctx.log("meta", `${path} rewritten (properties pat, packages) with the credentials' current values`);
      await deleteBuildSecrets(kube, p.consumerName);
      ctx.log("meta", `${BUILD_TARGET_SECRETS.join(", ")} deleted in ${namespace} — waiting for ESO to materialize them again from the rewritten entry`);
      const budgetMs = ports.buildSecretsMaterializeMs ?? 2 * 60_000;
      const deadline = Date.now() + budgetMs;
      const pollMs = ports.releasePollIntervalMs ?? 2_000;
      for (;;) {
        const now = await readBuildSecretRefreshTimes(kube, p.consumerName);
        // A Secret stands again once its ExternalSecret's refreshTime moved past the one read before
        // the deletion. Two materializations inside one second read as one, because the API serves
        // the time to the second; the wait then runs out and refuses rather than passing.
        const pending = BUILD_TARGET_SECRETS.filter((name) => now[name] === "" || now[name] === before[name]);
        if (pending.length === 0) break;
        if (Date.now() >= deadline || ctx.signal.aborted) {
          throw errValidation(`${pending.join(", ")} in ${namespace} did not materialize again within ${Math.round(budgetMs / 1000)}s of their deletion — their ExternalSecrets have not written them since, so the release was not dispatched: its clone would read no credential at all. Read the ExternalSecrets in ${namespace} for what ESO says.`);
        }
        await sleep(pollMs, ctx.signal);
      }
      ctx.checkpoint({ path, namespace, secrets: [...BUILD_TARGET_SECRETS] });
      ctx.log("meta", `${BUILD_TARGET_SECRETS.join(", ")} stand again in ${namespace}, materialized from the rewritten entry — the release below clones with it`);
    },
  };
}
