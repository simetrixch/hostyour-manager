import type { ReactNode } from "react";
import type { ConsumerView } from "../api.ts";
import { APP_SETTLED_STATUS, STAGE, type AppStatus, type Stage } from "../../../shared/enums.ts";
import { consumerNamespace } from "../../../shared/consumer.ts";
import { TypeToConfirm } from "./TypeToConfirm.tsx";

/** The unit's other stages, as its rows know them. A `provisioning` row is no promise that its
 *  registration was written (record-provisional comes before write-registration), so it is told apart
 *  from the stages that stand. */
export interface SiblingStages {
  standing: Stage[];
  provisioning: Stage[];
}

const settled = (status: AppStatus): boolean => (APP_SETTLED_STATUS as readonly AppStatus[]).includes(status);

export function siblingStages(rows: readonly ConsumerView[], target: ConsumerView): SiblingStages {
  const siblings = rows.filter((r) => r.name === target.name && r.stage !== target.stage && !settled(r.status));
  const at = (provisioning: boolean): Stage[] => STAGE.filter((s) => siblings.some((r) => r.stage === s && (r.status === "provisioning") === provisioning));
  return { standing: at(false), provisioning: at(true) };
}

const SHARED = "the build webhook, the release kit and the build namespace";
const named = (stages: readonly Stage[]): string => stages.map((s) => s.toUpperCase()).join(" and ");

/** What happens to the parts the unit's stages share, as far as the rows can say. */
function sharedFate({ standing, provisioning }: SiblingStages): string {
  if (standing.length > 0) return `The unit still stands at ${named(standing)}, so what its stages share stays: the repo PAT, ${SHARED}.`;
  if (provisioning.length > 0) {
    const [verb, registration] = provisioning.length > 1 ? ["are", "their registrations were"] : ["is", "its registration was"];
    return `${named(provisioning)} ${verb} still provisioning. What the stages share — the repo PAT, ${SHARED} — ` +
      `stays only if ${registration} written; if not, it goes with this stage, the repo PAT NOT recoverable.`;
  }
  return `This is the unit's last stage, so what its stages share goes too: the repo PAT (NOT recoverable), ${SHARED}.`;
}

/** Confirm the offboard of ONE stage of a consumer. The copy is held to the plan summary
 *  server/domains/units/offboard.run.ts renders on the approve screen; where the rows and the
 *  registrations disagree, the registrations decide, and the dialog says so. Confirming only PLANS the run. */
export function OffboardConsumerDialog({ target, siblings, onConfirm, onCancel }: {
  target: ConsumerView;
  siblings: SiblingStages;
  onConfirm: () => void;
  onCancel: () => void;
}): ReactNode {
  return (
    <TypeToConfirm
      title={`Offboard "${target.name}" · ${target.stage.toUpperCase()} on ${target.domain}?`}
      expected={target.name}
      confirmLabel="Offboard consumer"
      onCancel={onCancel}
      onConfirm={onConfirm}
    >
      <p>
        This removes the {target.stage.toUpperCase()} registration; ArgoCD prunes its workloads, and the run deletes the namespace{" "}
        <span className="mono">{consumerNamespace(target.name, target.stage)}</span> on <strong>{target.domain}</strong> and this
        stage&apos;s repository credential, mail-ops grant and DNS record. Then it{" "}
        <strong>permanently deletes this stage&apos;s Vault secrets</strong> — its ceremony and database secrets, every version,{" "}
        <strong>NOT recoverable</strong>.
      </p>
      <p>
        {sharedFate(siblings)} The run decides from the unit&apos;s registrations when it acts: what the stages share goes only with the
        last registered stage. Only the inventory row is kept, marked offboarded.
      </p>
    </TypeToConfirm>
  );
}
