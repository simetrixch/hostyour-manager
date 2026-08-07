// The create-tenant `activate` step — the TENANT analogue of the consumer's onboard-activate.ts. Split
// out of create-tenant.run.ts (like onboard-activate.ts split out of onboard.run.ts) so that file stays
// under its line budget and this one concern is a single, testable unit.
//
// It runs LAST (after record-inventory): the whole fan-out is Synced/Healthy, smoke passed, and the
// tenant is recorded, so a failed invite never rolls back a live deployment. It calls the tenant's OWN
// example-auth first-admin bootstrap over the tenant's public ingress with the crypto-seeded bootstrap
// token — read straight from the k8s Secret on the target slave, never persisted — plus the operator's
// admin email, and surfaces the returned activate_url + optional invite-mail outcome exactly like the
// consumer step. adminEmail lives ONLY in the run params + this transient call: it is never written to
// the pointer, the inventory, or the checkpoint (PII hygiene).
import type { Step } from "../../executor/types.ts";
import type { TenantOnboardPorts, CreateTenantParams } from "./create-tenant.run.ts";
import { errValidation } from "../../kernel/errors.ts";
import { ACTIVATION_RESULT_MARKER } from "../../../shared/api-types.ts";
import { EPHEMERAL_STREAM } from "../../../shared/enums.ts";
import { extractActivateUrl, extractMail, mailLine } from "./activation-result.ts";
import { memberNamespace } from "./tenant-fanout.ts";
import { tenantMemberHost } from "./unit-dns.ts";
// The bootstrap-token Secret coordinates live in tenant-admin-invite.ts so this step and the
// operator-driven POST /api/tenants/:id/invite-admin route share ONE source (no drift).
import { TENANT_APP_SECRET, BOOTSTRAP_TOKEN_KEY } from "./tenant-admin-invite.ts";

/** Build the create-tenant `activate` step. Always appended (so the plan card + step list are stable),
 *  but the invite fires ONLY when the operator supplied an admin email — a tenant onboarded without one
 *  deploys exactly as before, the step just logs a skip and returns. */
export function tenantActivateStep(ports: TenantOnboardPorts, p: CreateTenantParams): Step {
  return {
    name: "activate",
    title: "Invite the first tenant admin",
    run: async (ctx) => {
      if (!p.adminEmail) {
        // No email ⇒ nothing to do. Kept an explicit, logged no-op (not a conditionally-absent step) so
        // the operator always sees WHY no invite happened, and the plan/step list never varies by input.
        ctx.log("meta", "no admin email supplied — skipping first-admin invite");
        return;
      }
      // A supplied email with no activator wired is a controller WIRING gap, never a silent skip
      // (the consumer onboard-activate precedent): fail loud so the missing port is fixed, not ignored.
      if (!ports.activator) {
        throw errValidation(`an admin email was supplied for ${p.guid} but no activator is wired on this controller — refusing to skip the first-admin invite silently`);
      }
      const ns = memberNamespace(p.guid, p.identityProvider);
      // The bootstrap token is a crypto secret the auth member's chart materializes via ESO into
      // hostyour-app-secrets in ITS OWN namespace <guid>-auth — the tenant's IdP is the member that
      // consumes it. Read it on the TARGET slave's own reader (the seam attest-target/smoke already use).
      // It MUST exist by now — smoke confirmed this namespace's ExternalSecrets are all Ready — so an
      // absent token is a real failure, not a race; fail loud rather than send an empty/wrong token.
      const { clusterReader } = await ports.resolver.resolve(p.clusterId);
      const token = await clusterReader.readSecretValue(ns, TENANT_APP_SECRET, BOOTSTRAP_TOKEN_KEY);
      if (!token) {
        throw errValidation(`the tenant bootstrap token (Secret ${TENANT_APP_SECRET} key ${BOOTSTRAP_TOKEN_KEY}) is absent in ${ns} — the tenant's crypto secret must exist after a green smoke; refusing to invite the first admin without it`);
      }
      // The tenant auth ingress: auth.<subdomain>.<unitApex> — the same three parts the auth member's
      // chart renders. The apex is read off the TARGET cluster's own values chain (the resolver
      // provision-dns already composes the tenant's wildcard `*.<subdomain>.<unitApex>` from), so the
      // host this posts to is one the wildcard covers and the ingress answers for.
      const authFqdn = tenantMemberHost(p.identityProvider, p.subdomain, await ports.resolveUnitApex(p.domain, p.stage));
      const url = `https://${authFqdn}/api/v1/bootstrap/invite-admin`;
      // The token rides ONLY the declared header — never the URL, the body, or a log line.
      ctx.log("meta", `inviting the first tenant admin: POST ${url} with header X-Bootstrap-Token (token withheld)`);
      const res = await ports.activator.invoke({ url, method: "POST", tokenHeader: "X-Bootstrap-Token", token, body: { email: p.adminEmail }, signal: ctx.signal });
      if (res.status === 409) {
        // 409 admin_exists — the bootstrap endpoint is SINGLE-SHOT: an admin already exists (a re-driven
        // onboard, or a prior invite). Tolerate it and SUCCEED so a resume/re-run stays green (idempotent),
        // UNLIKE the consumer's activate which fails loud on every non-2xx — here 409 is an expected re-run.
        ctx.log("meta", "a tenant admin already exists — invite skipped (single-shot)");
        return;
      }
      if (!res.ok) {
        // Any OTHER non-2xx (404 wrong/absent token, 5xx, …) fails LOUD with the status + body: the tenant
        // is live + recorded, but the operator must SEE the invite failed and why, never a quiet success.
        throw errValidation(`first-admin invite ${url} failed — HTTP ${res.status}: ${res.bodyText.slice(0, 500)}`);
      }
      // Surface the result exactly like onboard-activate.ts: the activate_url (a root-admin credential)
      // rides ONE marked line on the EPHEMERAL stream — published to the live SSE watcher, never written
      // to the append-only events table — so it is shown once and stored NOWHERE (not the pointer/
      // inventory/checkpoint/params/run log). The OPTIONAL invite-mail outcome lands right next to it.
      // Register NO cleanup: an invite is not reversible and the endpoint is single-shot.
      ctx.log("meta", `✓ first-admin invite succeeded (HTTP ${res.status})`);
      const activateUrl = extractActivateUrl(res.json);
      if (activateUrl) {
        ctx.log(EPHEMERAL_STREAM, `${ACTIVATION_RESULT_MARKER} ${activateUrl}`);
      }
      const mail = extractMail(res.json);
      if (mail) ctx.log("meta", mailLine(mail));
    },
  };
}
