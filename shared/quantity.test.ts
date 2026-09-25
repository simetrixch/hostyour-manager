import { describe, it, expect } from "vitest";
import { addCpu, addMemory, timesCpu, timesMemory } from "./quantity.ts";

// The arithmetic a unit's quota is summed with. What matters here is not that addition works but that
// the RESULT is a quantity Kubernetes reads as the same amount and an operator recognises in the file.

describe("addCpu", () => {
  it("sums millicores and carries into whole cores", () => {
    expect(addCpu("400m", "50m")).toBe("450m");
    expect(addCpu("500m", "500m")).toBe("1");
    expect(addCpu("1", "500m")).toBe("1500m");
    expect(addCpu("2", "2")).toBe("4");
  });

  it("is the identity on one value, and zero-safe on none", () => {
    expect(addCpu("750m")).toBe("750m");
    expect(addCpu()).toBe("0");
  });

  it("refuses a value it cannot read rather than treating it as zero", () => {
    // Silently reading "1Gi" as 0 CPU would produce a quota smaller than every part of it.
    expect(() => addCpu("1Gi")).toThrow(/not a cpu quantity/);
    expect(() => addCpu("")).toThrow(/not a cpu quantity/);
  });
});

describe("addMemory", () => {
  it("sums binary suffixes and reports the largest that divides the sum exactly", () => {
    expect(addMemory("1Gi", "1Gi")).toBe("2Gi");
    expect(addMemory("512Mi", "512Mi")).toBe("1Gi");
    // Does not divide into Gi — stays exact one suffix down rather than rounding.
    expect(addMemory("1Gi", "512Mi")).toBe("1536Mi");
  });

  it("keeps the binary and decimal families apart", () => {
    // 1Gi is 1073741824 bytes and 1G is 1000000000 — treating them alike loses 7% of a quota. No
    // binary suffix divides 10^9, so the sum comes back in plain bytes rather than being rounded
    // into one: exactness wins over prettiness where a ceiling is concerned.
    expect(addMemory("1G", "0")).toBe("1000000000");
    expect(addMemory("1Gi", "0")).toBe("1Gi");
  });

  it("refuses a CPU-shaped value", () => {
    expect(() => addMemory("500m")).toThrow(/not a memory quantity/);
  });
});

describe("times", () => {
  it("multiplies a member's figure by its member count", () => {
    // A three-member replica set is one member's figure times three — the case this exists for.
    expect(timesCpu("250m", 3)).toBe("750m");
    expect(timesMemory("512Mi", 3)).toBe("1536Mi");
    expect(timesMemory("1Gi", 3)).toBe("3Gi");
  });

  it("times zero is zero — a unit on the shared MongoDB adds nothing", () => {
    expect(timesCpu("250m", 0)).toBe("0");
    expect(timesMemory("512Mi", 0)).toBe("0");
  });
});
