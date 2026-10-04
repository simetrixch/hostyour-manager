import type { TenantView } from "../api.ts";
import type { UnitEnvironments } from "../tenantRows.ts";
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
