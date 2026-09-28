// THE VALUES A DIALOG TOOK FOR A RUN IT PLANNED, on their way to that run's approve form. Held in this
// module's memory only, never in the URL, the history state or any storage: a reload loses them, and
// the approve form then asks for them again. The run page takes them and lets go of them when it
// closes or approves.
const held = new Map<string, Record<string, string>>();

/** Keep `values` (approve keys to values) for the run `runId` until its page takes them. */
export function holdSecrets(runId: string, values: Record<string, string>): void {
  if (Object.keys(values).length > 0) held.set(runId, values);
}

/** The values held for `runId`, or undefined. */
export function heldSecrets(runId: string): Record<string, string> | undefined {
  return held.get(runId);
}

/** Let go of the values held for `runId`. */
export function dropSecrets(runId: string): void {
  held.delete(runId);
}
