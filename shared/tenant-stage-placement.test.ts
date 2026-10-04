import { describe, expect, it } from "vitest";
import { STAGE } from "./enums.ts";
import { tenantStagesNeedSeparateMachines } from "./tenant-stage-placement.ts";

describe("tenant stage machine separation", () => {
  it("requires TEST/PROD separation in either direction without inventing DEV restrictions", () => {
    expect(tenantStagesNeedSeparateMachines("test", "prod")).toBe(true);
    expect(tenantStagesNeedSeparateMachines("prod", "test")).toBe(true);
    for (const stage of STAGE) {
      expect(tenantStagesNeedSeparateMachines("dev", stage)).toBe(false);
      expect(tenantStagesNeedSeparateMachines(stage, "dev")).toBe(false);
    }
  });
});
