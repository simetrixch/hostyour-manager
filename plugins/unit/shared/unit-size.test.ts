import { describe, it, expect } from "vitest";
import { UNIT_SIZE, UNIT_SIZE_LETTER, TENANT_SIZE, UNIT_SIZE_SEED, MONGODB_MEMBERS, composeQuota, seedQuota, seededSizes, DEFAULT_UNIT_SIZE } from "./unit-size.ts";

// A unit has ONE size, and what that size costs depends on what the unit brings with it. These
// assertions hold the two halves of that sentence apart: the size never changes with the composition,
// and the FIGURES always do.

describe("composeQuota", () => {
  it("is the base row alone for a unit that brings no database of its own", () => {
    const { quota, parts } = composeQuota(UNIT_SIZE_SEED, "medium", { postgresql: false, mongodb: "shared" });
    expect(parts.map((p) => p.component)).toEqual(["base"]);
    expect(quota).toEqual(UNIT_SIZE_SEED.base.medium);
  });

  it("adds the PostgreSQL row once, at the unit's OWN size", () => {
    const { quota, parts } = composeQuota(UNIT_SIZE_SEED, "small", { postgresql: true, mongodb: "shared" });
    expect(parts.map((p) => `${p.component}x${p.members}`)).toEqual(["basex1", "postgresqlx1"]);
    // 400m + 50m, 1Gi + 512Mi — the database is sized by the unit's word, never by a second one.
    expect(quota.requestsCpu).toBe("450m");
    expect(quota.requestsMemory).toBe("1536Mi");
    expect(quota.pods).toBe(UNIT_SIZE_SEED.base.small.pods + UNIT_SIZE_SEED.postgresql.small.pods);
  });

  it("counts a MongoDB of its own PER MEMBER: one for a standalone, three for a replica set", () => {
    const standalone = composeQuota(UNIT_SIZE_SEED, "medium", { postgresql: false, mongodb: "standalone" });
    const replicaset = composeQuota(UNIT_SIZE_SEED, "medium", { postgresql: false, mongodb: "replicaset" });

    expect(standalone.parts.find((p) => p.component === "mongodb")?.members).toBe(1);
    expect(replicaset.parts.find((p) => p.component === "mongodb")?.members).toBe(3);
    // 800m + 250m vs 800m + 3x250m. The replica set is the transaction-capable shape and it is
    // priced as the three members it actually runs.
    expect(standalone.quota.requestsCpu).toBe("1050m");
    expect(replicaset.quota.requestsCpu).toBe("1550m");
    expect(replicaset.quota.persistentVolumeClaims).toBe(UNIT_SIZE_SEED.base.medium.persistentVolumeClaims + 3);
  });

  it("keeps the WORD and the FIGURES apart: the same size costs more when the unit brings more", () => {
    const bare = seedQuota("large");
    const loaded = seedQuota("large", { postgresql: true, mongodb: "replicaset" });
    expect(bare).not.toEqual(loaded);
    // Every part is added, none replaced — a loaded unit is never quoted LESS than a bare one.
    expect(loaded.pods).toBeGreaterThan(bare.pods);
  });

  it("takes its figures from the TABLE it is handed, not from the seed constant", () => {
    // The whole reason the resolver reads the database: an installation that raised its own `small`
    // must have that raise reach what it composes.
    const raised = { ...UNIT_SIZE_SEED, base: { ...UNIT_SIZE_SEED.base, small: { ...UNIT_SIZE_SEED.base.small, requestsCpu: "900m" } } };
    expect(composeQuota(raised, "small", { postgresql: false, mongodb: "shared" }).quota.requestsCpu).toBe("900m");
  });
});

describe("the vocabulary", () => {
  it("says how many members each MongoDB mode runs — shared is none of the unit's own", () => {
    expect(MONGODB_MEMBERS).toEqual({ shared: 0, standalone: 1, replicaset: 3 });
  });

  it("defaults an unnamed size to the frugal one", () => {
    expect(DEFAULT_UNIT_SIZE).toBe("small");
  });

  it("has six sizes, smallest first, each with its letter, and keeps the three stored ids", () => {
    expect(UNIT_SIZE).toEqual(["xsmall", "small", "medium", "large", "xlarge", "xxlarge"]);
    expect(UNIT_SIZE.map((s) => UNIT_SIZE_LETTER[s])).toEqual(["XS", "S", "M", "L", "XL", "XXL"]);
  });

  it("offers a tenant XS to L: XL and XXL are seeded but wait for engines and webs that run several replicas", () => {
    expect(TENANT_SIZE).toEqual(["xsmall", "small", "medium", "large"]);
    expect(seededSizes("member")).toEqual([...UNIT_SIZE]);
  });

  it("seeds the member rows from the measured use and the owner's limits, 8 pods and 1 claim each", () => {
    const row = (requestsCpu: string, requestsMemory: string, limitsCpu: string, limitsMemory: string) =>
      ({ requestsCpu, requestsMemory, limitsCpu, limitsMemory, pods: 8, persistentVolumeClaims: 1 });
    expect(UNIT_SIZE_SEED.member).toEqual({
      xsmall: row("100m", "576Mi", "2", "2Gi"),
      small: row("200m", "1152Mi", "4", "4Gi"),
      medium: row("400m", "2304Mi", "6", "6Gi"),
      large: row("800m", "4608Mi", "8", "10Gi"),
      xlarge: row("1200m", "6912Mi", "8", "15Gi"),
      xxlarge: row("1600m", "9216Mi", "8", "20Gi"),
    });
  });

  it("PLANTED INNOCENT: a consumer's components keep their three sizes, no row invented for the new ids", () => {
    for (const c of ["base", "postgresql", "mongodb"] as const) expect(seededSizes(c)).toEqual(["small", "medium", "large"]);
  });
});

describe("composeQuota for a tenant member", () => {
  it("is the member row alone, never base", () => {
    const { quota, parts } = composeQuota(UNIT_SIZE_SEED, "xsmall", { app: "member", postgresql: false, mongodb: "shared" });
    expect(parts.map((p) => p.component)).toEqual(["member"]);
    expect(quota).toEqual(UNIT_SIZE_SEED.member.xsmall);
  });

  it("refuses a size the table holds no row for, naming the component and the size", () => {
    expect(() => composeQuota(UNIT_SIZE_SEED, "xsmall", { postgresql: false, mongodb: "shared" })).toThrow(/"base".*"xsmall"|"xsmall".*"base"/);
  });
});
