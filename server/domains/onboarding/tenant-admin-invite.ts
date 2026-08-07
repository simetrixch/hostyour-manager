// Shared tenant first-admin invite/resend — used by BOTH the create-tenant `activate` step
// (create-tenant-activate.ts, invite-only + idempotent inside a Run) and the operator-driven
// Tenants-page action (POST /api/tenants/:id/invite-admin, which RESENDS when the admin was already
// invited but the mail failed). Keeping the secret constants + the invite-or-resend orchestration in
// ONE place so the two callers cannot drift. The host they call is NOT composed here: a tenant member's
// public address is `<member>.<subdomain>.<unitApex>` (unit-dns.ts tenantMemberHost), and the apex is a
// per-cluster fact both callers resolve before they call in.
//
// SECURITY: the bootstrap token rides ONLY the X-Bootstrap-Token header (never URL/body/log). On the
// success paths the response body carries the activate_url (a root-admin credential); it is returned
// ONLY via the typed result field — never logged, never folded into a thrown message. Only a genuine
// transport/HTTP failure throws, with the status + a bounded { error }-shape body (no credential).
import { z } from "zod";
import type { Activator } from "../../adapters/activation/port.ts";
import type { ConsumerActivationMail } from "../../../shared/consumer.ts";
import { errValidation } from "../../kernel/errors.ts";
import { extractActivateUrl, extractMail } from "./activation-result.ts";

/** The k8s Secret + key the tenant's auth member materializes the bootstrap token into (via ESO), in
 *  its own namespace <guid>-auth. example-auth accepts it as the one-shot `X-Bootstrap-Token`. */
export const TENANT_APP_SECRET = "hostyour-app-secrets";
export const BOOTSTRAP_TOKEN_KEY = "AUTH_BOOTSTRAP_TOKEN";
/** The header example-auth's bootstrap endpoints read the token under. */
const BOOTSTRAP_TOKEN_HEADER = "X-Bootstrap-Token";

/** The operator-driven invite action's request body (browser → controller). Email is PII, not a
 *  secret — it is used only for the transient invoke and never persisted. */
export const InviteAdminRequest = z.object({ email: z.string().trim().email() });

/** What the action resolved to: `invited` = a fresh first admin was created; `resent` = the
 *  already-pending admin's invite was re-issued; `already-activated` = the admin already has a
 *  credential, so there was nothing to (re)send. */
export type TenantAdminInviteOutcome = "invited" | "resent" | "already-activated";

export interface TenantAdminInviteResult {
  outcome: TenantAdminInviteOutcome;
  /** The one-time root-admin activation URL — present ONLY for invited|resent, null otherwise. A
   *  credential: surfaced once by the caller and persisted NOWHERE. */
  activateUrl: string | null;
  /** The optional invite-mail delivery outcome; null when the endpoint reported none / no send. */
  mail: ConsumerActivationMail | null;
  /** A short, email-free operator-facing sentence for this outcome. */
  message: string;
}

/** Read the machine `error` code off a example-auth { error } body (defensive; null on any other shape). */
function readError(json: unknown): string | null {
  if (json && typeof json === "object" && "error" in json) {
    const v = (json as { error?: unknown }).error;
    if (typeof v === "string") return v;
  }
  return null;
}

/**
 * Invite the tenant's first admin over its OWN example-auth (bootstrap-token gated); on 409 (the
 * bootstrap is single-shot, so an admin already exists) fall through to the BODY-LESS
 * resend-admin-invite, which re-issues the SINGLE pending admin's token+mail. The resend locates the
 * admin by role, so it can neither create a user nor redirect the invite to a different address —
 * the operator's typed email is used only for the fresh-invite attempt.
 */
export async function inviteOrResendTenantAdmin(input: {
  activator: Activator;
  token: string;
  authFqdn: string;
  email: string;
  signal?: AbortSignal;
}): Promise<TenantAdminInviteResult> {
  const { activator, token, authFqdn, email, signal } = input;
  const base = `https://${authFqdn}/api/v1/bootstrap`;
  // One shape for both bootstrap calls: token on the header only, signal spread conditionally
  // (exactOptionalPropertyTypes forbids passing signal: undefined explicitly).
  const call = (path: string, body: Record<string, string>) =>
    activator.invoke({ url: `${base}/${path}`, method: "POST", tokenHeader: BOOTSTRAP_TOKEN_HEADER, token, body, ...(signal ? { signal } : {}) });

  // 1) Invite the first admin. 201 = created; 409 admin_exists = one already exists → resend.
  const inv = await call("invite-admin", { email });
  if (inv.ok) {
    return {
      outcome: "invited",
      activateUrl: extractActivateUrl(inv.json) ?? null,
      mail: extractMail(inv.json) ?? null,
      message: "Invited the tenant's first admin.",
    };
  }
  if (inv.status !== 409) {
    // 404 (token drift / endpoint disabled) or 5xx — fail loud with the status + bounded body. A non-2xx
    // invite carries an { error } body, never an activate_url, so this leaks no credential.
    throw errValidation(`first-admin invite failed — HTTP ${inv.status}: ${inv.bodyText.slice(0, 500)}`);
  }

  // 2) An admin already exists → resend the single pending admin's invite (body-less).
  const re = await call("resend-admin-invite", {});
  if (re.ok) {
    return {
      outcome: "resent",
      activateUrl: extractActivateUrl(re.json) ?? null,
      mail: extractMail(re.json) ?? null,
      message: "An admin invite already existed — re-sent a fresh activation link.",
    };
  }
  if (re.status === 409) {
    // The resend distinguishes its dead-ends via { error }: admin_active = the admin already activated
    // (nothing to resend — an informational SUCCESS); no_admin = a race where the admin vanished between
    // the invite-409 and this call — an inconsistent state, so fail loud and let the operator retry.
    if (readError(re.json) === "admin_active") {
      return {
        outcome: "already-activated",
        activateUrl: null,
        mail: null,
        message: "The tenant admin has already activated their account — nothing to resend.",
      };
    }
    throw errValidation(
      "resend first-admin invite hit an inconsistent state (no pending admin, yet invite reported one exists) — please retry",
    );
  }
  // Any other non-2xx on resend (404 token drift, 5xx) — fail loud.
  throw errValidation(`resend first-admin invite failed — HTTP ${re.status}: ${re.bodyText.slice(0, 500)}`);
}
