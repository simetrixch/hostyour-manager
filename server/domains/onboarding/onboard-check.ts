// The onboard `check` step. Split out of onboard.run.ts (like onboard-webhook.ts /
// onboard-release-kit.ts) so the run file stays a thin orchestrator; the gates themselves live in
// validate.ts — this step only runs them and holds the outcome against the approved facts.
import type { Step } from "../../executor/types.ts";
import type { OnboardPorts, OnboardParams } from "./onboard.run.ts";
import { validateOnboard, type OnboardTarget } from "./validate.ts";
import { errValidation } from "../../kernel/errors.ts";

/** The ref cloned before the gates run — the remote's default branch head. The onboarding validates
 *  what the repo IS, not a pin: only the release cycle ever turns a commit into something deployable. */
export const DEFAULT_BRANCH_HEAD = "HEAD";

/** The gates against the repo's default-branch head — at EXECUTE time, so the repo the run
 *  mutates is the repo that was checked, not a plan-time snapshot. There is no pin to hold it to:
 *  the head may legitimately move between approve and execute, and the release cycle builds whatever
 *  the minted tag points at. What must NOT move are the facts the approval froze and the later steps
 *  commit — the build names (build.yaml), the databases, services and fqdn (the stage registration),
 *  the secret specs (the create-only Vault seed) and the activation (the call the minted bootstrap
 *  token is sent to) — so a drift in those rejects the run instead of committing facts nobody
 *  approved. */
export function checkStep(ports: OnboardPorts, p: OnboardParams): Step {
  return {
    name: "check",
    title: "Check the repo against the concept (the gates)",
    run: async (ctx) => {
      const target: OnboardTarget =
        p.form === "build-only"
          ? { domain: p.domain, stage: p.stage, clusterValueFiles: [] }
          : {
              domain: p.domain,
              stage: p.stage,
              chartPath: p.chartPath,
              // Re-read rather than frozen: the chain is the platform's own surface, so the chart is
              // held against what the Application will actually layer at sync.
              clusterValueFiles: await ports.registry.readClusterValueFiles(p.domain, p.stage),
            };
      const outcome = await validateOnboard(
        { repoURL: p.repoURL, ref: DEFAULT_BRANCH_HEAD, consumerName: p.consumerName, repoCredentialId: p.repoCredentialId },
        target,
        { repo: ports.repo, runner: ports.runner, registry: ports.registry, tenantSubdomains: ports.tenantSubdomains, log: (l) => ctx.log("stdout", l), signal: ctx.signal, attestListening: ports.attestListening },
      );
      if (outcome.verdict !== "pass" || outcome.builds === null) {
        const failed = outcome.report.gates.filter((g) => g.status !== "pass");
        throw errValidation(`the gates failed at the current default-branch head — ${failed.length} gate(s) did not pass: ${failed.map((g) => g.id).join(", ")}`);
      }
      const drift: string[] = [];
      if (JSON.stringify(outcome.builds) !== JSON.stringify(p.builds)) {
        drift.push(`builds[] is now [${outcome.builds.join(", ")}], approved as [${p.builds.join(", ")}]`);
      }
      if (p.form === "deployable") {
        const m = outcome.report.manifest;
        if (JSON.stringify(m?.databases ?? []) !== JSON.stringify(p.databases)) drift.push("databases changed since approval");
        if (JSON.stringify(m?.services ?? []) !== JSON.stringify(p.services)) drift.push("services changed since approval");
        // The fqdn the approval attests must be the fqdn the manifest declares NOW — a swap here
        // would commit a grant nobody saw in the plan.
        if ((m?.fqdn ?? null) !== (p.fqdn ?? null)) drift.push("fqdn changed since approval");
        // seed-secrets writes ONE create-only Vault entry (cas=0) from the frozen specs — permanent,
        // since a re-run never rotates or extends it. A secrets block that moved since approval would
        // otherwise seed a key set the chart at the current head no longer matches, and the missing
        // key could only ever arrive via offboard/purge.
        if (JSON.stringify(m?.secrets ?? []) !== JSON.stringify(p.secretSpecs)) drift.push("secrets changed since approval");
        // The activate step sends the seed-minted bootstrap token to the frozen call shape — a block
        // that moved since approval would hand that token to an endpoint nobody saw in the plan.
        if (JSON.stringify(m?.activation ?? null) !== JSON.stringify(p.activation ?? null)) drift.push("activation changed since approval");
      }
      if (drift.length > 0) {
        throw errValidation(`the repo changed since this plan was approved — ${drift.join("; ")}. The registration would commit facts nobody approved; discard this run and plan the onboarding again.`);
      }
      if (outcome.resolvedSha !== p.resolvedSha) {
        ctx.log("meta", `default branch moved since planning (${p.resolvedSha.slice(0, 7)} → ${outcome.resolvedSha.slice(0, 7)}) — the gates re-passed at the current head, and the release cycle builds whatever the minted tag points at`);
      }
      ctx.log("meta", `check passed — verdict pass over ${outcome.report.gates.length} gates at ${outcome.resolvedSha.slice(0, 7)}`);
    },
  };
}
