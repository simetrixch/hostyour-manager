import type { ReactNode } from "react";
import type { ConsumerView } from "../api.ts";
import { addStageHref } from "../consumerAddStage.ts";
import { cardEnvironment, chooseEnvironment, type UnitEnvironments } from "../tenantRows.ts";
import { EnvironmentBar } from "./EnvironmentBar.tsx";

const StatusBadge = ({ row }: { row: ConsumerView }) => <span className={`badge badge--${row.status}`}>{row.status}</span>;

/** A consumer card's head: its name once, its environments, and the one the card acts on. "+ add"
 *  onboards the consumer at a stage it does not stand at, from what the shown stage states. */
export function ConsumerCardHead({ group, selected, onSelect }: {
  group: UnitEnvironments<ConsumerView>;
  selected: ConsumerView;
  onSelect: (row: ConsumerView) => void;
}) {
  return (
    <>
      <div className="card__head">
        <strong className="servercard__name">{selected.name}</strong>
      </div>
      <EnvironmentBar
        group={group}
        selectedId={selected.id}
        badge={(row) => <StatusBadge row={row} />}
        onSelect={onSelect}
        addHref={(stage) => (selected.repoUrl ? addStageHref(selected, stage) : undefined)}
      />
      {/* No recorded revision: the unit's pin lives on its delivery branch and is the release cycle's
          to write — the live Drift row below shows what actually runs. */}
      <div className="servercard__target">
        Actions for {selected.stage.toUpperCase()} · {selected.domain} · updated {new Date(selected.updatedAt).toLocaleString()} <StatusBadge row={selected} />
      </div>
    </>
  );
}

/** A consumer's card on the Consumers page: the stage the page URL names (cardEnvironment), handed to the
 *  card body with the head that switches it, which writes the choice back into the URL in place, as the
 *  Tenants page does. Kept in page state, the card snapped back to PROD whenever the page mounted again,
 *  so an operator coming back from a TEST run found PROD's actions. */
export function ChosenConsumerEnvironment({ group, search, setSearch, children }: {
  group: UnitEnvironments<ConsumerView>;
  search: URLSearchParams;
  setSearch: (next: URLSearchParams, options: { replace: true }) => void;
  children: (c: ConsumerView, head: ReactNode) => ReactNode;
}) {
  const c = cardEnvironment(group, search);
  if (!c) return null;
  return children(c, <ConsumerCardHead group={group} selected={c} onSelect={(row) => setSearch(chooseEnvironment(search, group.key, row.stage), { replace: true })} />);
}
