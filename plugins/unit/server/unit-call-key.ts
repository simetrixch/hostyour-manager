// The key one stage of a unit accepts from the Manager alone (a manifest's generate:"manager-key"):
// the Manager mints it into the unit's own Vault entry, which it may write and never read back, so it
// keeps the same value sealed here to call that stage. One row per stage (subject unit-stage, the
// stage's Application name), so TEST and PROD of a unit never share a key; a new mint rotates the row.
import type { Stage } from "#core/shared/enums.ts";
import { consumerArgoAppName } from "#core/shared/consumer.ts";
import type { CredentialRef, CredentialStore, CredentialSubject } from "#core/server/security/store.ts";
import { fingerprintSecret } from "#core/server/security/fingerprint.ts";

type KeyStore = Pick<CredentialStore, "seal" | "rotate" | "purge" | "list">;

export function unitCallKeySubject(unit: string, stage: Stage): CredentialSubject {
  return { kind: "unit-stage", id: consumerArgoAppName(unit, stage) };
}

/** The stage's kept key, or null where the Manager keeps none for it. */
export async function findUnitCallKey(store: Pick<CredentialStore, "list">, unit: string, stage: Stage): Promise<CredentialRef | null> {
  const rows = await store.list({ subject: unitCallKeySubject(unit, stage), purpose: "unit-call-key", excludeRotated: true });
  return rows.at(-1) ?? null;
}

/** Keeps `value`, the key just written into the stage's entry: a new row, or the standing one rotated. */
export async function keepUnitCallKey(store: KeyStore, input: { unit: string; stage: Stage; key: string; value: string }): Promise<CredentialRef> {
  const plaintext = Buffer.from(input.value, "utf8");
  const fingerprint = fingerprintSecret(plaintext);
  const standing = await findUnitCallKey(store, input.unit, input.stage);
  if (standing) return store.rotate(standing.id, { plaintext, fingerprint });
  return store.seal({
    kind: "other",
    label: `${input.key} of ${consumerArgoAppName(input.unit, input.stage)}`,
    plaintext,
    fingerprint,
    subject: unitCallKeySubject(input.unit, input.stage),
    purpose: "unit-call-key",
  });
}

/** Removes every row the stage's key has, the rotated ones too, as the unit's entry goes. */
export async function dropUnitCallKey(store: KeyStore, unit: string, stage: Stage): Promise<number> {
  const rows = await store.list({ subject: unitCallKeySubject(unit, stage), purpose: "unit-call-key" });
  for (const row of rows) await store.purge(row.id);
  return rows.length;
}
