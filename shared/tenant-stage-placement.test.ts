import { describe, expect, it } from "vitest";
import { STAGE, TENANT_STATUS, type Stage } from "./enums.ts";
import { findStagePlacementConflict, tenantStagesNeedSeparateMachines } from "./tenant-stage-placement.ts";

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

describe("finding the stage that forbids a machine", () => {
  const standing = (stage: Stage, clusterId: string, status?: string) => ({ stage, clusterId, ...(status ? { status } : {}) });

  it("PLANTED DEFECT: finds PROD on the machine TEST is placed on, and TEST on the machine PROD is placed on", () => {
    const prod = standing("prod", "cls_1", "active");
    expect(findStagePlacementConflict([standing("dev", "cls_1", "active"), prod], "test", "cls_1")).toBe(prod);
    const test = standing("test", "cls_1", "provisioning");
    expect(findStagePlacementConflict([test], "prod", "cls_1")).toBe(test);
  });

  it("PLANTED INNOCENT: finds nothing on another machine, for DEV, or for a stage beside itself", () => {
    const rows = [standing("prod", "cls_1", "active"), standing("test", "cls_2", "active")];
    expect(findStagePlacementConflict(rows, "test", "cls_3")).toBeUndefined();
    expect(findStagePlacementConflict(rows, "dev", "cls_1")).toBeUndefined();
    expect(findStagePlacementConflict(rows, "prod", "cls_1")).toBeUndefined();
    expect(findStagePlacementConflict([], "test", "cls_1")).toBeUndefined();
  });

  it("PLANTED INNOCENT: a stage that is no longer standing forbids nothing, one that has not yet a status does", () => {
    for (const status of TENANT_STATUS) {
      const settled = status === "offboarded" || status === "purged";
      expect(findStagePlacementConflict([standing("prod", "cls_1", status)], "test", "cls_1") === undefined).toBe(settled);
    }
    expect(findStagePlacementConflict([standing("prod", "cls_1")], "test", "cls_1")).toBeDefined();
  });
});
