import type { ReactNode } from "react";
import type { UnitCheck } from "../../../shared/preflight.ts";
import { checkBadge } from "../unitCheck.ts";

/** What the scheduled check last found worth a look on a unit (unitCheck.ts): quiet where every
 *  probe passed, nothing where no check has reached the unit. One chip for both unit pages. */
export function CheckChip(props: { check: UnitCheck | null }): ReactNode {
  const badge = checkBadge(props.check, Date.now());
  return badge === null ? null : (
    <span className={badge.modifier ? `chip ${badge.modifier}` : "chip"} title={badge.detail}>
      {badge.label}
    </span>
  );
}
