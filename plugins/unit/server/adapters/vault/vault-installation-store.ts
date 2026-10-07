import { KV_MOUNT, VaultError } from "#core/server/adapters/vault/port.ts";
import type { InstallationStore } from "./installation-store-port.ts";
import { vaultRevokeSelf, vaultSelfLogin, type VaultSelfAuth } from "./vault-self-login.ts";

// The installation's store, read as the Manager itself: login, one KV-v2 read, revoke. A 403 is the
// installation's policy not granting the entry, named as such, never taken for "absent".
export class VaultInstallationStore implements InstallationStore {
  constructor(private readonly deps: { self?: VaultSelfAuth; stage: string }) {}

  get stage(): string {
    return this.deps.stage;
  }

  async readField(entry: string, field: string): Promise<string | null> {
    const path = `${this.deps.stage}/${entry}`;
    const { addr, token } = await vaultSelfLogin(this.deps.self);
    try {
      const res = await fetch(`${addr}/v1/${KV_MOUNT}/data/${path}`, { headers: { "x-vault-token": token } });
      if (res.status === 404) return null;
      if (res.status === 403) throw new VaultError(`the Manager may not read ${KV_MOUNT}/${path}: the installation's Vault policy "manager" grants it no read there`, 403);
      if (!res.ok) throw new VaultError(`vault read failed for ${KV_MOUNT}/${path} (${res.status})`, res.status);
      const value = ((await res.json()) as { data?: { data?: Record<string, unknown> } }).data?.data?.[field];
      return typeof value === "string" && value !== "" ? value : null;
    } finally {
      await vaultRevokeSelf(addr, token).catch(() => undefined);
    }
  }
}
