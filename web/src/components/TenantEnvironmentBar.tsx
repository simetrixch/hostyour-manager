import type { ReactNode } from "react";
import type { TenantView } from "../api.ts";
import { cardEnvironment, type UnitEnvironments } from "../tenantRows.ts";
import { EnvironmentBar } from "./EnvironmentBar.tsx";
import { TenantStatusBadge } from "./TenantStatusBadge.tsx";

/** A tenant's environments. On the Tenants page (`onSelect`) one is chosen in place; on the tenant page
 *  every environment links to its own row's page, so each action there keeps acting on exactly the row
 *  in the URL. "+ add" opens the Add stage form on the page of a running environment. */
export function TenantEnvironmentBar({ group, selectedId, onSelect }: {
  group: UnitEnvironments<TenantView>;
  selectedId: string;
  onSelect?: ((row: TenantView) => void) | undefined;
}) {
  const rows = Object.values(group.byStage);
  const addFrom = [rows.find((r) => r.id === selectedId), ...rows].find((r) => r && (r.status === "active" || r.status === "suspended"));
  return (
    <EnvironmentBar
      group={group}
      selectedId={selectedId}
      onSelect={onSelect}
      badge={(row) => <TenantStatusBadge status={row.status} suspended={row.suspended} />}
      rowHref={(row) => `/tenants/${row.id}`}
      addHref={(stage) => (addFrom ? `/tenants/${addFrom.id}?addStage=${stage}` : undefined)}
    />
  );
}

/** A tenant's card on the Tenants page: the environment the page URL names (cardEnvironment), handed to
 *  the card body with the bar that switches it. Everything the card opens and acts on is that row. */
export function ChosenTenantEnvironment({ group, search, onChoose, children }: {
  group: UnitEnvironments<TenantView>;
  search: URLSearchParams;
  onChoose: (row: TenantView) => void;
  children: (t: TenantView, bar: ReactNode) => ReactNode;
}) {
  const t = cardEnvironment(group, search);
  if (!t) return null;
  return children(t, <TenantEnvironmentBar group={group} selectedId={t.id} onSelect={onChoose} />);
}
