// The Cloudflare DNS provider (fetch, no SDK — the github-webhook-http rationale: a trivial
// dependency surface). Modelled on hostyour-cloud tools/ops/mail-dns-publish.sh, which already manages the
// platform's mail records over the same API with the same credential shape:
//  - every response is judged by the body's `success` flag, NOT the HTTP status alone — Cloudflare
//    can answer HTTP 200 with {"success": false, "errors": [...]};
//  - a 429 is retried with a short bounded backoff (this client makes 2-4 calls per run step, far
//    below the API's rate limit, so a few retries always suffice);
//  - the zone is resolved by a label-walk: ask for the exact name as a zone, and strip the leftmost
//    label until one matches — `erp.simetrix.example.com` finds the `example.com` zone with no
//    hardcoding, whatever registrable domain the unit apex sits under.
// The token rides ONLY in the Authorization header and is never logged.
import type { DnsProvider, DnsRecordType } from "./port.ts";
import { DnsError } from "./port.ts";

type FetchLike = typeof fetch;

/** One DNS record as Cloudflare returns it — only the fields this adapter reads. */
interface CfRecord {
  id: string;
  content: string;
}

interface CfEnvelope<T> {
  success: boolean;
  errors?: { code?: number; message?: string }[];
  result?: T;
}

const MAX_RATE_LIMIT_RETRIES = 3;

export class CloudflareDns implements DnsProvider {
  private readonly apiBase: string;
  private readonly fetchImpl: FetchLike;
  /** Zone ids by the name they were resolved FOR — the label-walk is 1-2 extra calls, so one
   *  resolution per distinct name is kept for the lifetime of this instance (zones do not move). */
  private readonly zoneIds = new Map<string, string>();

  constructor(private readonly opts: { apiToken: string; apiBase?: string; fetchImpl?: FetchLike }) {
    this.apiBase = (opts.apiBase ?? "https://api.cloudflare.com/client/v4").replace(/\/$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async upsertRecord(input: { name: string; type: DnsRecordType; content: string; signal?: AbortSignal }): Promise<{ created: boolean }> {
    const zone = await this.zoneId(input.name, input.signal);
    const existing = await this.listRecords(zone, input.name, input.type, input.signal);
    if (existing.length === 0) {
      await this.send<CfRecord>(`/zones/${zone}/dns_records`, {
        method: "POST",
        body: { type: input.type, name: input.name, content: input.content, ttl: 1, proxied: false },
        ...(input.signal ? { signal: input.signal } : {}),
      });
      return { created: true };
    }
    // Overwrite the first match in place; a duplicate beyond it (hand-created) is deleted so the
    // one-record-per-unit form holds after every upsert, not only after a clean create.
    const [head, ...rest] = existing;
    await this.send<CfRecord>(`/zones/${zone}/dns_records/${head!.id}`, {
      method: "PUT",
      body: { type: input.type, name: input.name, content: input.content, ttl: 1, proxied: false },
      ...(input.signal ? { signal: input.signal } : {}),
    });
    for (const r of rest) {
      await this.send<unknown>(`/zones/${zone}/dns_records/${r.id}`, { method: "DELETE", ...(input.signal ? { signal: input.signal } : {}) });
    }
    return { created: false };
  }

  async deleteRecord(input: { name: string; type: DnsRecordType; signal?: AbortSignal }): Promise<{ deleted: number }> {
    const zone = await this.zoneId(input.name, input.signal);
    const existing = await this.listRecords(zone, input.name, input.type, input.signal);
    for (const r of existing) {
      await this.send<unknown>(`/zones/${zone}/dns_records/${r.id}`, { method: "DELETE", ...(input.signal ? { signal: input.signal } : {}) });
    }
    return { deleted: existing.length };
  }

  async readRecordContent(input: { name: string; type: DnsRecordType; signal?: AbortSignal }): Promise<string | null> {
    const zone = await this.zoneId(input.name, input.signal);
    const existing = await this.listRecords(zone, input.name, input.type, input.signal);
    return existing[0]?.content ?? null;
  }

  private async listRecords(zone: string, name: string, type: DnsRecordType, signal?: AbortSignal): Promise<CfRecord[]> {
    const q = `type=${encodeURIComponent(type)}&name=${encodeURIComponent(name)}&per_page=100`;
    const records = await this.send<CfRecord[]>(`/zones/${zone}/dns_records?${q}`, signal ? { signal } : {});
    return records ?? [];
  }

  /** Resolve the zone a name belongs to by the label-walk (publish-mail-dns.sh cf_zone_id): ask for
   *  the exact name as a zone; if none matches, strip the leftmost label and retry, down to the last
   *  dot. Throws when no suffix is a zone — the token is scoped wrong or the domain is not on
   *  Cloudflare, and either way no record can be managed. */
  private async zoneId(name: string, signal?: AbortSignal): Promise<string> {
    // A wildcard label is never part of a zone name — the zone is resolved for the covered domain.
    let candidate = name.replace(/^\*\./, "");
    const cached = this.zoneIds.get(candidate);
    if (cached) return cached;
    const asked = candidate;
    while (candidate.includes(".")) {
      const zones = await this.send<{ id: string }[]>(`/zones?name=${encodeURIComponent(candidate)}&per_page=1`, signal ? { signal } : {});
      const id = zones?.[0]?.id;
      if (id) {
        this.zoneIds.set(asked, id);
        return id;
      }
      candidate = candidate.slice(candidate.indexOf(".") + 1);
    }
    throw new DnsError(`no Cloudflare zone found for any suffix of "${asked}" — is the DNS token scoped to this zone, and is the domain on Cloudflare?`);
  }

  /** One API call: auth header, JSON body, the success-flag check, and the bounded 429 backoff.
   *  Returns the envelope's `result`. Every failure throws DnsError carrying Cloudflare's own error
   *  text — the caller's run step surfaces it and fails. */
  private async send<T>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal }): Promise<T | undefined> {
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.apiBase}${path}`, {
          method: init.method ?? "GET",
          headers: {
            authorization: `Bearer ${this.opts.apiToken}`,
            "content-type": "application/json",
          },
          ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
          ...(init.signal ? { signal: init.signal } : {}),
        });
      } catch (e) {
        throw new DnsError(`Cloudflare DNS request failed (${path}): ${e instanceof Error ? e.message : String(e)}`);
      }
      if (res.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
        await new Promise((r) => setTimeout(r, (attempt + 1) * 2000));
        continue;
      }
      const body = (await res.json().catch(() => null)) as CfEnvelope<T> | null;
      if (body === null) {
        throw new DnsError(`Cloudflare DNS answered HTTP ${res.status} with no JSON body (${path})`, res.status);
      }
      if (!body.success) {
        const why = (body.errors ?? []).map((e) => `[${e.code ?? "?"}] ${e.message ?? "unknown error"}`).join("; ") || `HTTP ${res.status}`;
        throw new DnsError(`Cloudflare DNS refused ${init.method ?? "GET"} ${path}: ${why}`, res.status);
      }
      return body.result;
    }
  }
}
