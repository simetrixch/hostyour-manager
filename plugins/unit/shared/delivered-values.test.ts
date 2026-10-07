import { describe, expect, it } from "vitest";
import { deliveredValues } from "./delivered-values.ts";

const base = { hostLabel: "post", stage: "test" as const, unitApex: "example.com", apiHost: "100.64.0.7", databases: ["digita_post"], keyPatterns: ["post:*"], channelPatterns: ["post.*"] };

describe("deliveredValues — what the consumers ApplicationSet hands a unit's chart", () => {
  it("delivers the host, the zone, the databases and the redis grant, running and not quiesced", () => {
    expect(deliveredValues(base)).toEqual({
      suspended: false,
      quiesced: false,
      unitHost: "post.test.example.com",
      global: { stageApex: "test.example.com" },
      mongodb: { databases: ["digita_post"] },
      redis: { keyPatterns: ["post:*"], channelPatterns: ["post.*"] },
    });
  });

  it("delivers an SMTP entry only where the manifest declares one, at the cluster's API host", () => {
    expect(deliveredValues({ ...base, smtpEntry: { service: "post-mta", port: 2525 } }).smtpEntry).toEqual({ service: "post-mta", port: 2525, address: "100.64.0.7" });
    expect(deliveredValues(base)).not.toHaveProperty("smtpEntry");
  });

  it("delivers null for an empty list, as the ApplicationSet's YAML does, so a chart meets the value ArgoCD hands it", () => {
    expect(deliveredValues({ ...base, databases: [], keyPatterns: [], channelPatterns: [] })).toMatchObject({ mongodb: { databases: null }, redis: { keyPatterns: null, channelPatterns: null } });
  });
});
