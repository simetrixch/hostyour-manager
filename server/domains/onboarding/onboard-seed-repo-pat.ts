// The onboard `seed-repo-pat` step. Split out of onboard.run.ts (like onboard-webhook.ts /
// onboard-activate.ts / secret-mint.ts) so the run file stays a thin orchestrator and the one
// per-unit PAT write is a small, self-contained unit.
import type { Step } from "../../executor/types.ts";
import { KV_MOUNT } from "../../adapters/vault/port.ts";
import type { OnboardPorts, OnboardParams } from "./onboard.run.ts";

/** The onboard `seed-repo-pat` step: write the ONE per-unit GitHub PAT (the SAME value the
 *  Controller clones with) to secret/build/<name>/repo-pat (property `pat`) on the LOCAL Vault — the
 *  entry the unit's consumer-build ExternalSecrets (clone credential, npmrc, the bump credential)
 *  read. The controller runs on the build-plane cluster, so its own Vault IS the build plane's and
 *  there is no target-cluster resolution. Stage-free: one build plane, one PAT per unit.
 *
 *  ATTEST-OR-CREATE (cas=0): the seven platform units were hand-seeded before the run kind existed, so a
 *  path that already stands is attested (`created: false`) and never overwritten — the write-only
 *  rule on data holds, and the cas conflict is the existence proof. UNCONDITIONAL in both onboard
 *  forms and fail-closed: a failed write fails the run. The value is opened from the sealed store
 *  (never re-plumbed raw through params) and zeroed after the write. */
export function seedRepoPatStep(ports: OnboardPorts, p: OnboardParams): Step {
  return {
    name: "seed-repo-pat",
    title: "Seed the unit's repo PAT into the local build Vault",
    run: async (ctx) => {
      const pat = await ctx.creds.open(p.repoCredentialId, { purpose: "onboard:seed-repo-pat", runId: ctx.runId });
      let created: boolean;
      try {
        ({ created } = await ports.seeder.seedBuildRepoPat({ consumerName: p.consumerName, pat: pat.toString("utf8") }));
      } finally {
        pat.fill(0);
      }
      const path = `${KV_MOUNT}/build/${p.consumerName}/repo-pat`;
      ctx.checkpoint({ path, created });
      ctx.log(
        "meta",
        created
          ? `repo PAT seeded to ${path} (property pat) — the unit's build namespace can now clone, read packages and push its bump`
          : `repo PAT already present at ${path} — attested and left untouched (create-only). To rotate it, delete the entry deliberately and re-onboard.`,
      );
    },
  };
}
