import type { ReactNode } from "react";
import { setTenantOwnDomain, type TenantDetailView } from "../api.ts";
import { setTenantDisplayName, setTenantSenderDomain } from "../api-tenant-mail.ts";
import { SetOwnDomainAction } from "./SetOwnDomainAction.tsx";
import { SetSenderDomainAction } from "./SetSenderDomainAction.tsx";
import { SetDisplayNameAction } from "./SetDisplayNameAction.tsx";

/** The tenant's domain actions, beside each other on its page: the domain it is SERVED at (its own
 *  domain, offered on a path-routed tenant), the domain its mail is SENT as, and the name it is shown
 *  under in that mail. Both only plan a run;
 *  `act` is the page's hand-off to the Run screen. */
export function TenantDomainActions(props: { t: TenantDetailView; busy: boolean; act: (fn: () => Promise<{ runId: string }>) => Promise<void> }): ReactNode {
  const { t, busy, act } = props;
  return (
    <>
      {t.routing === "path" && <SetOwnDomainAction subdomain={t.subdomain} ownDomain={t.ownDomain} ownDomainAliases={t.ownDomainAliases} busy={busy} onSet={(domain, nestsUnder, aliases) => void act(() => setTenantOwnDomain(t.id, domain, nestsUnder, aliases))} />}
      <SetSenderDomainAction subdomain={t.subdomain} senderDomain={t.senderDomain} busy={busy} onSet={(domain) => void act(() => setTenantSenderDomain(t.id, domain))} />
      <SetDisplayNameAction subdomain={t.subdomain} displayName={t.displayName} senderDomain={t.senderDomain} busy={busy} onSet={(name) => void act(() => setTenantDisplayName(t.id, name))} />
    </>
  );
}
