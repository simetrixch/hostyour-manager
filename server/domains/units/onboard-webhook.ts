// The onboard `setup-webhook` step + the shared offboard/purge webhook
// removal. Split out of onboard.run.ts (like onboard-activate.ts / secret-mint.ts) so the webhook
// concern is one small, testable unit and every side of it (create + delete) shares one place for the
// owner/repo parse and the target-URL composition.
//
// setup-webhook runs RIGHT AFTER seed-repo-pat and BEFORE apply-appproject: a webhook-create failure
// must abort the onboard BEFORE the GitOps pointer mutation, so there is never a half-onboarded
// consumer whose build can never fire. Standing rule (owner): no hook → no build.
//
// WHERE THE HOOK POINTS: at the BUILD PLANE, which is a different question from where the unit runs.
// The image-builder EventListener and its build.<host>/github ingress are deployed on exactly one
// cluster; every cluster's map (clusters/active/<fqdn>.yaml) names that cluster in its `build-plane`
// field, and setup-webhook reads the host from there — through resolveBuildPlaneFqdn — for the cluster
// the run is about. Composing the host from the target cluster instead puts the hook on a host that
// serves no /github path: GitHub delivers, nothing answers, and no PipelineRun is ever created.
//
// The REMOVAL composes no host at all. It matches the EventListener PATH on whatever host the hook
// carries (adapters/github-consumer/port.ts deleteHook), because a hook created while the build plane
// stood on another cluster answers to no address this manager composes today — and the removal is
// the last chance anything has to take it: the stale sweep inside ensureHook only reaches such a hook
// on the NEXT onboard of that unit, which after a removal never comes.
//
// SECURITY: the consumer PAT is opened from the sealed store in-run, sent only as the GitHub Bearer
// auth header, and its Buffer is zeroed after use (never logged). The HMAC secret (GITHUB_WEBHOOK_
// SECRET) is read from the manager config — the seeder is write-only, so the manager cannot read
// it back from Vault; a parallel hostyour-cloud change feeds it as env. It is sent only in the create
// payload's config.secret and is never logged. A missing secret makes the step fail LOUD: a hook whose
// secret does not match the EventListener's would have every delivery rejected by its
// X-Hub-Signature-256 check — a silent no-build.
import type { Step, StepCtx, Cleanup } from "../../executor/types.ts";
import type { OnboardPorts, OnboardParams } from "./onboard.run.ts";
import type { GitHubConsumer } from "../../adapters/github-consumer/port.ts";
import { WebhookScopeError, webhookTargetUrl } from "../../adapters/github-consumer/port.ts";
import { unitStaysRegistered } from "./lifecycle.ts";
import { errValidation } from "../../kernel/errors.ts";

/** Non-throwing split of a consumer repoURL (https://github.com/<owner>/<repo>.git) into its GitHub
 *  ORG owner + repo (the URL path), NEVER p.owner (the human/team owner). Returns null on any URL that
 *  is not a github.com/<owner>/<repo>.git — the webhook target is meaningless without both. */
function splitGitHubRepoURL(repoURL: string): { owner: string; repo: string } | null {
  let u: URL;
  try {
    u = new URL(repoURL);
  } catch {
    return null;
  }
  const segments = u.pathname.replace(/^\/+/, "").replace(/\.git$/, "").split("/");
  if (u.hostname !== "github.com" || segments.length !== 2 || !segments[0] || !segments[1]) return null;
  return { owner: segments[0], repo: segments[1] };
}

/** The fail-loud variant for onboard: a bad repoURL here is a hard error (the run cannot set up a hook
 *  without a real owner/repo). */
export function parseGitHubOwnerRepo(repoURL: string): { owner: string; repo: string } {
  const parsed = splitGitHubRepoURL(repoURL);
  if (!parsed) throw errValidation(`cannot derive the GitHub owner/repo from "${repoURL}" — expected https://github.com/<owner>/<repo>.git`);
  return parsed;
}

/** The onboard `setup-webhook` step: create (idempotently) the consumer's push-webhook to the build
 *  plane's image-builder EventListener. Fails LOUD on any missing prerequisite (unwired adapter, absent
 *  HMAC secret, an unreadable cluster map) or a missing-scope PAT — no hook, no build. */
