import type { ReactNode } from "react";
import { setTenantOwnDomain, setTenantSenderDomain, type TenantDetailView } from "../api.ts";
import { SetOwnDomainAction } from "./SetOwnDomainAction.tsx";
import { SetSenderDomainAction } from "./SetSenderDomainAction.tsx";

/** The tenant's two domain actions, beside each other on its page: the domain it is SERVED at (its own
 *  domain, offered on a path-routed tenant) and the domain its mail is SENT as. Both only plan a run;
 *  `act` is the page's hand-off to the Run screen. */
export function TenantDomainActions(props: { t: TenantDetailView; busy: boolean; act: (fn: () => Promise<{ runId: string }>) => Promise<void> }): ReactNode {
  const { t, busy, act } = props;
  return (
    <>
      {t.routing === "path" && <SetOwnDomainAction subdomain={t.subdomain} ownDomain={t.ownDomain} busy={busy} onSet={(domain) => void act(() => setTenantOwnDomain(t.id, domain))} />}
      <SetSenderDomainAction subdomain={t.subdomain} senderDomain={t.senderDomain} busy={busy} onSet={(domain) => void act(() => setTenantSenderDomain(t.id, domain))} />
    </>
  );
}
