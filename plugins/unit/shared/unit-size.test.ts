import { describe, it, expect } from "vitest";
import { UNIT_SIZE, UNIT_SIZE_LETTER, TENANT_SIZE, UNIT_SIZE_SEED, MONGODB_MEMBERS, ONBOARDING_VOLUME, composeQuota, seedQuota, seededSizes, partSizing, sizeOf, DEFAULT_UNIT_SIZE } from "./unit-size.ts";

// A unit has a size, each data part of its own may have its own, and what they cost depends on what the unit brings. These
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
    // 400m + 50m, 1Gi + 512Mi — a database with no size of its own runs at the unit's.
    expect(quota.requestsCpu).toBe("450m");
    expect(quota.requestsMemory).toBe("1536Mi");
    expect(quota.pods).toBe(UNIT_SIZE_SEED.base.small.pods + UNIT_SIZE_SEED.postgresql.small.pods);
  });

  it("counts a MongoDB of its own PER MEMBER: one for a standalone, three for a replica set", () => {
    const standalone = composeQuota(UNIT_SIZE_SEED, "medium", { postgresql: false, mongodb: "standalone" });
    const replicaset = composeQuota(UNIT_SIZE_SEED, "medium", { postgresql: false, mongodb: "replicaset" });

    expect(standalone.parts.find((p) => p.component === "mongodb")?.members).toBe(1);
    expect(replicaset.parts.find((p) => p.component === "mongodb")?.members).toBe(3);
    // 800m + 250m vs 800m + 3x250m, each + the one exporter's 15m. The replica set is the
    // transaction-capable shape and it is priced as the three members it actually runs.
    expect(standalone.quota.requestsCpu).toBe("1065m");
    expect(replicaset.quota.requestsCpu).toBe("1565m");
    expect(replicaset.quota.persistentVolumeClaims).toBe(UNIT_SIZE_SEED.base.medium.persistentVolumeClaims + 3);
  });

  it("adds ONE metrics exporter per MongoDB of its own, never per member, and none on the shared set", () => {
    const exporter = { requestsCpu: "15m", requestsMemory: "48Mi", limitsCpu: "100m", limitsMemory: "128Mi", pods: 1, persistentVolumeClaims: 0 };
    for (const mongodb of ["standalone", "replicaset"] as const) {
      const { quota, parts } = composeQuota(UNIT_SIZE_SEED, "small", { postgresql: false, mongodb });
      const n = MONGODB_MEMBERS[mongodb];
      expect(parts.filter((p) => p.component === "mongodb-exporter")).toEqual([{ component: "mongodb-exporter", members: 1, each: exporter }]);
      const base = UNIT_SIZE_SEED.base.small, member = UNIT_SIZE_SEED.mongodb.small;
      expect(quota.pods).toBe(base.pods + n * member.pods + 1);
      expect(quota.persistentVolumeClaims).toBe(base.persistentVolumeClaims + n * member.persistentVolumeClaims);
    }
    // small: base 400m/1Gi requests (1500m/2Gi limits), a member 100m/512Mi (1/2Gi), the exporter 15m/48Mi (100m/128Mi).
    expect(composeQuota(UNIT_SIZE_SEED, "small", { postgresql: false, mongodb: "standalone" }).quota).toMatchObject({ requestsCpu: "515m", requestsMemory: "1584Mi", limitsCpu: "2600m", limitsMemory: "4224Mi" });
    expect(composeQuota(UNIT_SIZE_SEED, "small", { postgresql: false, mongodb: "replicaset" }).quota).toMatchObject({ requestsCpu: "715m", requestsMemory: "2608Mi" });
    expect(composeQuota(UNIT_SIZE_SEED, "small", { postgresql: true, mongodb: "shared" }).parts.map((p) => p.component)).toEqual(["base", "postgresql"]);
  });

  it("adds the Redis row once for a Redis of its own, at its own size, and nothing for the shared one", () => {
    const own = composeQuota(UNIT_SIZE_SEED, "small", { postgresql: false, mongodb: "shared", redis: "standalone" }, { redis: "large" });
    expect(own.parts.map((p) => [p.component, p.members])).toEqual([["base", 1], ["redis", 1]]);
    expect(own.parts.find((p) => p.component === "redis")?.each).toEqual(UNIT_SIZE_SEED.redis.large);
    expect(own.quota).toMatchObject({ requestsCpu: "600m", requestsMemory: "2Gi", limitsCpu: "3500m", limitsMemory: "6Gi", pods: 10, persistentVolumeClaims: 2 });
    for (const redis of ["shared", undefined] as const) {
      expect(composeQuota(UNIT_SIZE_SEED, "small", { postgresql: false, mongodb: "shared", ...(redis ? { redis } : {}) }).parts.map((p) => p.component)).toEqual(["base"]);
    }
  });

  it("sums each data part at its OWN size when one is given, the application at the unit's", () => {
    const { quota, parts } = composeQuota(UNIT_SIZE_SEED, "small", { postgresql: true, mongodb: "standalone" }, { postgresql: "large" });
    expect(parts.map((p) => p.each)).toEqual([UNIT_SIZE_SEED.base.small, UNIT_SIZE_SEED.postgresql.large, UNIT_SIZE_SEED.mongodb.small, expect.anything()]);
    // 400m + 300m + 100m + the exporter's 15m.
    expect(quota.requestsCpu).toBe("815m");
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

  it("seeds the member rows from the measured use and the owner's limits plus one cert-manager solver, 9 pods and 1 claim each", () => {
    const row = (requestsCpu: string, requestsMemory: string, limitsCpu: string, limitsMemory: string) =>
      ({ requestsCpu, requestsMemory, limitsCpu, limitsMemory, pods: 9, persistentVolumeClaims: 1 });
    expect(UNIT_SIZE_SEED.member).toEqual({
      xsmall: row("110m", "640Mi", "2100m", "2112Mi"),
      small: row("210m", "1216Mi", "4100m", "4160Mi"),
      medium: row("410m", "2368Mi", "6100m", "6208Mi"),
      large: row("810m", "4672Mi", "8100m", "10304Mi"),
      xlarge: row("1210m", "6976Mi", "8100m", "15424Mi"),
      xxlarge: row("1610m", "9280Mi", "8100m", "20544Mi"),
    });
  });

  it("seeds the redis rows at the owner's figures: the exporter included, one server pod and one exporter pod, one claim", () => {
    const row = (requestsCpu: string, requestsMemory: string, limitsCpu: string, limitsMemory: string) => ({ requestsCpu, requestsMemory, limitsCpu, limitsMemory, pods: 2, persistentVolumeClaims: 1 });
    expect(UNIT_SIZE_SEED.redis).toEqual({
      xsmall: row("25m", "128Mi", "250m", "512Mi"),
      small: row("50m", "256Mi", "500m", "1Gi"),
      medium: row("100m", "512Mi", "1", "2Gi"),
      large: row("200m", "1Gi", "2", "4Gi"),
      xlarge: row("300m", "2Gi", "2", "8Gi"),
      xxlarge: row("400m", "3Gi", "2", "12Gi"),
    });
  });

  it("seeds a consumer's components at all six sizes, the new ones at the decided figures", () => {
    for (const c of ["base", "postgresql", "mongodb", "redis"] as const) expect(seededSizes(c)).toEqual([...UNIT_SIZE]);
    const figures = (c: "base" | "postgresql" | "mongodb") => ["xsmall", "xlarge", "xxlarge"].map((s) => UNIT_SIZE_SEED[c][s as "xsmall"]);
    expect(figures("base")).toEqual([
      { requestsCpu: "200m", requestsMemory: "512Mi", limitsCpu: "750m", limitsMemory: "1Gi", pods: 8, persistentVolumeClaims: 1 },
      { requestsCpu: "2400m", requestsMemory: "6Gi", limitsCpu: "9", limitsMemory: "12Gi", pods: 48, persistentVolumeClaims: 6 },
      { requestsCpu: "3200m", requestsMemory: "8Gi", limitsCpu: "12", limitsMemory: "16Gi", pods: 64, persistentVolumeClaims: 8 },
    ]);
    expect(figures("postgresql").map((q) => [q.requestsCpu, q.requestsMemory, q.limitsCpu, q.limitsMemory])).toEqual([
      ["25m", "256Mi", "400m", "512Mi"], ["450m", "3584Mi", "3200m", "6656Mi"], ["600m", "4608Mi", "4200m", "8704Mi"],
    ]);
    expect(figures("mongodb").map((q) => [q.requestsCpu, q.requestsMemory, q.limitsCpu, q.limitsMemory])).toEqual([
      ["50m", "256Mi", "500m", "1Gi"], ["750m", "3Gi", "6", "12Gi"], ["1", "4Gi", "8", "16Gi"],
    ]);
  });

  it("gives each data part the volume of its size, the three old ones the presets' own", () => {
    expect(UNIT_SIZE.map((s) => ONBOARDING_VOLUME.postgresql[s])).toEqual(["2Gi", "5Gi", "20Gi", "50Gi", "100Gi", "200Gi"]);
    expect(UNIT_SIZE.map((s) => ONBOARDING_VOLUME.mongodb[s])).toEqual(["5Gi", "10Gi", "40Gi", "100Gi", "200Gi", "400Gi"]);
    // About four times the size's maxmemory: room for the append-only file, its rewrite and one dump.
    expect(UNIT_SIZE.map((s) => ONBOARDING_VOLUME.redis[s])).toEqual(["1Gi", "2Gi", "4Gi", "8Gi", "16Gi", "24Gi"]);
  });
});

