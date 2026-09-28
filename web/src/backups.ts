// What the Restore dialog says about the generations of a unit's backup, as a pure module beside the
// dialog, because vitest runs with environment "node" and includes no .tsx.
import type { LatestBackupsView, UnitBackupView } from "../../shared/api-types-backups.ts";

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

/** The latest backups as a page holds them: not read yet, read, or refused with the reason. */
export type LatestBackupsRead = LatestBackupsView | { error: string } | null;

/** What a unit's row says about its backup: the day of the last good one, a failed or running one,
 *  none yet, that this manager takes none because no Storage Box is wired, or that the book could not
 *  be read. Null until it is read. */
export function backupChip(latest: LatestBackupsRead, unit: { kind: "tenant" | "consumer"; unit: string; stage: string }): { label: string; modifier: string | null; detail: string } | null {
  if (latest === null) return null;
  if ("error" in latest) return { label: "backup unknown", modifier: "chip--warn", detail: `The latest backups could not be read: ${latest.error}` };
  if (!latest.wired) return { label: "backups off", modifier: "chip--warn", detail: "No Storage Box is wired on this manager, so no backup is taken." };
  const b = latest.latest.find((l) => l.kind === unit.kind && l.unit === unit.unit && l.stage === unit.stage);
  if (!b) return { label: "no backup yet", modifier: null, detail: "No generation of this unit's backup stands in the book." };
  const when = generationLabel(b);
  if (b.state === "failed") return { label: "backup failed", modifier: "chip--warn", detail: `${when}: ${b.detail ?? "failed"}` };
  if (b.state === "taking") return { label: "backup running", modifier: null, detail: when };
  return { label: `backup ${when.slice(0, 10)}`, modifier: "chip--ok", detail: when };
}
