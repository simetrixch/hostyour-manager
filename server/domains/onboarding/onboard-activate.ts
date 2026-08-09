// The onboard `activate` step. Split out of onboard.run.ts (like
// secret-mint.ts) so that file stays lean and the activation concern is a single, testable unit.
//
// It runs LAST, only when the consumer's manifest declares an `activation:` block, and calls the
// declared endpoint over the consumer's OWN public ingress with the seed-minted bootstrap token
// (`runtime.bootstrapToken`, kept in-run memory by seed-secrets — never persisted) plus the operator's
// approve-time inputs. The token rides ONLY the declared header; the returned activate_url is surfaced
// in ONE line on the live-only ephemeral stream — the only place it is ever shown — and stored nowhere.
import type { Step } from "../../executor/types.ts";
import type { OnboardPorts, DeployableOnboardParams } from "./onboard.run.ts";
import { errValidation } from "../../kernel/errors.ts";
import { ACTIVATION_RESULT_MARKER } from "../../../shared/api-types.ts";
import { EPHEMERAL_STREAM } from "../../../shared/enums.ts";
// The activate_url / mail readers + the mail line live in activation-result.ts, shared with the
// tenant's create-tenant-activate.ts so both invite steps parse + surface the response identically.
import { extractActivateUrl, extractMail, mailLine } from "./activation-result.ts";

/** Build the `activate` step. Closes over `runtime` (the seed-minted token) so it reads a value that
 *  was never persisted; onboardSteps appends it only when `p.activation` is set. */
export function activateStep(ports: OnboardPorts, p: DeployableOnboardParams, runtime: { bootstrapToken?: string | undefined }): Step {
  return {
    name: "activate",
    title: "Run the manifest-declared post-onboard activation",
    run: async (ctx) => {
      const act = p.activation!; // present — this step is appended only when p.activation is set
      const token = runtime.bootstrapToken;
      if (token === undefined) {
        // No token in memory ⇒ seed-secrets did NOT create the entry in THIS run: either the consumer's
        // secrets already existed (a re-onboard) or the run resumed past seed-secrets after a restart.
        // The token minted at the true first onboard is in-run memory only (never persisted), so it is
        // unrecoverable here — and the first-admin bootstrap is a ONE-TIME action anyway (the endpoint
        // is single-shot). Skip loudly + clearly rather than send a wrong/absent token. Idempotent,
        // exactly like seed-secrets' create-only re-run: a re-onboard stays green.
        ctx.log(
          "meta",
          `activation "${act.method} ${act.path}" skipped — the bootstrap token was not minted in THIS run ` +
            `(the consumer's secrets already existed, or the run resumed past seed-secrets). First-admin ` +
            `activation is a one-time action; drive it from a fresh onboard only if no admin exists yet.`,
        );
        return;
      }
      // The operator-supplied dynamic args (NOT secrets): collected in the clear at approve and carried
      // in the run-secrets channel under `activation-input:<field>` (never sealed, never in params).
      const body: Record<string, string> = {};
      for (const pr of act.prompt) {
        const v = ctx.secrets.get(`activation-input:${pr.field}`)?.toString("utf8");
        if (!v) throw errValidation(`activation requires operator input "${pr.field}" (${pr.label}) — it was not supplied at approve`);
        body[pr.field] = v;
      }
      if (!ports.activator) throw errValidation(`consumer "${p.consumerName}" declares an activation but no activator is wired on this controller — refusing to skip a declared activation silently`);
      // The call goes to the consumer's OWN public ingress — the unit's one host <name>.<unitApex>,
      // the same composition the admission policy pins and provision-dns resolved. The token rides
      // ONLY the declared header — never the URL/body/log.
      const url = `https://${p.consumerName}.${p.unitApex}${act.path}`;
      ctx.log("meta", `activating: ${act.method} ${url} with header ${act.tokenHeader} (token withheld)${act.prompt.length ? ` + fields ${act.prompt.map((x) => x.field).join(", ")}` : ""}`);
      const res = await ports.activator.invoke({ url, method: act.method, tokenHeader: act.tokenHeader, token, body, signal: ctx.signal });
      // Drop the in-run token as soon as the call has consumed it (hygiene; it is GC'd with the closure
      // at run end regardless, and was never registered/persisted anywhere).
      delete runtime.bootstrapToken;
      if (!res.ok) {
        // Fail LOUD: the deployment is live + recorded, but the operator must see the activation failed
        // and why (status + body — e.g. 409 admin_exists, 404 disabled endpoint), never a quiet success.
        throw errValidation(`activation call ${act.method} ${url} failed — HTTP ${res.status}: ${res.bodyText.slice(0, 500)}`);
      }
      // Surface the result. The activate_url is a root-admin credential: it rides ONE line on the
      // EPHEMERAL stream — published to the live SSE watcher, never written to the append-only
      // events table — so it exists NOWHERE persisted: not the pointer, the inventory row, the
      // checkpoint, params, or the run log. Marked so the run screen can lift it into a copyable,
      // "shown once, not stored" callout; the persisted log keeps only the credential-free outcome.
      ctx.log("meta", `✓ activation succeeded (HTTP ${res.status})`);
      const activateUrl = extractActivateUrl(res.json);
      if (activateUrl) {
        ctx.log(EPHEMERAL_STREAM, `${ACTIVATION_RESULT_MARKER} ${activateUrl}`);
      }
      // Surface the OPTIONAL invite-mail outcome the endpoint may report alongside the
      // activate_url, so the operator sees whether the invite mail was actually delivered right next to
      // the link. Absent field ⇒ no line at all (fully backward-compatible with a response that carries
      // no mail object, or a consumer/older build that never sends one).
      const mail = extractMail(res.json);
      if (mail) ctx.log("meta", mailLine(mail));
    },
  };
}