describe("partSizing", () => {
  it("sizes and pins only the data parts a unit runs", () => {
    expect(partSizing("xlarge", { postgresql: true, mongodb: "replicaset" })).toEqual({ sizes: { postgresql: "xlarge", mongodb: "xlarge" }, volumes: { postgresql: "100Gi", mongodb: "200Gi" } });
    expect(partSizing("medium", { postgresql: false, mongodb: "standalone" })).toEqual({ sizes: { mongodb: "medium" }, volumes: { mongodb: "40Gi" } });
    expect(partSizing("small", { postgresql: false, mongodb: "shared", redis: "standalone" })).toEqual({ sizes: { redis: "small" }, volumes: { redis: "2Gi" } });
  });

  it("runs a Redis of its own at its own size, the shared one at none", () => {
    expect(sizeOf("redis", "small", { redis: "xlarge" })).toBe("xlarge");
    expect(sizeOf("redis", "small", {})).toBe("small");
  });

  it("writes neither key for a unit with no data part of its own: the appset's dig fails on null or a list", () => {
    expect(partSizing("small", { postgresql: false, mongodb: "shared" })).toEqual({});
    expect(partSizing("small", { postgresql: false, mongodb: "shared", redis: "shared" })).toEqual({});
  });
});

describe("composeQuota for a tenant member", () => {
  it("is the member row alone, never base", () => {
    const { quota, parts } = composeQuota(UNIT_SIZE_SEED, "xsmall", { app: "member", postgresql: false, mongodb: "shared" });
    expect(parts.map((p) => p.component)).toEqual(["member"]);
    expect(quota).toEqual(UNIT_SIZE_SEED.member.xsmall);
  });

  it("refuses a size the table holds no row for, naming the component and the size", () => {
    const table = { ...UNIT_SIZE_SEED, base: { small: UNIT_SIZE_SEED.base.small } };
    expect(() => composeQuota(table, "xsmall", { postgresql: false, mongodb: "shared" })).toThrow(/"base".*"xsmall"|"xsmall".*"base"/);
  });
});
