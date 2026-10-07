import { describe, it, expect } from "vitest";
import { TenantSpecSchema } from "./consumer.ts";

describe("TenantSpecSchema senderDomainIssuers (where a stage's issuer is bound, as the Manager)", () => {
  const spec = (url: string): unknown => ({
    members: [{ name: "auth", chart: "charts/example-auth", identityProvider: true }],
    perApp: { engine: { chart: "charts/example-engine" }, front: { chart: "charts/example-ui" } },
    senderDomainIssuers: { url, unit: "digita-post" },
  });

  it("takes a route whose host ends in the stage apex, and refuses any other host, so a stage's key reaches only its own apex", () => {
    expect(TenantSpecSchema.safeParse(spec("https://post.{stageApex}/api/internal/sender-domains/{domain}/issuers")).success).toBe(true);
    for (const url of [
      "https://post.example.com/api/internal/sender-domains/{domain}/issuers",
      "https://evil.example/{stageApex}/{domain}",
      "https://{stageApex}.evil.example/{domain}",
      "http://post.{stageApex}/{domain}",
      "https://post.{stageApex}/issuers",
    ]) expect(TenantSpecSchema.safeParse(spec(url)).success, url).toBe(false);
  });
});

describe("TenantSpecSchema senderDomainDkim", () => {
  const dkimSpec = (recordUrl: string, checkUrl: string, unit = "digita-post"): unknown => ({
    members: [{ name: "auth", chart: "charts/example-auth", identityProvider: true }],
    perApp: { engine: { chart: "charts/example-engine" }, front: { chart: "charts/example-ui" } },
    senderDomainDkim: { recordUrl, checkUrl, unit },
  });

  it("validates recordUrl and checkUrl template host ending in {stageApex} and path containing {domain}", () => {
    const valid = "https://post.{stageApex}/api/internal/sender-domains/{domain}/dkim-record";
    const validCheck = "https://post.{stageApex}/api/internal/sender-domains/{domain}/check";
    expect(TenantSpecSchema.safeParse(dkimSpec(valid, validCheck)).success).toBe(true);
    expect(TenantSpecSchema.safeParse(dkimSpec("https://evil.com/{domain}", validCheck)).success).toBe(false);
    expect(TenantSpecSchema.safeParse(dkimSpec(valid, "https://evil.com/{domain}")).success).toBe(false);
  });
});
