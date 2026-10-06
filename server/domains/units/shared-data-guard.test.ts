import { describe, it, expect } from "vitest";
import type { Stage } from "../../../shared/enums.ts";
import type { ConsumerStageRegistration } from "../../../shared/consumer.ts";
import { patternsOverlap, servedSharedDatabases, sharedDataRefusal, type SharedDataClaim } from "./shared-data-guard.ts";

// Two consumer registrations on one cluster must never be served one database on the shared MongoDB,
// nor reach one another's keys on the shared Redis: one stage would read, and act on, the other's data.

const claim = (over: Partial<SharedDataClaim> = {}): SharedDataClaim => ({ services: ["mongodb"], databases: ["digita_post"], mongodb: "shared", ...over });

/** A books branch holding `standing` registrations, each at its stage on cluster s1. */
function books(standing: { name: string; stage: Stage; claim: SharedDataClaim; cluster?: string }[]) {
  return {
    async listConsumerRegistrations(cluster: string, stage: Stage) {
      return { registrations: standing.filter((s) => s.stage === stage && (s.cluster ?? "s1") === cluster).map((s) => ({ name: s.name, entry: s.claim as unknown as ConsumerStageRegistration })) };
    },
  };
}

describe("servedSharedDatabases", () => {
  it("serves the manifest's name at prod and <name>_<stage> elsewhere, on the shared server only", () => {
    expect(servedSharedDatabases(claim(), "prod")).toEqual(["digita_post"]);
    expect(servedSharedDatabases(claim(), "test")).toEqual(["digita_post_test"]);
    expect(servedSharedDatabases(claim({ mongodb: "standalone" }), "test")).toEqual([]);
    expect(servedSharedDatabases(claim({ services: ["postgresql"] }), "test")).toEqual([]);
  });
});

describe("sharedDataRefusal", () => {
  it("PLANTED: refuses a registration served a database another registration on the cluster is served", async () => {
    const refusal = await sharedDataRefusal(books([{ name: "shop", stage: "prod", claim: claim({ databases: ["digita_post_test"] }) }]), "s1", "test", "digita-post", claim());
    expect(refusal).toMatch(/digita-post at test would be served the database digita_post_test on s1's shared MongoDB, which shop at prod is served already/);
  });

  it("PLANTED: refuses overlapping key patterns on the shared Redis", async () => {
    const redis = (keyPatterns: string[]): SharedDataClaim => ({ services: ["redis"], databases: [], mongodb: "shared", redis: "shared", keyPatterns });
    expect(await sharedDataRefusal(books([{ name: "shop", stage: "prod", claim: redis(["shop:*"]) }]), "s1", "test", "shop", redis(["shop:*"])))
      .toMatch(/shop at test would be granted the Redis keys shop:\* on s1's shared Redis, which meet the keys shop:\* of shop at prod/);
  });

  it("admits the same consumer's TEST beside its PROD: their served names differ by the stage", async () => {
    expect(await sharedDataRefusal(books([{ name: "digita-post", stage: "prod", claim: claim() }]), "s1", "test", "digita-post", claim())).toBeNull();
  });

  it("admits an own server, the same names on another cluster, and the registration it replaces", async () => {
    const standing = [{ name: "shop", stage: "test" as const, claim: claim() }];
    expect(await sharedDataRefusal(books(standing), "s1", "test", "digita-post", claim({ mongodb: "standalone" }))).toBeNull();
    expect(await sharedDataRefusal(books([{ ...standing[0]!, cluster: "s2" }]), "s1", "test", "digita-post", claim())).toBeNull();
    expect(await sharedDataRefusal(books([{ name: "digita-post", stage: "test", claim: claim() }]), "s1", "test", "digita-post", claim())).toBeNull();
  });
});

describe("patternsOverlap", () => {
  it("meets where one literal prefix runs into the other, and not where they part", () => {
    expect(patternsOverlap("shop:*", "shop:cart:*")).toBe(true);
    expect(patternsOverlap("shop:*", "blog:*")).toBe(false);
    expect(patternsOverlap("shop:test:*", "shop:prod:*")).toBe(false);
  });
});
