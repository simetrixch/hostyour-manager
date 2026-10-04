import { Link } from "react-router";
import { STAGE } from "../../../shared/enums.ts";
import type { TenantView } from "../api.ts";
import { tenantRowOffer, type TenantEnvironments } from "../tenantRows.ts";
import { TenantStatusBadge } from "./TenantStatusBadge.tsx";

/** DEV, TEST and PROD of ONE tenant. On the Tenants page (`onSelect`) an environment is chosen in place;
 *  on the tenant page every environment is a link to its own row's page, so each action there keeps
 *  acting on exactly the row in the URL. An absent environment is offered "+ add", which opens the Add
 *  stage form on the page of a running environment. No size letter yet: the row records no size word. */
export function TenantEnvironmentBar({ group, selectedId, onSelect }: {
  group: TenantEnvironments<TenantView>;
  selectedId: string;
  onSelect?: ((row: TenantView) => void) | undefined;
}) {
  const rows = Object.values(group.byStage);
  const addFrom = [rows.find((r) => r.id === selectedId), ...rows].find((r) => r && (r.status === "active" || r.status === "suspended"));
  return (
    <div className="tabs" role="tablist" aria-label="Environments">
      {STAGE.map((stage) => {
        const row = group.byStage[stage];
        const name = stage.toUpperCase();
        if (!row) {
          return addFrom ? (
            <Link key={stage} className="tab" to={`/tenants/${addFrom.id}?addStage=${stage}`}>
              {name} + add
            </Link>
          ) : (
            <span key={stage} className="tab muted">{name} —</span>
          );
        }
        const selected = row.id === selectedId;
        const body = (
          <>
            {name} <TenantStatusBadge status={row.status} suspended={row.suspended} /> <span className="mono">{row.domain}</span>{" "}
            <span className="muted">no size recorded</span>
          </>
        );
        const className = selected ? "tab tab--active" : "tab";
        return onSelect && !tenantRowOffer(row.status).settled ? (
          <button key={stage} type="button" role="tab" aria-selected={selected} className={className} onClick={() => onSelect(row)}>
            {body}
          </button>
        ) : (
          <Link key={stage} className={className} to={`/tenants/${row.id}`}>
            {body}
          </Link>
        );
      })}
    </div>
  );
}
