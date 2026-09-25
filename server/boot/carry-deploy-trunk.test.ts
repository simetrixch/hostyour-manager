// The carry of the deploy trunk as boot runs it (wire.ts carryDeployTrunkLater): behind the
// listening server, never rejecting — a failure is logged with its reason and the branch stays one
// product state behind, never a wrong one.
import { describe, it, expect } from "vitest";
import { carryDeployTrunkLater } from "./wire.ts";
import type { Logger } from "../kernel/logger.ts";

function logger(errors: unknown[]): Logger {
  return { error: (...args: unknown[]) => { errors.push(args); } } as unknown as Logger;
}

describe("carryDeployTrunkLater", () => {
  it("runs the carry and resolves", async () => {
    let ran = 0;
    await carryDeployTrunkLater(async () => { ran += 1; }, logger([]))();
    expect(ran).toBe(1);
  });

  it("logs a failing carry with its reason and still resolves", async () => {
    const errors: unknown[] = [];
    await expect(carryDeployTrunkLater(async () => { throw new Error("origin refused the push"); }, logger(errors))()).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(JSON.stringify(errors[0])).toContain("origin refused the push");
  });

  it("is a no-op where the Manager writes no books", async () => {
    const errors: unknown[] = [];
    await carryDeployTrunkLater(undefined, logger(errors))();
    expect(errors).toEqual([]);
  });
});
