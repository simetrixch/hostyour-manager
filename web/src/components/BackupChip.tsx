import { useEffect, useState, type ReactNode } from "react";
import { getLatestBackups } from "../api.ts";
import { backupChip, type LatestBackupsRead } from "../backups.ts";

/** Each unit's most recent backup, read once per page; a refused read is kept with its reason. */
export function useLatestBackups(): LatestBackupsRead {
  const [latest, setLatest] = useState<LatestBackupsRead>(null);
  useEffect(() => {
    let alive = true;
    getLatestBackups()
      .then((l) => { if (alive) setLatest(l); })
      .catch((e: unknown) => { if (alive) setLatest({ error: e instanceof Error ? e.message : String(e) }); });
    return () => { alive = false; };
  }, []);
  return latest;
}

/** When the unit was last backed up (backups.ts). One chip for both unit pages, beside CheckChip. */
export function BackupChip(props: { latest: LatestBackupsRead; kind: "tenant" | "consumer"; unit: string; stage: string }): ReactNode {
  const chip = backupChip(props.latest, props);
  return chip === null ? null : (
    <span className={chip.modifier ? `chip ${chip.modifier}` : "chip"} title={chip.detail}>
      {chip.label}
    </span>
  );
}
