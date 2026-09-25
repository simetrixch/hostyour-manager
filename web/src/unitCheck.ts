import { checkAttention, type UnitCheck } from "../../shared/preflight.ts";

// What the scheduled check's findings LOOK LIKE on a unit's card (hostyour-manager#210) — kept out
// of the components the way tenantAdmin.ts is, and for the same reason: the Consumers and the
// Tenants pages both show it, so stating it once is what stops one calling a unit fine that the
// other calls drifted.
//
// The check itself is the check-units step of tenant-check (plugins/unit/server/check-units.ts),
// on the same six-hour schedule as the administrator check. It records every finding; this shows
// the ones worth a look — a failure of either severity, or a warning — and stays QUIET on a unit
// whose every probe passed, because a page where every row shouts is a page where the one row that
// matters does not stand out. A unit no check has reached shows nothing rather than "fine".

export interface CheckBadge {
  label: string;
  modifier: "chip--warn" | null;
  /** The full sentence for the chip's title: every finding worth a look, and when it was measured. */
  detail: string;
}

export function checkBadge(check: UnitCheck | null, now: number): CheckBadge | null {
  if (!check) return null;
  const attention = checkAttention(check);
  if (attention.length === 0) return null;
  const ago = Math.max(0, Math.round((now - check.checkedAt) / 60_000));
  const hard = attention.filter((c) => c.severity === "hard" && c.status === "fail");
  return {
    label: hard.length > 0 ? `${hard.length} probe(s) failed` : `${attention.length} probe(s) worth a look`,
    modifier: hard.length > 0 ? "chip--warn" : null,
    detail: `${attention.map((c) => `${c.title}: ${c.detail}${c.hint ? ` — ${c.hint}` : ""}`).join("; ")} (measured ${ago} min ago)`,
  };
}
