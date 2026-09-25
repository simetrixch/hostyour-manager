// How an app's SELECTIONS travel on a request and a registration apps[] entry. Two of them are
// fields of the entry, because the engine reads them there today and every registration written
// before the apps manifest existed carries them as fields; every other selection an app's manifest
// entry declares (shared/apps-manifest.ts) travels under `selections`, keyed by its name.
//
// Its own module, with no schema and no parser in it, because the wizard imports it at runtime:
// the web bundle takes these three and nothing else of the tenant contract.

/** The two selections that are FIELDS of the apps[] entry: TenantAppSchema.seedReference and
 *  .seedDemo (shared/tenant.ts). Refused as keys of `selections`, so one selection has one place. */
export const SEED_SELECTIONS = ["seedReference", "seedDemo"] as const;

/** The selections ONE request app CHOSE, by name: the two fields where true, and every key of
 *  `selections` — a key present with `false` still names a selection, and T4 holds every name
 *  against the app's manifest entry. A bare entry chose nothing. */
export function chosenSelections(app: { seedReference?: boolean; seedDemo?: boolean; selections?: Record<string, boolean> }): string[] {
  return [...SEED_SELECTIONS.filter((k) => app[k] === true), ...Object.keys(app.selections ?? {})];
}

/** The inverse, for the wizard: one app's checked selections, keyed by name, into the request's
 *  shape — the two known ones onto their fields, the rest under `selections`. */
export function appSelectionsToRequest(name: string, chosen: Record<string, boolean>): { name: string; seedReference: boolean; seedDemo: boolean; selections: Record<string, boolean> } {
  const selections = Object.fromEntries(Object.entries(chosen).filter(([k]) => !(SEED_SELECTIONS as readonly string[]).includes(k)));
  return { name, seedReference: chosen.seedReference === true, seedDemo: chosen.seedDemo === true, selections };
}
