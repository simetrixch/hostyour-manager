import type { ReactNode } from "react";
import { Link } from "react-router";
import { STAGE, type Stage, type TenantStatus } from "../../../shared/enums.ts";
import { UNIT_SIZE_LETTER, type UnitSize } from "#unit/shared/unit-size.ts";
import { tenantRowOffer, type UnitEnvironments } from "../tenantRows.ts";

export interface EnvironmentRow {
  id: string;
  stage: Stage;
  status: TenantStatus;
  domain: string;
  /** The size word the row records; absent or null where none was. */
  size?: UnitSize | null | undefined;
}

/** DEV, TEST and PROD of ONE unit. With `onSelect` an environment is chosen in place; with `rowHref`
 *  each environment links to its own row's page; with neither it is named only. An absent environment
 *  is offered "+ add" where `addHref` names a way to add it. Each environment shows its size letter,
 *  or says that none is recorded. */
export function EnvironmentBar<T extends EnvironmentRow>({ group, selectedId, badge, onSelect, rowHref, addHref }: {
  group: UnitEnvironments<T>;
  selectedId: string;
  badge: (row: T) => ReactNode;
  onSelect?: ((row: T) => void) | undefined;
  rowHref?: ((row: T) => string) | undefined;
  addHref: (stage: Stage) => string | undefined;
}) {
  return (
    <div className="tabs" role="tablist" aria-label="Environments">
      {STAGE.map((stage) => {
        const row = group.byStage[stage];
        const name = stage.toUpperCase();
        if (!row) {
          const href = addHref(stage);
          return href ? (
            <Link key={stage} className="tab" to={href}>
              {name} + add
            </Link>
          ) : (
            <span key={stage} className="tab muted">{name} —</span>
          );
        }
        const selected = row.id === selectedId;
        const body = (
          <>
            {name} {badge(row)} <span className="mono">{row.domain}</span> {row.size ? <span>{UNIT_SIZE_LETTER[row.size]}</span> : <span className="muted">no size recorded</span>}
          </>
        );
        const className = selected ? "tab tab--active" : "tab";
        if (onSelect && !tenantRowOffer(row.status).settled) {
          return (
            <button key={stage} type="button" role="tab" aria-selected={selected} className={className} onClick={() => onSelect(row)}>
              {body}
            </button>
          );
        }
        return rowHref ? (
          <Link key={stage} className={className} to={rowHref(row)}>
            {body}
          </Link>
        ) : (
          <span key={stage} className={className}>{body}</span>
        );
      })}
    </div>
  );
}
