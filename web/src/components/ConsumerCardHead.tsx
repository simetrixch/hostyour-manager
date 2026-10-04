import type { ConsumerView } from "../api.ts";
import { addStageHref } from "../consumerAddStage.ts";
import type { UnitEnvironments } from "../tenantRows.ts";
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
