// WHAT THE SECRETS DIALOG OF A CONSUMER SAYS AND DECIDES, as a pure module beside approveFields.ts,
// because vitest runs with environment "node" and includes no .tsx.
import type { ConsumerSecretKeyView } from "../../shared/api-types-onboard.ts";
import { CONSUMER_SECRET_PREFIX } from "./approveFields.ts";
import { setConsumerSecrets } from "./api.ts";
import { holdSecrets } from "./heldSecrets.ts";

/** What the dialog says about a key's value: written by this Manager on a date, never written since the
 *  onboarding, or unknown for a consumer onboarded before the Manager kept its book of secret writes. */
export function secretStateLabel(k: ConsumerSecretKeyView): string {
  if (k.state === "set" && k.writtenAt !== undefined) return `set ${new Date(k.writtenAt).toISOString().slice(0, 10)}`;
  if (k.state === "never") return "never set";
  return "unknown";
}

/** The keys to mint after `key` is ticked on or off: the two halves of a keypair move together. */
export function toggleMint(keys: readonly ConsumerSecretKeyView[], mint: readonly string[], key: string, on: boolean): string[] {
  const partner = keys.find((k) => k.key === key)?.pairWith;
  const both = partner ? [key, partner] : [key];
  return on ? [...new Set([...mint, ...both])] : mint.filter((m) => !both.includes(m));
}

/** The values typed in the dialog, under the keys the approve form of consumer-set-secrets asks them
 *  by. An empty box is no answer: it keeps the stored value, so it is left out. */
export function approveSecrets(values: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(values).filter(([, v]) => v !== "").map(([k, v]) => [`${CONSUMER_SECRET_PREFIX}${k}`, v]));
}

/** Whether the dialog asks for a change at all: a value typed, or a key ticked to mint. */
export function changesSecrets(values: Readonly<Record<string, string>>, mint: readonly string[]): boolean {
  return mint.length > 0 || Object.values(values).some((v) => v !== "");
}

/** Plan the change the dialog asks for, and hold its typed values for that run's approve form. */
export async function planSecretsChange(appId: string, mint: string[], values: Readonly<Record<string, string>>): Promise<{ runId: string }> {
  const planned = await setConsumerSecrets(appId, mint);
  holdSecrets(planned.runId, approveSecrets(values));
  return planned;
}
