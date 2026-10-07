// A consumer's key the installation's own store holds (manifest `store`): checked when the onboarding
// plans, copied into the consumer's own entry when it seeds. Its value goes nowhere else: no log, no
// plan, no frozen parameter.
import type { ConsumerSecretSpec } from "#core/shared/consumer.ts";
import { errValidation } from "#core/server/kernel/errors.ts";
import type { InstallationStore } from "./adapters/vault/installation-store-port.ts";

type StoreSpec = ConsumerSecretSpec & { store: NonNullable<ConsumerSecretSpec["store"]> };

const storeSpecs = (specs: readonly ConsumerSecretSpec[]): StoreSpec[] => specs.filter((s): s is StoreSpec => s.store !== undefined);

/** Where the store holds the key, as a person looks it up. */
export function storeLocation(stage: string, spec: StoreSpec): string {
  return `secret/${stage}/${spec.store.entry} (field ${spec.store.field})`;
}

async function readOne(store: InstallationStore, spec: StoreSpec): Promise<string> {
  const value = await store.readField(spec.store.entry, spec.store.field);
  if (value === null) {
    throw errValidation(`${spec.key} comes from ${storeLocation(store.stage, spec)}, which holds no such value — the installer writes it there; run it on the master first`);
  }
  return value;
}

function requireStore(store: InstallationStore | undefined, specs: StoreSpec[]): InstallationStore {
  if (!store) {
    throw errValidation(`${specs.map((s) => s.key).join(", ")} come from the installation's store, and this Manager reads none (it has no Vault login or no MASTER_STAGE)`);
  }
  return store;
}

/** Why the plan cannot take the store keys `specs` declare, or null where every one stands. */
export async function refuseMissingStoreSecrets(store: InstallationStore | undefined, specs: readonly ConsumerSecretSpec[]): Promise<string | null> {
  const wanted = storeSpecs(specs);
  if (wanted.length === 0) return null;
  try {
    const reader = requireStore(store, wanted);
    for (const spec of wanted) await readOne(reader, spec);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/** The values of the store keys `specs` declare, by key, read for the seed; throws, naming the
 *  location, where one has gone missing since the plan. */
export async function readStoreSecrets(store: InstallationStore | undefined, specs: readonly ConsumerSecretSpec[]): Promise<{ values: Record<string, string>; read: string[] }> {
  const wanted = storeSpecs(specs);
  if (wanted.length === 0) return { values: {}, read: [] };
  const reader = requireStore(store, wanted);
  const values: Record<string, string> = {};
  for (const spec of wanted) values[spec.key] = await readOne(reader, spec);
  return { values, read: wanted.map((s) => `${s.key} from ${storeLocation(reader.stage, s)}`) };
}
