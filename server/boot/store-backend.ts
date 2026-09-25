import type { Config } from "../kernel/config.ts";
import type { VaultKv } from "../adapters/vault/port.ts";
import { VaultKvClient } from "../adapters/vault/vault-kv.ts";
import { loadOrCreateDataKey } from "../kernel/datakey.ts";

/** Which backend the credential store keeps its values in, decided from the configuration, in ONE
 *  place because both processes this repository runs decide it — the server (boot/wire.ts) and the
 *  registry reaper (jobs/registry-reaper.ts), which reads the same sealed credentials.
 *
 *  ONE OF THE TWO, NEVER NEITHER, and that is the property this function exists to make checkable
 *  rather than to leave spelled twice. `CredentialStore` records `keystore.mode` from what it is
 *  handed — `vault` with a Vault client, `keyfile` with a data key, `plaintext` with neither
 *  (security/store.ts) — and `plaintext` is what a store built by a TEST gets. Nothing this
 *  repository runs can produce it, so nothing may be written that reads `plaintext` as a state a
 *  machine can be in. */
export function storeBackend(config: Config): { vault: VaultKv } | { dataKey: Buffer } {
  return config.vault ? { vault: new VaultKvClient(config.vault) } : { dataKey: loadOrCreateDataKey(config.dataDir) };
}
