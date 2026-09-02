// The onboard `preflight-scopes` step. Onboarding TAKES three rights into the
// consumer's own repo — repo (clone + push scripts), workflow (write .github/workflows/release.yml),
// admin:repo_hook (create the build webhook). Without this step they are discovered REACTIVELY: the
// run fails at setup-webhook for a missing admin:repo_hook, then — once that is fixed — at
// inject-release-kit for a missing workflow, and each miss costs a fresh token round-trip with the
// consumer (a classic PAT's scopes cannot be edited after creation). This step verifies ALL THREE in one shot, at the very
// start of the run (before the check and every seed/mutation), and
// fails with the COMPLETE missing set — never one scope at a time.
//
// It is a pure READ (a single GET /repos/{owner}/{repo} off the consumer PAT, reading X-OAuth-Scopes),
// so a scope gap rejects the run before ANYTHING is written. FAIL-CLOSED: an unwired GitHub client, a
// fine-grained token (no scope metadata — the onboard model is a classic-PAT contract), an invalid PAT,
// or any missing required scope throws and rejects the run.
//
// SECURITY: the consumer PAT is opened from the sealed store in-run, sent only as the GitHub Bearer
// auth header (readTokenScopes), and its Buffer is zeroed after use — never logged.
import type { Step } from "../../executor/types.ts";
import type { OnboardPorts, OnboardParams } from "./onboard.run.ts";
import { WebhookScopeError } from "../../adapters/github-consumer/port.ts";
import { parseGitHubOwnerRepo } from "./onboard-webhook.ts";
import { errValidation } from "../../kernel/errors.ts";
import { REQUIRED_CONSUMER_PAT_SCOPES, missingConsumerPatScopes, requiredConsumerPatScopesSummary } from "./pat-scopes.ts";

/** The onboard `preflight-scopes` step: verify the consumer PAT carries EVERY right the onboard needs
 *  on the consumer repo — repo + workflow + admin:repo_hook — up front, before any mutation, and fail
 *  with the COMPLETE missing set (never one scope at a time). Fail-closed on an unwired client, a
 *  fine-grained/invalid token, or any missing scope. */
export function preflightScopesStep(ports: OnboardPorts, p: OnboardParams): Step {
  return {
    name: "preflight-scopes",
    title: "Pre-flight the consumer PAT scopes (repo + workflow + admin:repo_hook)",
    run: async (ctx) => {
      // Fail-loud wiring gap (setup-webhook precedent): the scope check reuses the per-call consumer-PAT
      // GitHub client, which onboard UNCONDITIONALLY needs (setup-webhook fails without it), so an
      // unwired client is a manager misconfiguration, never a silent skip.
      if (!ports.github) {
        throw errValidation(`onboard "${p.consumerName}" requires the GitHub client to pre-flight the consumer PAT scopes but none is wired on this manager — refusing to onboard without verifying ${REQUIRED_CONSUMER_PAT_SCOPES.join(" + ")} up front`);
      }
      const { owner, repo } = parseGitHubOwnerRepo(p.repoURL);
      const pat = await ctx.creds.open(p.repoCredentialId, { purpose: "consumer-onboard:preflight-scopes", runId: ctx.runId });
      let token;
      try {
        token = await ports.github.readTokenScopes({ owner, repo, token: pat.toString("utf8"), signal: ctx.signal });
      } catch (err) {
        if (err instanceof WebhookScopeError) {
          throw errValidation(`onboard "${p.consumerName}": the consumer PAT for ${owner}/${repo} is invalid or expired (${err.message}). Provide a valid CLASSIC personal access token with ${REQUIRED_CONSUMER_PAT_SCOPES.join(" + ")} and re-onboard.`);
        }
        throw err;
      } finally {
        pat.fill(0);
      }
      // A fine-grained token carries no scope metadata, so the required-set contract cannot be proven —
      // and the whole onboard model (webhook admin, workflow write) is a classic-PAT contract. Fail
      // closed with a clear "use a classic PAT" ask rather than let a possibly-underprivileged token
      // slip through to setup-webhook / inject-release-kit and fail there.
      if (!token.classic) {
        throw errValidation(`onboard "${p.consumerName}": the consumer PAT for ${owner}/${repo} looks like a fine-grained token (GitHub returned no scope metadata). The onboard needs a CLASSIC personal access token with ALL of: ${requiredConsumerPatScopesSummary()}. Create a classic PAT with these scopes and re-onboard.`);
      }
      const missing = missingConsumerPatScopes(token.scopes);
      if (missing.length > 0) {
        throw errValidation(`onboard "${p.consumerName}": the consumer PAT for ${owner}/${repo} is missing the ${missing.length === 1 ? "scope" : "scopes"} ${missing.join(" + ")}. The onboard needs a classic PAT with ALL of: ${requiredConsumerPatScopesSummary()}. A classic PAT's scopes cannot be edited after creation — mint a NEW token with every scope above (and delete the old one), then re-onboard. (Granted: ${token.scopes.join(", ") || "none"}.)`);
      }
      ctx.checkpoint({ patScopes: token.scopes, owner, repo });
      ctx.log("meta", `consumer PAT scopes OK for ${owner}/${repo} — ${REQUIRED_CONSUMER_PAT_SCOPES.join(" + ")} all present (granted: ${token.scopes.join(", ")})`);
    },
  };
}
