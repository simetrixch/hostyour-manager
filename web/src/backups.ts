// What the Restore dialog says about the generations of a unit's backup, as a pure module beside the
// dialog, because vitest runs with environment "node" and includes no .tsx.
import type { UnitBackupView } from "../../shared/api-types-backups.ts";

/** The generations a restore may read: written and verified, in the book's order (newest first). */
export function restorableGenerations(all: readonly UnitBackupView[]): UnitBackupView[] {
  return all.filter((b) => b.state === "ok");
}

/** How a generation reads in the picker: the UTC moment it names and what took it. */
export function generationLabel(b: UnitBackupView): string {
  const g = b.generation;
  return `${g.slice(0, 4)}-${g.slice(4, 6)}-${g.slice(6, 8)} ${g.slice(9, 11)}:${g.slice(11, 13)} UTC · ${b.trigger}`;
}

/** The generation a restore was confirmed with. The dialog confirms a restore only with one chosen,
 *  so none here is a defect of the page, said as one. */
export function chosenGeneration(generation: string | null): string {
  if (generation === null) throw new Error("the restore was confirmed without a backup generation");
  return generation;
}
