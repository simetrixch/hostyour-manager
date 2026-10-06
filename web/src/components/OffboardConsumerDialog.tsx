import type { ReactNode } from "react";
import type { ConsumerView } from "../api.ts";
import { STAGE, type Stage } from "../../../shared/enums.ts";
import { consumerNamespace } from "../../../shared/consumer.ts";
import { TypeToConfirm } from "./TypeToConfirm.tsx";

/** The unit's stages, other than `target`'s, whose rows still stand: what keeps the parts the stages share. */
export function otherStandingStages(rows: readonly ConsumerView[], target: ConsumerView): Stage[] {
  return STAGE.filter((stage) => stage !== target.stage && rows.some((r) => r.name === target.name && r.stage === stage && r.status !== "offboarded"));
}

/** Confirm the offboard of ONE stage of a consumer. The copy is held to the plan summary
 *  server/domains/units/offboard.run.ts renders on the approve screen: the run removes what carries the
 *  stage, and what the unit's stages share (repo PAT, build webhook, release kit, build namespace) only
 *  with the unit's last stage. Confirming only PLANS the run. */
export function OffboardConsumerDialog({ target, otherStages, onConfirm, onCancel }: {
  target: ConsumerView;
  otherStages: readonly Stage[];
  onConfirm: () => void;
  onCancel: () => void;
}): ReactNode {
  const shared = "the build webhook, the release kit and the build namespace";
  return (
    <TypeToConfirm
      title={`Offboard "${target.name}" · ${target.stage.toUpperCase()} on ${target.domain}?`}
      expected={target.name}
      confirmLabel="Offboard consumer"
      onCancel={onCancel}
      onConfirm={onConfirm}
    >
      <p>
        This removes the {target.stage.toUpperCase()} registration, ArgoCD prunes the namespace{" "}
        <span className="mono">{consumerNamespace(target.name, target.stage)}</span> on <strong>{target.domain}</strong>, and the run
        deletes this stage&apos;s repository credential, mail-ops grant and DNS record. Then it{" "}
        <strong>permanently deletes this stage&apos;s Vault secrets</strong> — its ceremony and database secrets, every version,{" "}
        <strong>NOT recoverable</strong>.
      </p>
      <p>
        {otherStages.length > 0
          ? `The unit still stands at ${otherStages.map((s) => s.toUpperCase()).join(" and ")}, so what its stages share stays: the repo PAT, ${shared}.`
          : `This is the unit's last stage, so what its stages share goes too: the repo PAT (NOT recoverable), ${shared}.`}{" "}
        Only the inventory row is kept, marked offboarded.
      </p>
    </TypeToConfirm>
  );
}
