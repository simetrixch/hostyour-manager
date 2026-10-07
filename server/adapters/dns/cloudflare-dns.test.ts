import { describe, expect, it } from "vitest";
import { CloudflareDns, txtText } from "./cloudflare-dns.ts";

// The Cloudflare adapter over a scripted fetch. What is held: a TXT content is answered as the one
// text the record is, however the zone stored it (quoted 255-character chunks), and a deletion
// narrowed to a content sends DELETE for exactly the records carrying it — a deletion without one
// still takes every record of the name and type, which is what a unit's A record needs.

const ZONE = "z1";
const API = "https://api.invalid/client/v4";

/** A fetch scripted by method and path. Every call is recorded, so a test reads what was sent. */
function scripted(records: { id: string; content: string; proxied?: boolean; ttl?: number }[]) {
  const calls: string[] = [];
  /** The body of every POST, as sent. */
  const posted: unknown[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const call = `${init?.method ?? "GET"} ${url.pathname}${url.search}`;
    calls.push(call);
    if (init?.method === "POST") posted.push(JSON.parse(String(init.body)));
    const ok = (result: unknown): Response => new Response(JSON.stringify({ success: true, result }), { status: 200 });
    if (url.pathname === "/client/v4/zones") return ok([{ id: ZONE }]);
    if (url.pathname === `/client/v4/zones/${ZONE}/dns_records`) return ok(records);
    if ((init?.method ?? "GET") === "DELETE") return ok({ id: url.pathname.split("/").at(-1) });
    return new Response(JSON.stringify({ success: false, errors: [{ message: `unscripted ${call}` }] }), { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls, posted };
}

const deletes = (calls: string[]): string[] => calls.filter((c) => c.startsWith("DELETE")).map((c) => c.split("/").at(-1)!);

describe("txtText — a TXT value as the one text it is", () => {
  it("drops the outer quotes and joins the chunks, and leaves a bare value as it is", () => {
    expect(txtText('"v=DKIM1; k=rsa; " "p=MIIB"')).toBe("v=DKIM1; k=rsa; p=MIIB");
    expect(txtText('"v=spf1 ip4:203.0.113.7 -all"')).toBe("v=spf1 ip4:203.0.113.7 -all");
    expect(txtText("v=spf1 ip4:203.0.113.7 -all")).toBe("v=spf1 ip4:203.0.113.7 -all");
    expect(txtText("203.0.113.7")).toBe("203.0.113.7");
  });
});

describe("CloudflareDns", () => {
  const apex = [
    { id: "r-ms", content: '"MS=ms12345678"' },
    { id: "r-spf", content: '"v=spf1 " "ip4:203.0.113.7 -all"' },
  ];

  it("lists every TXT of a name as its one text, and reads the first as the content", async () => {
    const { fetchImpl, calls } = scripted(apex);
    const dns = new CloudflareDns({ apiToken: "t", apiBase: API, fetchImpl });
    expect(await dns.listRecordContents({ name: "example.com", type: "TXT" })).toEqual(["MS=ms12345678", "v=spf1 ip4:203.0.113.7 -all"]);
    expect(await dns.readRecordContent({ name: "example.com", type: "TXT" })).toBe("MS=ms12345678");
    expect(calls[0]).toBe("GET /client/v4/zones?name=example.com&per_page=1");
    expect(calls[1]).toBe("GET /client/v4/zones/z1/dns_records?type=TXT&name=example.com&per_page=100");
  });

  it("deletes by content: only the record carrying it goes, compared as the same one text", async () => {
    const { fetchImpl, calls } = scripted(apex);
    const dns = new CloudflareDns({ apiToken: "t", apiBase: API, fetchImpl });
    expect(await dns.deleteRecord({ name: "example.com", type: "TXT", content: "v=spf1 ip4:203.0.113.7 -all" })).toEqual({ deleted: 1 });
    expect(deletes(calls)).toEqual(["r-spf"]);
  });

  it("a content nothing carries deletes nothing — never the neighbour", async () => {
    const { fetchImpl, calls } = scripted(apex);
    const dns = new CloudflareDns({ apiToken: "t", apiBase: API, fetchImpl });
    expect(await dns.deleteRecord({ name: "example.com", type: "TXT", content: "v=spf1 ip4:198.51.100.4 -all" })).toEqual({ deleted: 0 });
    expect(deletes(calls)).toEqual([]);
  });

  it("without a content, every record of the name and type goes — a unit's A record, duplicates included", async () => {
    const { fetchImpl, calls } = scripted([{ id: "a-1", content: "203.0.113.7" }, { id: "a-2", content: "203.0.113.8" }]);
    const dns = new CloudflareDns({ apiToken: "t", apiBase: API, fetchImpl });
    expect(await dns.deleteRecord({ name: "post.example.com", type: "A" })).toEqual({ deleted: 2 });
    expect(deletes(calls)).toEqual(["a-1", "a-2"]);
  });
});

describe("CloudflareDns.zoneName — the zone that holds a name, as the label walk finds it", () => {
  it("answers the zone a name lies in, below the zone as well as at it, and refuses a name no zone holds", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      calls.push(`${url.pathname}${url.search}`);
      const name = url.searchParams.get("name");
      const result = name === "simetrix.ch" ? [{ id: "z1", name: "simetrix.ch" }] : [];
      return new Response(JSON.stringify({ success: true, result }), { status: 200 });
    }) as unknown as typeof fetch;
    const dns = new CloudflareDns({ apiToken: "t", apiBase: API, fetchImpl });
    expect(await dns.zoneName({ name: "veloluck.show.simetrix.ch" })).toBe("simetrix.ch");
    expect(await dns.zoneName({ name: "simetrix.ch" })).toBe("simetrix.ch");
    // The walk asks the name, then each suffix, and keeps the answer for the name it asked for.
    expect(calls.slice(0, 3)).toEqual(["/client/v4/zones?name=veloluck.show.simetrix.ch&per_page=1", "/client/v4/zones?name=show.simetrix.ch&per_page=1", "/client/v4/zones?name=simetrix.ch&per_page=1"]);
    await expect(dns.zoneName({ name: "example.org" })).rejects.toThrow(/no Cloudflare zone found/);
  });

  it("PLANTED DEFECT: writes a record back behind the proxy and with the TTL it stood with, and its own records DNS-only and automatic", async () => {
    const { fetchImpl, posted } = scripted([]);
    const dns = new CloudflareDns({ apiToken: "t", apiBase: API, fetchImpl });
    await dns.createRecord({ name: "shop.example.com", type: "A", content: "203.0.113.7", proxied: true, ttl: 300 });
    await dns.createRecord({ name: "api.example.com", type: "CNAME", content: "zone.example.net" });
    expect(posted).toEqual([
      { type: "A", name: "shop.example.com", content: "203.0.113.7", ttl: 300, proxied: true },
      { type: "CNAME", name: "api.example.com", content: "zone.example.net", ttl: 1, proxied: false },
    ]);
  });

  it("reads each record as it stands, its proxy flag and TTL with it", async () => {
    const { fetchImpl } = scripted([{ id: "r1", content: "203.0.113.7", proxied: true, ttl: 300 }, { id: "r2", content: "203.0.113.8" }]);
    const dns = new CloudflareDns({ apiToken: "t", apiBase: API, fetchImpl });
    expect(await dns.listStandingRecords({ name: "shop.example.com", type: "A" })).toEqual([
      { content: "203.0.113.7", proxied: true, ttl: 300 },
      { content: "203.0.113.8", proxied: false, ttl: 1 },
    ]);
  });
});
