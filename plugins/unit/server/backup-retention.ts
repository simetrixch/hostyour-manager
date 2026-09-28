// What the nightly pass keeps of a unit's backup: the owner's "7 daily and 4 weekly"
// (hostyour-cloud#254). Pure, over generation ids (generationId), so the rule is testable alone.

/** The newest generations kept whatever their week. */
export const KEEP_NEWEST = 7;
/** The most recent weeks of which the newest generation is kept. */
export const KEEP_WEEKS = 4;

/** The UTC week a generation id falls in, as a number that grows by one from one Monday to the next. */
function weekOf(generation: string): number {
  const day = Date.UTC(Number(generation.slice(0, 4)), Number(generation.slice(4, 6)) - 1, Number(generation.slice(6, 8))) / 86_400_000;
  // 1970-01-01 was a Thursday; three days on, a week starts on a Monday.
  return Math.floor((day + 3) / 7);
}

/** The generations of one unit retention keeps, out of its verified ones: the newest KEEP_NEWEST, and
 *  the newest one of each of the KEEP_WEEKS most recent weeks that hold one. The two rules overlap,
 *  so a steady nightly series keeps about three weeks beyond the newest seven days. */
export function generationsToKeep(verified: readonly string[]): Set<string> {
  const newestFirst = [...verified].sort().reverse();
  const keep = new Set(newestFirst.slice(0, KEEP_NEWEST));
  const newestOfWeek = new Map<number, string>();
  for (const g of newestFirst) if (!newestOfWeek.has(weekOf(g))) newestOfWeek.set(weekOf(g), g);
  for (const g of [...newestOfWeek.values()].slice(0, KEEP_WEEKS)) keep.add(g);
  return keep;
}
