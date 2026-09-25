import { describe, expect, it } from "vitest";
import { DohPublicDns, reverseName, txtData, type DohResolver } from "./public-dns.ts";

const TWO: readonly DohResolver[] = [
  { name: "first", url: "https://first.invalid/dns-query" },
  { name: "second", url: "https://second.invalid/resolve" },
];

/** A fetch scripted per service: a function of the URL that answers a Response, or throws as a
 *  network error does. Every call is recorded, so a test reads what was asked and where. */
function scripted(script: Record<string, (url: URL) => Response | Error>) {
  const calls: { url: URL; accept: string | undefined }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, accept: new Headers(init?.headers).get("accept") ?? undefined });
    const answer = script[url.host]?.(url) ?? new Error(`unscripted host ${url.host}`);
    if (answer instanceof Error) throw answer;
    return answer;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const dns = (fetchImpl: typeof fetch) => new DohPublicDns({ resolvers: TWO, fetchImpl });

describe("txtData — presentation form to the record's one string", () => {
  it("joins quoted chunks, unescapes, and leaves a bare string as it is", () => {
    expect(txtData('"v=DKIM1; k=rsa; " "p=MIIB"')).toBe("v=DKIM1; k=rsa; p=MIIB");
    expect(txtData('"MS=ms62596853"')).toBe("MS=ms62596853");
    expect(txtData('"a\\"b" "c"')).toBe('a"bc');
    expect(txtData("v=spf1 ip4:203.0.113.7 -all")).toBe("v=spf1 ip4:203.0.113.7 -all");
  });
});

describe("DohPublicDns — the JSON DNS API over 443", () => {
  it("asks TXT with the JSON accept header and answers only the records of the asked type, joined", async () => {
    const { fetchImpl, calls } = scripted({
      "first.invalid": () => json({ Status: 0, Answer: [
        { name: "mail.example.com", type: 5, data: "example.com." },
        { name: "example.com", type: 16, data: '"v=spf1 " "ip4:203.0.113.7 -all"' },
        { name: "example.com", type: 16, data: "MS=ms1" },
      ] }),
    });
    await expect(dns(fetchImpl).txt("mail.example.com")).resolves.toEqual(["v=spf1 ip4:203.0.113.7 -all", "MS=ms1"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url.searchParams.get("name")).toBe("mail.example.com");
    expect(calls[0]?.url.searchParams.get("type")).toBe("16");
    expect(calls[0]?.accept).toBe("application/dns-json");
  });

  it("A answers the addresses; PTR asks the in-addr.arpa name and drops the trailing dot", async () => {
    const { fetchImpl, calls } = scripted({
      "first.invalid": (url) => (url.searchParams.get("type") === "1"
        ? json({ Status: 0, Answer: [{ name: "example.com", type: 1, data: "203.0.113.7" }] })
        : json({ Status: 0, Answer: [{ name: "7.113.0.203.in-addr.arpa", type: 12, data: "example.com." }] })),
    });
    await expect(dns(fetchImpl).a("example.com")).resolves.toEqual(["203.0.113.7"]);
    await expect(dns(fetchImpl).ptr("203.0.113.7")).resolves.toEqual(["example.com"]);
    expect(reverseName("203.0.113.7")).toBe("7.113.0.203.in-addr.arpa");
    expect(calls[1]?.url.searchParams.get("name")).toBe("7.113.0.203.in-addr.arpa");
    expect(calls[1]?.url.searchParams.get("type")).toBe("12");
  });

  it("NXDOMAIN, SERVFAIL and an empty answer are the empty list; a refusal throws", async () => {
    const rcode = (n: number) => scripted({ "first.invalid": () => json({ Status: n }) }).fetchImpl;
    await expect(dns(rcode(3)).txt("nothing.example.com")).resolves.toEqual([]);
    await expect(dns(rcode(2)).txt("broken.example.com")).resolves.toEqual([]);
    await expect(dns(rcode(0)).a("empty.example.com")).resolves.toEqual([]);
    await expect(dns(rcode(5)).txt("refused.example.com")).rejects.toThrow(/first refused the query for refused.example.com \(rcode 5\)/);
  });

  it("asks the second service when the first cannot be reached or answers no 200, and throws naming both when neither answers", async () => {
    const unreachable = scripted({
      "first.invalid": () => new Error("fetch failed"),
      "second.invalid": () => json({ Status: 0, Answer: [{ name: "example.com", type: 16, data: '"v=DMARC1; p=none"' }] }),
    });
    await expect(dns(unreachable.fetchImpl).txt("example.com")).resolves.toEqual(["v=DMARC1; p=none"]);
    expect(unreachable.calls.map((c) => c.url.host)).toEqual(["first.invalid", "second.invalid"]);

    const gateway = scripted({
      "first.invalid": () => json({ error: "bad gateway" }, 502),
      "second.invalid": () => json({ Status: 0, Answer: [{ name: "example.com", type: 1, data: "203.0.113.7" }] }),
    });
    await expect(dns(gateway.fetchImpl).a("example.com")).resolves.toEqual(["203.0.113.7"]);

    const dark = scripted({ "first.invalid": () => new Error("fetch failed"), "second.invalid": () => json({}, 503) });
    await expect(dns(dark.fetchImpl).txt("example.com")).rejects.toThrow(/no public resolver could be reached for example.com: first: fetch failed; second: HTTP 503/);
  });
});
