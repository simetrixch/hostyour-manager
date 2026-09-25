import type { Hono } from "hono";
import type { AppEnv } from "../../http/app-env.ts";
import type { MailDnsView } from "../../../shared/mail.ts";
import { readMailDns, type MailDnsDeps } from "./mail-dns.ts";

/** GET /api/mail/dns — the installation's mail DNS as receivers see it, measured now (mail-dns.ts).
 *  Publishing is a run (`mail-dns-publish`, POST /api/runs), never a route of its own. */
export function registerMailRoutes(app: Hono<AppEnv>, deps: MailDnsDeps): void {
  app.get("/api/mail/dns", async (c) => c.json((await readMailDns(deps)) satisfies MailDnsView));
}
