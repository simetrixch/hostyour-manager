// The activation-response readers shared by BOTH post-onboard invite steps: the consumer's
// onboard-activate.ts and the tenant's create-tenant-activate.ts. Both call a example-auth
// `bootstrap/invite-admin` endpoint and must surface the SAME two things the SAME way — the returned
// `activate_url` (a root-admin credential shown once, stored nowhere) and the OPTIONAL invite-mail
// outcome — so the parsing + the operator-facing mail line live here ONCE rather than being
// duplicated (and drifting) across the two steps. Pure: no IO, only shape-reads of an already-parsed
// response body (the Activator port did the fetch + JSON.parse).
import { ConsumerActivationMailSchema, type ConsumerActivationMail } from "../../../shared/consumer.ts";

/** Render the optional invite-mail outcome as one plain, operator-facing run-log line — in the
 *  same English + `✓`/plain style as the invite steps' other lines. Never carries a credential (the mail
 *  detail is a short reason, never the activate_url or the token). */
export function mailLine(mail: ConsumerActivationMail): string {
  switch (mail.status) {
    case "sent":
      return `Invite mail: sent via ${mail.transport}`;
    case "failed":
      return `Invite mail: FAILED — ${mail.detail ?? "no detail reported"}`;
    case "skipped":
      return `Invite mail: not sent (no mail transport configured)`;
  }
}

/** Pull `activate_url` out of the (already-parsed) activation response body, if the endpoint returned
 *  one (example-auth does). Defensive: any non-object / non-string shape yields undefined. */
export function extractActivateUrl(json: unknown): string | undefined {
  if (json && typeof json === "object" && "activate_url" in json) {
    const v = (json as { activate_url?: unknown }).activate_url;
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

/** Pull the OPTIONAL `mail` object out of the (already-parsed) activation response body. Defensive
 *  like extractActivateUrl: a missing field OR any shape that does not match ConsumerActivationMailSchema
 *  (unknown status, non-string transport, …) yields undefined, so a response WITHOUT a valid mail object
 *  surfaces no mail line and behaves exactly as before. */
export function extractMail(json: unknown): ConsumerActivationMail | undefined {
  if (json && typeof json === "object" && "mail" in json) {
    const parsed = ConsumerActivationMailSchema.safeParse((json as { mail?: unknown }).mail);
    if (parsed.success) return parsed.data;
  }
  return undefined;
}
