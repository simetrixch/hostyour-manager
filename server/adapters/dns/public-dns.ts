// What RECEIVERS of the installation's mail look up: the public DNS, read through public resolvers
// rather than the machine's own — a record the master resolves through its cluster DNS and nobody
// else can is exactly the case the Mail page exists to show. Read-only; the writer of these records
// is the catalogue's publish-mail-dns program (mail-dns-publish), never this manager.
//
// Over HTTPS, never UDP 53: the apps machines let no UDP 53 out towards public resolvers (measured
// on apps3, hostyour-manager#150), a hardened environment blocks arbitrary outbound DNS as a matter
// of course, and outbound 443 is what this manager needs for the Cloudflare API anyway.

/** The three lookups the mail DNS check is made of. Every answer is a list; an absent name and a
 *  name without records of the type both answer the empty list, because to a receiver the two are
 *  the same thing. Anything else — no service that can be reached, a refused query — throws. */
export interface PublicDns {
  /** The TXT records at a name, each record's chunks joined into one string. */
  txt(name: string): Promise<string[]>;
  /** The IPv4 addresses a name resolves to. */
  a(name: string): Promise<string[]>;
  /** The names an address reverses to (its PTR records). */
  ptr(address: string): Promise<string[]>;
}

export interface DohResolver {
  name: string;
  /** The endpoint of the JSON DNS API (`?name=&type=`, `accept: application/dns-json`). */
  url: string;
}

/** The two public services the check asks, in this order — independent operators of the same JSON
 *  DNS API, so one outage does not paint every record red. */
export const DOH_RESOLVERS: readonly DohResolver[] = [
  { name: "cloudflare", url: "https://cloudflare-dns.com/dns-query" },
  { name: "google", url: "https://dns.google/resolve" },
];

type FetchLike = typeof fetch;

/** The record types asked, numbered as the wire (RFC 1035) and the JSON API number them. */
const RR_A = 1;
const RR_PTR = 12;
const RR_TXT = 16;

/** The response codes that mean "nothing of this type stands here" to a receiver — NOERROR with an
 *  empty answer, NXDOMAIN, and SERVFAIL, which the node:dns Resolver this replaces also read as
 *  nothing (ESERVFAIL). */
const RCODE_NOERROR = 0;
const RCODE_SERVFAIL = 2;
const RCODE_NXDOMAIN = 3;

interface DohAnswer { name: string; type: number; data: string }
interface DohEnvelope { Status: number; Answer?: DohAnswer[] }

/** TXT data as the JSON API presents it — `"chunk" "chunk"` with backslash escapes, or one bare
 *  string where a service leaves a single chunk unquoted — joined into the one string the record
 *  carries, as a receiver reads it. */
export function txtData(data: string): string {
  if (!data.startsWith('"')) return data;
  const chunks: string[] = [];
  const quoted = /"((?:[^"\\]|\\.)*)"/g;
  let m: RegExpExecArray | null;
  while ((m = quoted.exec(data)) !== null) chunks.push(m[1]!.replace(/\\(.)/g, "$1"));
  return chunks.join("");
}

/** 203.0.113.7 → 7.113.0.203.in-addr.arpa, the name a PTR stands under. */
export const reverseName = (address: string): string => `${address.split(".").reverse().join(".")}.in-addr.arpa`;

export class DohPublicDns implements PublicDns {
  private readonly resolvers: readonly DohResolver[];
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(opts: { resolvers?: readonly DohResolver[]; fetchImpl?: FetchLike; timeoutMs?: number } = {}) {
    this.resolvers = opts.resolvers ?? DOH_RESOLVERS;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 5000;
  }

  async txt(name: string): Promise<string[]> {
    return (await this.query(name, RR_TXT)).map(txtData);
  }

  async a(name: string): Promise<string[]> {
    return this.query(name, RR_A);
  }

  async ptr(address: string): Promise<string[]> {
    return (await this.query(reverseName(address), RR_PTR)).map((n) => n.replace(/\.$/, ""));
  }

  /** The data of every answer OF THE ASKED TYPE at the name — the CNAMEs a chain passes through are
   *  answers too, and not records of the name. The services are asked one after the other: one that
   *  cannot be reached or does not answer HTTP 200 says nothing about the record, so the next is
   *  asked; the first that answers decides. */
  private async query(name: string, type: number): Promise<string[]> {
    const failures: string[] = [];
    for (const r of this.resolvers) {
      let res: Response;
      try {
        res = await this.fetchImpl(`${r.url}?name=${encodeURIComponent(name)}&type=${type}`, {
          headers: { accept: "application/dns-json" },
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        failures.push(`${r.name}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      if (!res.ok) {
        failures.push(`${r.name}: HTTP ${res.status}`);
        continue;
      }
      const body = (await res.json()) as DohEnvelope;
      if (body.Status === RCODE_NXDOMAIN || body.Status === RCODE_SERVFAIL) return [];
      if (body.Status !== RCODE_NOERROR) throw new Error(`${r.name} refused the query for ${name} (rcode ${body.Status})`);
      return (body.Answer ?? []).filter((a) => a.type === type).map((a) => a.data);
    }
    throw new Error(`no public resolver could be reached for ${name}: ${failures.join("; ")}`);
  }
}
