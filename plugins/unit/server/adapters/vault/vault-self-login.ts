import { readFileSync } from "node:fs";
import { VaultError } from "#core/server/adapters/vault/port.ts";

// The Manager's own kubernetes-auth login against its Vault, and the revoke of the token it got: the
// one identity both Vault adapters of the unit plugin act as, the write-only seeder and the reader of
// the installation's store, so the two can never log in differently.

/** The Manager's own Vault login facts (kubernetes-auth) — config.vault, the same surface the
 *  credential store's VaultKvClient authenticates with. Optional rather than required because a
 *  Manager without Vault is a real state (a dev process, the checks); absent ⇒ every write fails
 *  closed with a clear error instead of inventing an identity. */
export interface VaultSelfAuth {
  addr: string;
  k8sAuthMount: string;
  k8sRole: string;
  saTokenPath: string;
}

/** Logs in as the Manager itself. Fail-closed when the Manager carries no Vault login. */
export async function vaultSelfLogin(self: VaultSelfAuth | undefined): Promise<{ addr: string; token: string }> {
  if (!self) {
    throw new VaultError(
      "no Vault identity for this call: the Manager has no own Vault login (VAULT_ADDR unset) — refusing to continue",
    );
  }
  let jwt: string;
  try {
    jwt = readFileSync(self.saTokenPath, "utf8").trim();
  } catch (err) {
    throw new VaultError(`manager ServiceAccount token not readable at ${self.saTokenPath}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const res = await fetch(`${self.addr}/v1/auth/${self.k8sAuthMount}/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ role: self.k8sRole, jwt }),
  });
  if (!res.ok) throw new VaultError(`vault kubernetes login failed (${res.status})`, res.status);
  const body = (await res.json()) as { auth?: { client_token?: string } };
  const token = body.auth?.client_token;
  if (!token) throw new VaultError("vault kubernetes login returned no client_token");
  return { addr: self.addr, token };
}

export async function vaultRevokeSelf(addr: string, token: string): Promise<void> {
  const res = await fetch(`${addr}/v1/auth/token/revoke-self`, { method: "POST", headers: { "x-vault-token": token } });
  if (!res.ok) throw new VaultError(`vault token revoke-self failed (${res.status})`, res.status);
}
