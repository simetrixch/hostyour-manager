import { readFileSync } from "node:fs";
import type { VaultKv, VaultConfig } from "./port.ts";
import { KV_MOUNT, VaultError } from "./port.ts";

// The only place Vault HTTP lives (dep-cruiser: adapters own IO). KV-v2 read/write/delete,
// authenticated with Vault kubernetes-auth: the pod's ServiceAccount JWT is exchanged for a
// short-lived client token, cached until ~30s before its lease expires, then re-fetched.

interface TokenState {
  token: string;
  expiresAt: number; // epoch ms
}

export class VaultKvClient implements VaultKv {
  private tokenState: TokenState | undefined;

  constructor(private readonly cfg: VaultConfig) {}

  private dataUrl(key: string): string {
    return `${this.cfg.addr}/v1/${KV_MOUNT}/data/${this.cfg.kvPrefix}/${encodeURIComponent(key)}`;
  }

  private metaUrl(key: string): string {
    return `${this.cfg.addr}/v1/${KV_MOUNT}/metadata/${this.cfg.kvPrefix}/${encodeURIComponent(key)}`;
  }

  private async token(): Promise<string> {
    const now = Date.now();
    if (this.tokenState && this.tokenState.expiresAt > now + 30_000) return this.tokenState.token;
    const jwt = readFileSync(this.cfg.saTokenPath, "utf8").trim();
    const res = await fetch(`${this.cfg.addr}/v1/auth/${this.cfg.k8sAuthMount}/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: this.cfg.k8sRole, jwt }),
    });
    if (!res.ok) throw new VaultError(`vault kubernetes login failed (${res.status})`, res.status);
    const body = (await res.json()) as { auth?: { client_token?: string; lease_duration?: number } };
    const token = body.auth?.client_token;
    if (!token) throw new VaultError("vault login returned no client_token");
    const lease = body.auth?.lease_duration ?? 3600;
    this.tokenState = { token, expiresAt: now + lease * 1000 };
    return token;
  }

  private async authed(url: string, method: string, jsonBody?: unknown): Promise<Response> {
    const token = await this.token();
    const headers: Record<string, string> = { "x-vault-token": token };
    if (jsonBody !== undefined) headers["content-type"] = "application/json";
    return fetch(url, { method, headers, ...(jsonBody !== undefined ? { body: JSON.stringify(jsonBody) } : {}) });
  }

  async put(key: string, value: string): Promise<void> {
    const res = await this.authed(this.dataUrl(key), "POST", { data: { value } });
    if (!res.ok) throw new VaultError(`vault put failed (${res.status})`, res.status);
  }

  async get(key: string): Promise<string | undefined> {
    const res = await this.authed(this.dataUrl(key), "GET");
    if (res.status === 404) return undefined;
    if (!res.ok) throw new VaultError(`vault get failed (${res.status})`, res.status);
    const body = (await res.json()) as { data?: { data?: { value?: string } } };
    return body.data?.data?.value;
  }

  async delete(key: string): Promise<void> {
    const res = await this.authed(this.metaUrl(key), "DELETE");
    if (!res.ok && res.status !== 404) throw new VaultError(`vault delete failed (${res.status})`, res.status);
  }
}
