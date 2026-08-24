// Vault KV backend contract. The credential store keeps secret VALUES in
// Vault via this port; only server/adapters/vault speaks Vault HTTP. Values are opaque base64
// strings (the store base64s the plaintext before handing it over). Pure types — no fetch here.

export interface VaultKv {
  /** Create/overwrite the secret at <prefix>/<key>. */
  put(key: string, value: string): Promise<void>;
  /** Read the secret value, or undefined if absent. */
  get(key: string): Promise<string | undefined>;
  /** Hard-delete the secret (all versions). Idempotent (404 tolerated). */
  delete(key: string): Promise<void>;
}

/** The ONE KV-v2 mount, on every cluster and for every role. There is no per-cluster mount to
 *  resolve: the platform provisions `secret/` everywhere and tells the charts so once, in
 *  platform/values-common.yaml (global.vaultKvMount). What IS per-cluster is the kubernetes AUTH
 *  mount (kubernetes-<cluster>), which arrives as configuration. */
export const KV_MOUNT = "secret";

export interface VaultConfig {
  addr: string; // https://vault.<domain>:8200
  k8sRole: string; // Vault kubernetes-auth role bound to the manager SA
  kvPrefix: string; // path prefix under the mount, default "controller/cred"
  k8sAuthMount: string; // kubernetes auth mount, e.g. "kubernetes-m1"
  saTokenPath: string; // the projected ServiceAccount token
}

export class VaultError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "VaultError";
    this.status = status;
  }
}