export function setupWebhookStep(ports: OnboardPorts, p: OnboardParams): Step {
  return {
    name: "setup-webhook",
    title: "Set up the consumer's build webhook (push → Tekton)",
    run: async (ctx) => {
      // Fail-loud wiring gap (activation precedent): the step is UNCONDITIONAL (every consumer needs a
      // build trigger), so an unwired GitHub client is a manager misconfiguration, never a silent skip.
      if (!ports.github) {
        throw errValidation(`onboard "${p.consumerName}" requires the GitHub consumer client but none is wired on this manager — refusing to onboard a consumer that can never build (no hook → no build)`);
      }
      // The HMAC secret MUST be present + matching, or the created hook's deliveries would fail the
      // EventListener's X-Hub-Signature-256 check and NO build would ever fire — a silent no-build.
      const secret = ports.webhookSecret;
      if (!secret) {
        throw errValidation(`onboard "${p.consumerName}" cannot set up the build webhook — GITHUB_WEBHOOK_SECRET is not configured on this manager (the EventListener validates X-Hub-Signature-256 against it; a hook without the matching secret never triggers a build)`);
      }
      const { owner, repo } = parseGitHubOwnerRepo(p.repoURL);
      // p.domain is the cluster this run is ABOUT (the target cluster, or the master for a build-only
      // unit); the hook's host is the build plane ITS map names. A map that cannot be read fails the
      // step rather than falling back to p.domain — that fallback is exactly the silent no-build.
      const buildPlaneFqdn = await ports.resolveBuildPlaneFqdn(p.domain);
      const targetUrl = webhookTargetUrl(buildPlaneFqdn, ports.webhookSubdomain);
      // The remove inverse is already armed: write-registration registered the whole ordered rollback
      // (onboard-abort.ts) before the first mutation, removeWebhookCleanup included — so an aborted
      // run never leaves an ORPHAN hook firing spurious dispatch/guard builds on a not-fully-onboarded
      // consumer, and a hook that was never created is the fail-soft no-op of the removal.
      const pat = await ctx.creds.open(p.repoCredentialId, { purpose: "consumer-onboard:setup-webhook", runId: ctx.runId });
      try {
        const { created, id, staleRemoved } = await ports.github.ensureHook({
          owner, repo, token: pat.toString("utf8"), targetUrl, secret, events: ["push"], contentType: "json", signal: ctx.signal,
        });
        ctx.checkpoint({ webhook: id, created, targetUrl, staleRemoved });
        // The replace half surfaced: a hook on the EventListener path but another host is a
        // previous entry point firing into nothing, and ensureHook deleted it before ensuring this one.
        const stale = staleRemoved > 0 ? `; ${staleRemoved} stale EventListener hook(s) on old entry points removed` : "";
        // The plane annotation trails the whole line: put between the URL and the hook's own settings
        // it reads as if the cluster map named push/json/SSL-verify rather than the host.
        const plane = `; that host is the build plane named in ${p.domain}'s cluster map`;
        ctx.log("meta", created
          ? `build webhook created on ${owner}/${repo} (id ${id}) → ${targetUrl} (push, application/json, SSL verify on)${stale}${plane}`
          : `build webhook already present on ${owner}/${repo} (id ${id}) → ${targetUrl} — left as-is (idempotent)${stale}${plane}`);
      } catch (err) {
        if (err instanceof WebhookScopeError) {
          throw errValidation(`onboard "${p.consumerName}" cannot manage the build webhook on ${owner}/${repo}: the consumer PAT lacks the admin:repo_hook scope (GitHub answered HTTP ${err.status ?? "403/404"} on /hooks). Provide a PAT with admin:repo_hook and re-onboard — no hook, no build.`);
        }
        throw err;
      } finally {
        pat.fill(0);
      }
    },
  };
}

/** The teardown inverse of setup-webhook — registered by setup-webhook, run only on an explicit
 *  abort-with-cleanup (apply-appproject / write-pointer precedent). Removes the build webhook so an
 *  aborted onboard (e.g. one that failed at inject-release-kit, before write-pointer) leaves no ORPHAN
 *  hook that would fire spurious builds on a not-fully-onboarded consumer.
 *  Fail-soft (removeConsumerWebhook): a removal failure never blocks the abort.
 *
 *  PER UNIT, so it asks the registration tree first, exactly as the removal run kinds do. The repo carries
 *  ONE hook however many stages deploy from it, and setup-webhook registers this cleanup even when its
 *  ensureHook only found the first stage's hook already there — so without the read, aborting the
 *  onboard of a second stage deletes the hook the live stage releases through, and its pushes stop
 *  reaching the platform entirely. */
