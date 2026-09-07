import { readFileSync } from "node:fs";
import type { VaultKv, VaultConfig } from "./port.ts";
import { KV_MOUNT, VaultError } from "./port.ts";

// The only place Vault HTTP lives (dep-cruiser: adapters own IO). KV-v2 read/write/delete,
// authenticated with Vault kubernetes-auth: the pod's ServiceAccount JWT is exchanged for a
// short-lived client token, cached until ~30s before its lease expires, then re-fetched.

/** What actually went wrong under a `fetch` that never reached the server.
 *
 *  Node rejects such a call with a bare `TypeError: fetch failed` and hangs the real failure off
 *  `cause` — the certificate this process would not verify, the refused connection, the name that
 *  did not resolve — one or two links down, and for a host with several addresses under an
 *  `AggregateError` whose own message is empty. A log line carrying only the message says "fetch
 *  failed" and nothing else, and the operator reading it cannot tell an untrusted authority from a
 *  Vault that is not up yet. Those two need opposite actions, so the chain is walked and every link
 *  named, with the system error code where one is there. */
function describeFetchFailure(err: unknown): string {
  const links: string[] = [];
  let cur: unknown = err;
  while (cur instanceof Error && links.length < 4) {
    const code = (cur as { code?: unknown }).code;
    if (cur.message) links.push(typeof code === "string" ? `${cur.message} (${code})` : cur.message);
    cur = cur.cause ?? (cur instanceof AggregateError ? cur.errors[0] : undefined);
  }
  return links.length > 0 ? links.join(": ") : String(err);
}

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

  /** EVERY Vault call goes out through here, so a transport failure is named ONCE and every caller
   *  of this port — the credential store's seal, rotate, open and purge, and whatever logs them —
   *  gets the reason rather than `fetch failed`. Measured: a Manager on an installation issuing
   *  from its own authority logged `fetch failed` on 64 consecutive seal attempts and the untrusted
   *  certificate was named nowhere. */
  private async send(url: string, init: RequestInit, what: string): Promise<Response> {
    try {
      return await fetch(url, init);
    } catch (err) {
      throw new VaultError(`vault ${what} could not reach ${this.cfg.addr}: ${describeFetchFailure(err)}`);
    }
  }

  private async token(): Promise<string> {
    const now = Date.now();
    if (this.tokenState && this.tokenState.expiresAt > now + 30_000) return this.tokenState.token;
    const jwt = readFileSync(this.cfg.saTokenPath, "utf8").trim();
    const res = await this.send(`${this.cfg.addr}/v1/auth/${this.cfg.k8sAuthMount}/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: this.cfg.k8sRole, jwt }),
    }, "kubernetes login");
    if (!res.ok) throw new VaultError(`vault kubernetes login failed (${res.status})`, res.status);
    const body = (await res.json()) as { auth?: { client_token?: string; lease_duration?: number } };
    const token = body.auth?.client_token;
    if (!token) throw new VaultError("vault login returned no client_token");
    const lease = body.auth?.lease_duration ?? 3600;
    this.tokenState = { token, expiresAt: now + lease * 1000 };
    return token;
  }

  private async authed(url: string, method: string, what: string, jsonBody?: unknown): Promise<Response> {
    const token = await this.token();
    const headers: Record<string, string> = { "x-vault-token": token };
    if (jsonBody !== undefined) headers["content-type"] = "application/json";
    return this.send(url, { method, headers, ...(jsonBody !== undefined ? { body: JSON.stringify(jsonBody) } : {}) }, what);
  }

  async put(key: string, value: string): Promise<void> {
    const res = await this.authed(this.dataUrl(key), "POST", "put", { data: { value } });
    if (!res.ok) throw new VaultError(`vault put failed (${res.status})`, res.status);
  }

  async get(key: string): Promise<string | undefined> {
    const res = await this.authed(this.dataUrl(key), "GET", "get");
    if (res.status === 404) return undefined;
    if (!res.ok) throw new VaultError(`vault get failed (${res.status})`, res.status);
    const body = (await res.json()) as { data?: { data?: { value?: string } } };
    return body.data?.data?.value;
  }

  async delete(key: string): Promise<void> {
    const res = await this.authed(this.metaUrl(key), "DELETE", "delete");
    if (!res.ok && res.status !== 404) throw new VaultError(`vault delete failed (${res.status})`, res.status);
  }
}
