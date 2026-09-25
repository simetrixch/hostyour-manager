// The deployable form's `write-registration` step. Split out of onboard.run.ts (like onboard-check.ts)
// so the run file stays a thin orchestrator; the build-only form's twin and its record are the unit's
// (plugins/unit/server/build-registration.ts), and the writer itself is the Registrations, the ONE
// writer of registrations/**.
import type { Step } from "../../executor/types.ts";
import { resolveUnitQuota } from "#unit/server/unit-size.ts";
import type { OnboardPorts, DeployableOnboardParams } from "./onboard.run.ts";
import { deployableOnboardCleanups } from "./onboard-abort.ts";

/** The deployable form's registration commit: build.yaml (the attested build names) PLUS this
 *  stage's file, in ONE commit. It runs FIRST after the check — the registration is what
 *  makes the unit's release pipeline exist, and everything after provisions the ground that pipeline
 *  and the generated Application stand on. */
export function writeRegistrationStep(ports: OnboardPorts, p: DeployableOnboardParams): Step {
  return {
    name: "write-registration",
    title: "Commit the consumer registration (GitOps)",
    run: async (ctx) => {
      // Arm the WHOLE ordered rollback BEFORE the commit — registration removal, prune wait, object
      // deletes (onboard-abort.ts). One step registers all of them because abortWithCleanup keeps one
      // step's registrations in written order while reversing across steps: armed piecemeal, the
      // AppProject delete ran BEFORE the registration removal, against an Application still
      // referencing it. Every entry is idempotent, so arming ahead of steps the run may never reach
      // costs nothing. The gate report is NOT committed — it lives in this run's record.
      for (const c of deployableOnboardCleanups(ports, p)) ctx.registerCleanup(c);
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
        deploy: {
          stage: p.stage,
          chartPath: p.chartPath,
          cluster: p.cluster,
          host: p.host, // the attested public host label — the appset composes unitHost from it
          databases: p.databases, // literal Mongo DB name(s), copied verbatim from the manifest
          keyPatterns: p.keyPatterns, // literal redis key patterns — the grant the unit's fence holds its claim to
          channelPatterns: p.channelPatterns, // literal redis channel patterns — the same grant for Pub/Sub
          services: p.services, // claimed services, copied verbatim — a chart source gates on this
          // The unit's one size, and what it brings — the appset names the database presets from
          // the first and gates its conditional sources on the second.
          size: p.size,
          mongodb: p.mongodb,
          // The namespace ceiling, RESOLVED here rather than carried in the plan: the size table is
          // editable while the platform runs, so the figures a unit is onboarded with must be the ones
          // standing when the registration is written, not the ones that stood when the run was planned.
          // A plan that sat waiting for approval over a table edit would otherwise commit the old size.
          quota: resolveUnitQuota(ctx.db, p.size, {
            // WHAT the consumer brings decides how much of the table applies. Both come from its own
            // manifest — it declares what it needs, the operator declares how big — so a consumer with
            // its own database gets a ceiling that covers it instead of one that starves it.
            postgresql: p.services.includes("postgresql"),
            mongodb: p.mongodb,
          }),
          // the ATTEST of the manifest's declared extra FQDN (G19-checked, plan-frozen): from this
          // commit on, the platform serves the name — the admission policy and the chart read it here
          ...(p.fqdn !== undefined ? { fqdn: p.fqdn } : {}),
          // the ATTEST of the manifest's SMTP entry (G29-checked, plan-frozen): from this commit on
          // the unit is its stage's mail sender
          ...(p.smtpEntry !== undefined ? { smtpEntry: p.smtpEntry } : {}),
        },
        runId: ctx.runId,
      });
      ctx.checkpoint({ commit, registration: `registrations/${p.consumerName}/${p.stage}.yaml` });
      ctx.log("meta", `registration committed (${commit}) — the unit's release pipeline renders from build.yaml, and the ArgoCD on ${p.domain} generates the Application (it converges once the release cycle below fills the delivery branch)`);
    },
  };
}