export function removeWebhookCleanup(ports: OnboardPorts, p: OnboardParams): Cleanup {
  return {
    name: "remove-consumer-webhook",
    title: "Remove the consumer build webhook (the unit's own goes with its last stage)",
    run: async (ctx) => {
      // A build-only run has no stage registration of its own, so it discounts none.
      const unit = { name: p.consumerName, ...(p.form === "build-only" ? {} : { stage: p.stage }) };
      if (await unitStaysRegistered(ctx, ports.registrations, unit, "the build webhook")) return;
      await removeConsumerWebhook(ctx, {
        github: ports.github,
        consumerName: p.consumerName,
        repoURL: p.repoURL,
        repoCredentialId: p.repoCredentialId,
      });
    },
  };
}

/** Shared, FAIL-SOFT webhook removal for offboard + purge (self-contained teardown): delete the
 *  consumer's build webhook using its PAT.
 *
 *  It names no address. deleteHook matches the platform's EventListener PATH on whatever host the hook
 *  points at, which is what makes the removal complete: a hook created while the build plane stood on
 *  another cluster would never equal the address this manager composes today, and nothing else would
 *  ever come back for it — ensureHook's stale sweep only runs on the NEXT onboard of that same unit.
 *
 *  A removal failure NEVER blocks teardown — every failure path logs a warning and returns. Fail-soft
 *  cases:
 *   - no webhook adapter wired                      → log + skip
 *   - repoURL / repoCredentialId unknown            → log + skip (a true purge orphan with no row)
 *   - the PAT is revoked/absent, or GitHub refuses  → log a warning + continue (a lingering hook is
 *                                                     surfaced for hand-removal, never a crash) */
export async function removeConsumerWebhook(
  ctx: StepCtx,
  opts: {
    github: GitHubConsumer | undefined;
    consumerName: string;
    repoURL: string | null | undefined;
    repoCredentialId: string | null | undefined;
  },
): Promise<void> {
  if (!opts.github) {
    ctx.log("meta", `webhook removal skipped for ${opts.consumerName} — no GitHub consumer client is wired on this manager`);
    return;
  }
  if (!opts.repoURL || !opts.repoCredentialId) {
    ctx.log("meta", `webhook removal skipped for ${opts.consumerName} — no repo URL / sealed consumer PAT available (no inventory row); remove the build webhook by hand if it lingers`);
    return;
  }
  const parsed = splitGitHubRepoURL(opts.repoURL);
  if (!parsed) {
    ctx.log("meta", `webhook removal skipped for ${opts.consumerName} — cannot derive owner/repo from "${opts.repoURL}"`);
    return;
  }
  const { owner, repo } = parsed;
  let pat: Buffer;
  try {
    pat = await ctx.creds.open(opts.repoCredentialId, { purpose: "consumer-offboard:remove-webhook", runId: ctx.runId });
  } catch (err) {
    // The sealed credential may already be revoked (a re-run after remove-repo-pat) or purged — not a
    // teardown blocker. The LIVE build trigger is the hook itself; if we cannot authenticate to remove
    // it, surface it as a warning so an operator can delete it by hand.
    ctx.log("meta", `webhook NOT removed for ${opts.consumerName} on ${owner}/${repo} — the consumer PAT is unavailable (${err instanceof Error ? err.message : String(err)}); remove the repo's build webhook by hand if it lingers`);
    return;
  }
  try {
    const { deleted, urls } = await opts.github.deleteHook({ owner, repo, token: pat.toString("utf8"), signal: ctx.signal });
    ctx.log("meta", deleted > 0
      ? `build webhook removed on ${owner}/${repo} (${deleted} hook(s): ${urls.join(", ")})`
      : `no build webhook to remove on ${owner}/${repo} — the repo carries none on the build EventListener's path`);
  } catch (err) {
    // Fail-soft: a scope refusal / transport error must not block offboard/purge. Warn so a lingering
    // build trigger stays visible.
    ctx.log("meta", `webhook NOT removed for ${opts.consumerName} on ${owner}/${repo} — ${err instanceof Error ? err.message : String(err)}; remove the repo's build webhook by hand if it lingers`);
  } finally {
    pat.fill(0);
  }
}
